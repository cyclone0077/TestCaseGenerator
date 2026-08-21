/* ==========================================================================
   complianceClauseRetriever.js — shared factory for the Compliance sources
   (GDPR, EU AI Act): raw Atlas $vectorSearch aggregation over the
   Compliance cluster - a SEPARATE MongoDB Atlas account from Test Plan's
   (COMPLIANCE_MONGODB_URI, not MONGODB_URI) - followed by LLM reranking
   (complianceRerank.js). Returns ranked clause matches rather than a
   synthesized chat answer: this is a one-shot "map this story to these
   obligations" lookup, not a conversation, so there's no session/chat-
   history concept here at all (unlike testplanRetriever.js).

   Ported to match the reference Compliance Coverage Agent's
   retrieval/gdprRetrieval.ts + retrieval/euAiRetrieval.ts exactly: uses the
   native mongodb driver's $vectorSearch aggregation directly (not
   LangChain's MongoDBAtlasVectorSearch.asRetriever(), which assumes
   flattened top-level metadata - this Atlas index's filter paths are
   metadata.standard/metadata.clauseId, matching complianceIngest.js's
   stored document shape), numCandidates = min(limit*10, 10000), and
   reranking that RESCORES every candidate (falling back to its own
   vector-search score if the reranker omitted it) rather than dropping any.
   One deliberate addition beyond the reference: matches here also include
   `text`, since this is rendered inline in a chat bubble (the reference's
   own RetrievalMatch type omits it, presumably left to its own frontend to
   fetch separately via `url`).

   Both standards share this exact shape, only the collection/index/filter
   differ - gdprRetriever.js and euAiActRetriever.js are thin
   instantiations of this factory.
   ========================================================================== */

const { MongoClient } = require("mongodb");
const { MistralAIEmbeddings } = require("@langchain/mistralai");
const { createChatModel } = require("./chatModelProvider");
const { rerankClauses, SNIPPET_LENGTH } = require("./complianceRerank");
const { applyDnsOverride } = require("./dnsOverride");

// Applied here directly (not just relying on some other module's side
// effect) so this module is correct regardless of require order.
applyDnsOverride();

// Embeddings stay hardcoded to Mistral regardless of CHAT_MODEL_PROVIDER -
// see chatModelProvider.js for why (the stored corpus was embedded with
// Mistral's model; queries have to match it, not whatever reranks results).
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const MISTRAL_EMBEDDING_MODEL = process.env.MISTRAL_EMBEDDING_MODEL || "mistral-embed";
const COMPLIANCE_VECTOR_DIMENSIONS = Number(process.env.COMPLIANCE_VECTOR_DIMENSIONS) || 1024;
const COMPLIANCE_MONGODB_URI = process.env.COMPLIANCE_MONGODB_URI || "";
const COMPLIANCE_DB_NAME = process.env.COMPLIANCE_DB_NAME || "";

// Vector-search candidate count. Matches are ranked per whole article (no
// sub-chunking), so a sub-clause-specific story may need a higher value to
// surface its parent article - override via COMPLIANCE_TOP_K if 10 doesn't
// have enough recall for your queries.
const TOP_K = Number(process.env.COMPLIANCE_TOP_K) || 10;

const embeddings = new MistralAIEmbeddings({ apiKey: MISTRAL_API_KEY, model: MISTRAL_EMBEDDING_MODEL });

async function embedStory(story) {
  const vector = await embeddings.embedQuery(story);
  if (vector.length !== COMPLIANCE_VECTOR_DIMENSIONS) {
    throw new Error(`Embedding dimension mismatch: expected ${COMPLIANCE_VECTOR_DIMENSIONS}, got ${vector.length}`);
  }
  return vector;
}

// Single shared client + connection, reused across requests and across
// BOTH standards (GDPR and EU AI Act live in the same Compliance cluster,
// just different collections) rather than reconnecting per query.
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(COMPLIANCE_MONGODB_URI);
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

// Shared across both standards too - same provider/temperature either way,
// no reason for GDPR and EU AI Act to each hold their own model instance.
let chatModel = null;
function getChatModel() {
  if (!chatModel) chatModel = createChatModel({ temperature: 0 });
  return chatModel;
}

/**
 * @param {{standard: string, collectionName: string, indexName: string}} params
 * @returns {(story: string, sessionId?: string) => Promise<{matches: Array<{clauseId, title, url, text, score}>}>}
 *   sessionId is accepted (unused) purely for interface parity with the
 *   other Knowledge Search sources' handler(query, sessionId) signature in
 *   server.js.
 */
function createClauseQueryFn({ standard, collectionName, indexName }) {
  return async function query(story) {
    const limit = TOP_K;
    const numCandidates = Math.min(limit * 10, 10000);

    const queryVector = await embedStory(story);

    const client = await getClient();
    const collection = client.db(COMPLIANCE_DB_NAME).collection(collectionName);

    const candidates = await collection
      .aggregate([
        {
          $vectorSearch: {
            index: indexName,
            path: "embedding",
            queryVector,
            numCandidates,
            limit,
            filter: { "metadata.standard": standard },
          },
        },
        {
          $project: {
            _id: 0,
            clauseId: 1,
            title: 1,
            text: 1,
            url: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ])
      .toArray();

    if (candidates.length === 0) return { matches: [] };

    const rankings = await rerankClauses(
      story,
      candidates.map((c) => ({ clauseId: c.clauseId, title: c.title, textSnippet: c.text.slice(0, SNIPPET_LENGTH) })),
      getChatModel()
    );
    const scoreByClauseId = new Map(rankings.map((r) => [r.clauseId, r.score]));

    // Every vector-search candidate is kept, just rescored/reordered -
    // nothing gets dropped for a low or missing rerank score (falls back to
    // its own vector-search score instead).
    const matches = candidates
      .map((c) => ({
        clauseId: c.clauseId,
        title: c.title,
        url: c.url,
        text: c.text,
        score: scoreByClauseId.get(c.clauseId) ?? c.score,
      }))
      .sort((a, b) => b.score - a.score);

    return { matches };
  };
}

module.exports = { createClauseQueryFn };
