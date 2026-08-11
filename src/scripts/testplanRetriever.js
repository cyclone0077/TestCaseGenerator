/* ==========================================================================
   testplanRetriever.js — query-time RAG over the test_plans collection.
   Real hybrid search: this collection now has both a BM25 index
   (bm25_search_test_plans) and a vector index (vector_index_test_plans),
   combined via Reciprocal Rank Fusion.

   LangChain version: MongoBM25Retriever (below) is a CUSTOM retriever
   wrapping the Atlas $search index - the built-in BM25Retriever is
   in-memory and would ignore this real index entirely.
   MongoDBAtlasVectorSearch.asRetriever() replaces the hand-rolled
   $vectorSearch aggregation; EnsembleRetriever (from @langchain/classic)
   fuses both via Reciprocal Rank Fusion. A PromptTemplate + LCEL chain
   replaces the hand-built prompt string + fetch().
   expandDominantPages() stays custom - there's no standard LangChain
   primitive for "if the top-K over-samples one page, fetch that page's full
   chunk set instead" - custom logic composes alongside the LangChain pieces
   rather than needing to be replaced by them.
   Reused by server.js's /api/knowledge/query.
   ========================================================================== */

const { MongoClient } = require("mongodb");
const { MistralAIEmbeddings } = require("@langchain/mistralai");
const { MongoDBAtlasVectorSearch } = require("@langchain/mongodb");
const { EnsembleRetriever } = require("@langchain/classic/retrievers/ensemble");
const { BaseRetriever } = require("@langchain/core/retrievers");
const { ChatPromptTemplate, MessagesPlaceholder } = require("@langchain/core/prompts");
const { Document } = require("@langchain/core/documents");
const { getSessionHistory, wrapWithHistoryAwareness } = require("./knowledgeSessionHistory");
const { createChatModel } = require("./chatModelProvider");

// Embeddings stay hardcoded to Mistral regardless of CHAT_MODEL_PROVIDER -
// see chatModelProvider.js for why (the stored corpus was embedded with
// Mistral's model; queries have to match it, not whatever answers questions).
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const MISTRAL_EMBEDDING_MODEL = process.env.MISTRAL_EMBEDDING_MODEL || "mistral-embed";
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "";
const TESTPLAN_COLLECTION_NAME = process.env.TESTPLAN_COLLECTION_NAME || "test_plans";
const TESTPLAN_VECTOR_INDEX_NAME = process.env.TESTPLAN_VECTOR_INDEX_NAME || "vector_index_test_plans";
const TESTPLAN_BM25_INDEX_NAME = process.env.TESTPLAN_BM25_INDEX_NAME || "bm25_search_test_plans";

const CANDIDATE_LIMIT = 20; // per method, before fusion
// Was 6 - raised after confirming against real data that a narrow top-K can
// get fully saturated by one strongly-matching page (e.g. a Test Plan whose
// title/body closely echoes the query) before a second, equally-relevant
// page (its own PRD) ever gets a chance to appear at all. 8 is the smallest
// value that let both pages clear DOMINANT_PAGE_THRESHOLD in that real case -
// expandDominantPages() already handles multiple dominant pages correctly,
// it just needs enough raw candidates to see them.
const TOP_K = 8;             // after fusion, sent to expandDominantPages()
// Explicit cap instead of relying on Mistral's undocumented default ceiling -
// generous enough for a synthesis spanning multiple retrieved pages.
const MAX_ANSWER_TOKENS = Number(process.env.TESTPLAN_MAX_ANSWER_TOKENS) || 2000;

// Higher weight = more important when matched by keyword search. title
// weighted well above the chunk body text itself.
const FIELD_WEIGHTS = {
  title: 5.0,
  text: 1.0,
};

// Single shared client + connection, reused across requests rather than
// reconnecting per query (server.js is long-running, unlike the ingestion scripts).
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI);
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

/**
 * Custom retriever wrapping the Atlas BM25 $search index over test_plans.
 * BaseRetriever only requires _getRelevantDocuments(query) to be implemented.
 */
class MongoBM25Retriever extends BaseRetriever {
  lc_namespace = ["testplanRetriever", "mongo_bm25"];

  constructor(fields) {
    super(fields);
    this.collection = fields.collection;
    this.indexName = fields.indexName;
    this.fieldWeights = fields.fieldWeights;
    this.limit = fields.limit;
  }

