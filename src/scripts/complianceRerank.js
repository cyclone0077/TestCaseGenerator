/* ==========================================================================
   complianceRerank.js — shared LLM reranking step for the Compliance
   sources (GDPR, EU AI Act). Vector search alone ranks by embedding
   similarity only; this asks the chat model to actually weigh each
   candidate clause against the user's story and score its real relevance.

   Ported to match the reference Compliance Coverage Agent's
   retrieval/rerankService.ts contract exactly: the model scores EVERY
   candidate from 0-1 (nothing is dropped, just rescored/reordered), and
   any candidate the model's response is missing/unparseable for falls
   back to its original vector-search score rather than being excluded.
   Reuses the chat model already wired up via chatModelProvider.js
   (Mistral/Gemini) instead of adding Groq as a new dependency - so unlike
   the reference, this doesn't rely on a provider-specific strict JSON
   response_format; the prompt asks for JSON directly and the parser
   tolerates a model wrapping it in prose despite instructions not to.
   ========================================================================== */

const { ChatPromptTemplate } = require("@langchain/core/prompts");

// Each candidate is a whole legal article (gdprScraper.js/euAiActScraper.js
// don't sub-chunk) - excerpt only trims what's SENT to the reranker for
// judgment, the full text still comes from the original candidate.
const SNIPPET_LENGTH = 400;

const rerankPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are a compliance expert ranking legal clauses by relevance to a user story or requirement.\n\n" +
    "Score every candidate clause's relevance to the user story from 0 (irrelevant) to 1 (highly " +
    "relevant). Return ONLY a JSON object of this exact shape, with one entry per candidate, no " +
    "other text, no markdown code fences:\n" +
    // Literal braces doubled ({{/}}) - ChatPromptTemplate's f-string-style
    // templating otherwise reads a bare { as a variable delimiter and
    // throws "Single '}' in template." on this JSON example.
    '{{"rankings": [{{"clauseId": "<clauseId>", "score": <0-1 number>}}, ...]}}',
  ],
  ["human", "User story:\n\"\"\"\n{story}\n\"\"\"\n\nCandidate clauses:\n{candidates}"],
]);

function formatCandidates(candidates) {
  return candidates
    .map((c, i) => `${i + 1}. clauseId: "${c.clauseId}" | title: "${c.title}" | text: "${c.textSnippet.replace(/"/g, "'")}"`)
    .join("\n");
}

function parseRankings(raw) {
  // Models sometimes wrap the object in prose or a code fence despite
  // instructions not to - pull out the first {...} run rather than
  // assuming raw is bare JSON.
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : raw);
  if (!Array.isArray(parsed.rankings)) throw new Error('Reranker response missing "rankings" array');
  return parsed.rankings;
}

/**
 * @param {string} story - the user's requirement/story text
 * @param {Array<{clauseId: string, title: string, textSnippet: string}>} candidates
 * @param {BaseChatModel} chatModel
 * @returns {Promise<Array<{clauseId: string, score: number}>>} one score per
 *   candidate that the model returned a value for - callers should fall
 *   back to each candidate's own vector-search score for any clauseId
 *   missing here (including all of them, if the whole call fails).
 */
async function rerankClauses(story, candidates, chatModel) {
  if (candidates.length === 0) return [];

  const chain = rerankPrompt.pipe(chatModel);
  try {
    const result = await chain.invoke({ story, candidates: formatCandidates(candidates) });
    return parseRankings(result.content);
  } catch (err) {
    console.error("Compliance rerank failed, falling back to vector-search order:", err.message);
    return [];
  }
}

module.exports = { rerankClauses, SNIPPET_LENGTH };
