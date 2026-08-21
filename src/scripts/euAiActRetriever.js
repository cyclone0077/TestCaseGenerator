/* ==========================================================================
   euAiActRetriever.js — story -> EU AI Act clause matches. Thin
   instantiation of complianceClauseRetriever.js's shared factory - see
   that file for the actual vector search + reranking logic.
   Reused by server.js's /api/knowledge/query.
   ========================================================================== */

const { createClauseQueryFn } = require("./complianceClauseRetriever");

const EU_AI_ACT_COLLECTION_NAME = process.env.EU_AI_ACT_COLLECTION_NAME || "euai";
const EU_AI_ACT_VECTOR_INDEX_NAME = process.env.EU_AI_ACT_VECTOR_INDEX_NAME || "euai_index";

const queryEuAiAct = createClauseQueryFn({
  standard: "EU AI Act",
  collectionName: EU_AI_ACT_COLLECTION_NAME,
  indexName: EU_AI_ACT_VECTOR_INDEX_NAME,
});

module.exports = { queryEuAiAct };