  async _getRelevantDocuments(query) {
    const searchFields = Object.entries(this.fieldWeights).map(([field, weight]) => ({
      text: {
        query,
        path: field,
        fuzzy: { maxEdits: 1, prefixLength: 2 },
        score: { boost: { value: weight } },
      },
    }));

    const rows = await this.collection
      .aggregate([
        { $search: { index: this.indexName, compound: { should: searchFields, minimumShouldMatch: 1 } } },
        { $limit: this.limit },
      ])
      .toArray();

    // pageContent = row.text, matching MongoDBAtlasVectorSearch's default
    // textKey ("text") below - required for EnsembleRetriever to correctly
    // fuse the same chunk found by both retrievers instead of treating them
    // as two documents (it dedupes/scores by pageContent STRING EQUALITY).
    return rows.map((row) => new Document({
      pageContent: row.text,
      metadata: { pageId: row.pageId, title: row.title, url: row.url, docType: row.docType, chunkIndex: row.chunkIndex },
    }));
  }
}

// Retriever is built once and reused - constructing these doesn't reconnect,
// but there's no reason to rebuild them on every query.
let retrieverPromise = null;
async function getRetriever() {
  if (!retrieverPromise) {
    retrieverPromise = (async () => {
      const client = await getClient();
      const collection = client.db(DB_NAME).collection(TESTPLAN_COLLECTION_NAME);

      const bm25Retriever = new MongoBM25Retriever({
        collection,
        indexName: TESTPLAN_BM25_INDEX_NAME,
        fieldWeights: FIELD_WEIGHTS,
        limit: CANDIDATE_LIMIT,
      });

      const embeddings = new MistralAIEmbeddings({ apiKey: MISTRAL_API_KEY, model: MISTRAL_EMBEDDING_MODEL });
      // embeddingKey/textKey default to "embedding"/"text" - both already
      // match what create-testplan-embeddings.js actually stored, and "text"
      // matches the BM25 retriever's own pageContent field above.
      const vectorStore = new MongoDBAtlasVectorSearch(embeddings, {
        collection,
        indexName: TESTPLAN_VECTOR_INDEX_NAME,
      });
      const vectorRetriever = vectorStore.asRetriever(CANDIDATE_LIMIT);

      // weights default to 1/n (0.5 each) if omitted - explicit here since it
      // directly documents "equal weighting". c defaults to 60 (RRF damping).
      return new EnsembleRetriever({
        retrievers: [bm25Retriever, vectorRetriever],
        weights: [0.5, 0.5],
      });
    })();
  }
  return retrieverPromise;
}

// ChatPromptTemplate (not plain PromptTemplate) so a MessagesPlaceholder can
// carry prior turns into the FINAL answer too, not just the retrieval step -
// otherwise the model could retrieve the right documents for a follow-up
// like "what about its priority?" yet still not know what "its" refers to
// when phrasing the actual answer.
const answerPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "Answer the question using ONLY the excerpts below, which come from the QA team's " +
    "Test Plan documentation. If the excerpts don't contain enough information to answer, " +
    "say so plainly instead of guessing.\n\n" +
    "IMPORTANT: when an excerpt presents its answer as a numbered or bulleted list of " +
    "discrete items (e.g. \"1. ... 2. ... 3. ...\"), you MUST reproduce every item in that " +
    "list as its own line. Do NOT collapse or paraphrase a list into a single summary " +
    "sentence - a list means the excerpt considers each item a distinct fact worth " +
    "stating separately.\n\n" +
    "FORMATTING: write like a well-formatted assistant response, not a plain paragraph. " +
    "**Bold** the key subject, feature name, or important terms. Use markdown bullet points " +
    "(\"- \") for any list of distinct facts, impacts, or items - never bury more than one " +
    "distinct fact in a single sentence. Prefer short, scannable lines over dense prose.\n\n{excerpts}",
  ],
  new MessagesPlaceholder("chat_history"),
  ["human", "{question}"],
]);

let chatModel = null;
function getChatModel() {
  if (!chatModel) {
    // 0, not 0.2 - this is a knowledge-retrieval tool, not a creative one.
    // Confirmed against real data: the same question against identical
    // retrieved chunks produced a full 6-point itemized answer on one run
    // and a one-sentence summary on another, purely from sampling variance.
    chatModel = createChatModel({ temperature: 0, maxTokens: MAX_ANSWER_TOKENS });
  }
  return chatModel;
}

function formatExcerpts(docs) {
  return docs
    .map((doc, i) => `--- Excerpt ${i + 1} (from "${doc.metadata.title}") ---\n${doc.pageContent}`)
    .join("\n\n");
}

