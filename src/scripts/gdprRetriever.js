/* ==========================================================================
   gdprRetriever.js — story -> GDPR clause matches. Thin instantiation of
   complianceClauseRetriever.js's shared factory - see that file for the
   actual vector search + reranking logic.
   Reused by server.js's /api/knowledge/query.
   ========================================================================== */

const { createClauseQueryFn } = require("./complianceClauseRetriever");

const GDPR_COLLECTION_NAME = process.env.GDPR_COLLECTION_NAME || "gdpr";
const GDPR_VECTOR_INDEX_NAME = process.env.GDPR_VECTOR_INDEX_NAME || "gdpr_index";

const queryGdpr = createClauseQueryFn({
  standard: "GDPR",
  collectionName: GDPR_COLLECTION_NAME,
  indexName: GDPR_VECTOR_INDEX_NAME,
});

module.exports = { queryGdpr };
