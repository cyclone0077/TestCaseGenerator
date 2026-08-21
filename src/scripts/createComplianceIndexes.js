/* ==========================================================================
   createComplianceIndexes.js — one-time Atlas Search vector index creation
   for every Compliance collection (GDPR, EU AI Act, DPDP). Safe to re-run:
   creates an index if missing, or updates it in place if an existing index
   with the same name doesn't match the canonical field definition.

   Ported from the reference Compliance Coverage Agent's
   scripts/createVectorIndexes.ts - same canonical definition (a vector
   field on "embedding", plus metadata.standard/metadata.clauseId as filter
   fields, matching what complianceIngest.js actually stores), same
   create-or-update-in-place behavior, same READY-polling loop.
   ========================================================================== */

require("dotenv").config();
const { MongoClient } = require("mongodb");
const { applyDnsOverride } = require("./dnsOverride");

applyDnsOverride();

const COMPLIANCE_MONGODB_URI = process.env.COMPLIANCE_MONGODB_URI || "";
const COMPLIANCE_DB_NAME = process.env.COMPLIANCE_DB_NAME || "";
const COMPLIANCE_VECTOR_DIMENSIONS = Number(process.env.COMPLIANCE_VECTOR_DIMENSIONS) || 1024;

const INDEXES = [
  {
    collectionName: process.env.GDPR_COLLECTION_NAME || "gdpr",
    indexName: process.env.GDPR_VECTOR_INDEX_NAME || "gdpr_index",
  },
  {
    collectionName: process.env.EU_AI_ACT_COLLECTION_NAME || "euai",
    indexName: process.env.EU_AI_ACT_VECTOR_INDEX_NAME || "euai_index",
  },
  {
    collectionName: process.env.DPDP_COLLECTION_NAME || "dpdp",
    indexName: process.env.DPDP_VECTOR_INDEX_NAME || "dpdp_index",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalDefinition() {
  return {
    fields: [
      { type: "vector", path: "embedding", numDimensions: COMPLIANCE_VECTOR_DIMENSIONS, similarity: "cosine" },
      { type: "filter", path: "metadata.standard" },
      { type: "filter", path: "metadata.clauseId" },
    ],
  };
}

function matchesCanonicalDefinition(info) {
  const fields = (info.latestDefinition && info.latestDefinition.fields) || [];
  const filterPaths = new Set(fields.filter((f) => f.type === "filter").map((f) => f.path));
  return filterPaths.has("metadata.standard") && filterPaths.has("metadata.clauseId");
}

async function waitUntilReady(collection, indexName) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const indexes = await collection.listSearchIndexes(indexName).toArray();
    const status = indexes[0] && indexes[0].status;
    console.log(`  status: ${status || "unknown"}`);
    if (status === "READY") {
      console.log(`Index "${indexName}" is READY.`);
      return;
    }
    await sleep(5000);
  }
  console.warn(`Index "${indexName}" did not reach READY within the polling window; check Atlas UI.`);
}

async function ensureVectorIndex(db, collectionName, indexName) {
  const collection = db.collection(collectionName);

  const existing = await collection.listSearchIndexes(indexName).toArray().catch(() => []);

  if (existing.length > 0) {
    if (matchesCanonicalDefinition(existing[0])) {
      console.log(`[skip] Index "${indexName}" already exists on "${collectionName}" and matches spec`);
      return;
    }
    console.log(`Index "${indexName}" on "${collectionName}" exists but doesn't match spec. Updating in place...`);
    await collection.updateSearchIndex(indexName, canonicalDefinition());
    await waitUntilReady(collection, indexName);
    return;
  }

  console.log(`Creating vector index "${indexName}" on "${collectionName}"...`);
  await collection.createSearchIndex({ name: indexName, type: "vectorSearch", definition: canonicalDefinition() });
  await waitUntilReady(collection, indexName);
}

async function main() {
  if (!COMPLIANCE_MONGODB_URI) throw new Error("Missing required .env var: COMPLIANCE_MONGODB_URI");
  if (!COMPLIANCE_DB_NAME) throw new Error("Missing required .env var: COMPLIANCE_DB_NAME");

  const client = new MongoClient(COMPLIANCE_MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(COMPLIANCE_DB_NAME);
    for (const { collectionName, indexName } of INDEXES) {
      await ensureVectorIndex(db, collectionName, indexName);
    }
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Failed to create Compliance indexes:", err.message);
    process.exit(1);
  });
}