async function synthesizeAnswer(query, docs, chatHistory) {
  if (docs.length === 0) {
    return "No relevant Test Plan content was found for that question.";
  }

  // LCEL: pipe the prompt's output straight into the chat model - no manual
  // fetch(), no manual response-shape parsing. .invoke() runs the whole chain.
  // question stays the user's ORIGINAL wording (not any reformulated query) -
  // chat_history is what lets the model resolve "its"/"it" itself when phrasing
  // the answer, the same way a human listener would use conversational context.
  const chain = answerPrompt.pipe(getChatModel());
  const result = await chain.invoke({
    excerpts: formatExcerpts(docs),
    chat_history: chatHistory || [],
    question: query,
  });
  return result.content;
}

// A "give me full coverage of X" question about one specific page routinely
// matches several of that page's own chunks in the top-K (confirmed against
// real data: a 16-chunk page had 6 of its chunks fill the entire top-K,
// leaving 10 chunks - including whole sections - never seen by the LLM).
// When 2+ top results share a pageId, that's a strong enough signal to fetch
// that page's COMPLETE chunk set by ID rather than trust the sampled subset.
const DOMINANT_PAGE_THRESHOLD = 2;

async function expandDominantPages(docs) {
  const countByPage = new Map();
  docs.forEach((d) => countByPage.set(d.metadata.pageId, (countByPage.get(d.metadata.pageId) || 0) + 1));

  const dominantPageIds = [...countByPage.entries()]
    .filter(([, count]) => count >= DOMINANT_PAGE_THRESHOLD)
    .map(([pageId]) => pageId);
  if (dominantPageIds.length === 0) return docs;

  const client = await getClient();
  const collection = client.db(DB_NAME).collection(TESTPLAN_COLLECTION_NAME);
  // Field names match what create-testplan-embeddings.js actually stored:
  // MongoDBAtlasVectorSearch flattens metadata to top-level fields and uses
  // "text" (its default textKey) rather than our old "content" field name.
  const fullPageRows = await collection
    .find(
      { pageId: { $in: dominantPageIds } },
      { projection: { _id: 0, pageId: 1, title: 1, url: 1, text: 1, chunkIndex: 1 } }
    )
    .sort({ pageId: 1, chunkIndex: 1 })
    .toArray();

  const fullPageDocs = fullPageRows.map(
    (row) => new Document({
      pageContent: row.text,
      metadata: { pageId: row.pageId, title: row.title, url: row.url, chunkIndex: row.chunkIndex },
    })
  );

  const supplementary = docs.filter((d) => !dominantPageIds.includes(d.metadata.pageId));
  return [...fullPageDocs, ...supplementary];
}

/**
 * @param {string} query - the user's question
 * @param {string} [sessionId] - if provided, follow-up questions in this
 *   session get history-aware reformulation for retrieval AND the chat
 *   history is available to the final answer too. Omitted entirely = exact
 *   Phase 1 behavior (stateless, no history involved at all).
 * @returns {Promise<{answer: string, sources: Array<{title, url, pageId}>}>}
 */
async function queryTestPlan(query, sessionId) {
  const retriever = await getRetriever();

  let pastMessages = [];
  let fusedDocs;
  if (sessionId) {
    const history = getSessionHistory(sessionId);
    pastMessages = await history.getMessages();
    const historyAwareRetriever = await wrapWithHistoryAwareness(retriever, getChatModel());
    fusedDocs = await historyAwareRetriever.invoke({ input: query, chat_history: pastMessages });
  } else {
    fusedDocs = await retriever.invoke(query);
  }

  // EnsembleRetriever returns the full fused/deduped union (no internal
  // k-limit) - slice to TOP_K ourselves before dominant-page expansion.
  const initialDocs = fusedDocs.slice(0, TOP_K);

  const docs = await expandDominantPages(initialDocs);
  const answer = await synthesizeAnswer(query, docs, pastMessages);

  if (sessionId) {
    const history = getSessionHistory(sessionId);
    await history.addUserMessage(query);
    await history.addAIMessage(answer);
  }

  // De-dupe sources by page - multiple chunks from the same page shouldn't
  // list the same title/url more than once in the citation list.
  const seenPages = new Set();
  const sources = docs.filter((d) => {
    if (seenPages.has(d.metadata.pageId)) return false;
    seenPages.add(d.metadata.pageId);
    return true;
  }).map((d) => ({ title: d.metadata.title, url: d.metadata.url, pageId: d.metadata.pageId }));

  return { answer, sources };
}

module.exports = { queryTestPlan };
