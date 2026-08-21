/* ==========================================================================
   dpdpRetriever.js — story -> DPDP (India's Digital Personal Data
   Protection Act, 2023) clause matches. Thin instantiation of
   complianceClauseRetriever.js's shared factory - see that file for the
   actual vector search + reranking logic.
   Reused by server.js's /api/knowledge/query.
   ========================================================================== */

const { createClauseQueryFn } = require("./complianceClauseRetriever");

const DPDP_COLLECTION_NAME = process.env.DPDP_COLLECTION_NAME || "dpdp";
const DPDP_VECTOR_INDEX_NAME = process.env.DPDP_VECTOR_INDEX_NAME || "dpdp_index";

const queryDpdp = createClauseQueryFn({
  standard: "DPDP",
  collectionName: DPDP_COLLECTION_NAME,
  indexName: DPDP_VECTOR_INDEX_NAME,
});

module.exports = { queryDpdp };
