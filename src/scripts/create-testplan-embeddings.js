/* ==========================================================================
   create-testplan-embeddings.js — reads a chunks JSON file (produced by
   confluence-to-json.js), embeds each chunk via Mistral, and writes to a
   MongoDB Atlas collection. This is the step that spends real Mistral API
   cost and writes to Mongo — run confluence-to-json.js first and
   sanity-check its output before this.

   embedChunksToMongo() is the reusable core, called both by this file's own
   CLI main() (Test Plan, via env vars, unchanged behavior) and by the
   in-app Ingestion panel's /api/admin/ingest/embed route (any input file /
   destination collection/index, coming from a browser form instead of
   hardcoded constants).

   Idempotent by pageId: before inserting, any existing chunks belonging to
   the same page(s) are deleted first. This makes it safe to re-run for
   EITHER a full re-ingestion (no duplicate pages pile up) or a single
   edited/new page (only that page's old chunks get replaced - the other
   pages already in the collection are untouched).

   LangChain version: MongoDBAtlasVectorSearch.fromDocuments() folds
   "embed" and "insert" into one call - MistralAIEmbeddings handles
   batching (512 texts/request by default) and retries internally, so the
   hand-rolled batch loop + backoff logic from the pre-LangChain version is
   gone. Trade-off: embedDocuments() doesn't surface token usage, so we
   lose the per-run cost estimate the old script printed.
   ========================================================================== */

require("dotenv").config();
const fs = require("fs");
const dns = require("dns");
const { MongoClient } = require("mongodb");
const { MistralAIEmbeddings } = require("@langchain/mistralai");
const { MongoDBAtlasVectorSearch } = require("@langchain/mongodb");
const { Document } = require("@langchain/core/documents");

// Some networks (notably macOS) fail SRV lookups for mongodb+srv:// URIs
// against the default resolver. Set DNS_SERVERS (comma-separated) in .env
// to override, e.g. DNS_SERVERS=8.8.8.8,8.8.4.4
if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean));
}

const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "";
const TESTPLAN_COLLECTION_NAME = process.env.TESTPLAN_COLLECTION_NAME || "test_plans";
const TESTPLAN_VECTOR_INDEX_NAME = process.env.TESTPLAN_VECTOR_INDEX_NAME || "vector_index_test_plans";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const MISTRAL_EMBEDDING_MODEL = process.env.MISTRAL_EMBEDDING_MODEL || "mistral-embed";

const INPUT_FILE = "src/data/testplan-chunks.json";

function validateConfig() {
  const missing = ["MONGODB_URI", "DB_NAME", "MISTRAL_API_KEY"].filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required .env vars: ${missing.join(", ")}`);
  }
}

/**
 * Reusable core: embed a chunks JSON file and store it into the given
 * Mongo collection/index, replacing (not duplicating) any existing chunks
 * for the same page(s).
 *
 * @param {{inputFile: string, collectionName: string, indexName: string}} params
 * @returns {Promise<{chunksEmbedded: number, tookMs: number}>}
 */
async function embedChunksToMongo({ inputFile, collectionName, indexName }) {
  validateConfig();

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}. Run confluence-to-json.js first.`);
  }

  // The JSON file holds plain objects (JSON has no concept of a "Document
  // class") - rehydrate them into real Document instances, since
  // MongoDBAtlasVectorSearch.fromDocuments() expects that class specifically.
  const raw = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  const documents = raw.map((d) => new Document({ pageContent: d.pageContent, metadata: d.metadata }));

  console.log(`🚀 Embedding ${documents.length} chunks with Mistral AI (via LangChain)`);
  console.log(`   🗄️  Database: ${DB_NAME}`);
  console.log(`   📦 Collection: ${collectionName}`);
  console.log(`   🔎 Vector index: ${indexName}\n`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const collection = client.db(DB_NAME).collection(collectionName);

  const embeddings = new MistralAIEmbeddings({
    apiKey: MISTRAL_API_KEY,
    model: MISTRAL_EMBEDDING_MODEL,
    // Default batchSize (512 texts/request) blows past Mistral's per-request
    // token limit given our ~766-char average chunk size (confirmed by an
    // actual HTTP 400 "Too many tokens overall" on the first run) - 50 is
    // the same batch size the old hand-rolled script already used reliably.
    batchSize: 50,
    // embedDocuments() fires all batches via Promise.all() with NO
    // concurrency limit by default (maxConcurrency: Infinity) - confirmed by
    // an actual HTTP 429 "Rate limit exceeded" when ~55 batches all fired at
    // once. Capping concurrency queues them instead, same effect as the old
    // script's sequential-with-delay loop.
    maxConcurrency: 3,
  });

  const overallStart = Date.now();
  try {
    // Delete any existing chunks for these same pages first, so re-running
    // this (for a full source or a single page) replaces rather than
    // duplicates. A brand-new page's pageId simply matches nothing yet.
    const pageIds = [...new Set(documents.map((d) => d.metadata.pageId))];
    const { deletedCount } = await collection.deleteMany({ pageId: { $in: pageIds } });
    if (deletedCount > 0) {
      console.log(`🗑️  Removed ${deletedCount} existing chunk(s) for ${pageIds.length} page(s) being re-ingested`);
    }

    // embeddingKey defaults to "embedding" (matches the existing Atlas
    // index's field exactly, so the index doesn't need to change) - only
    // indexName needs to be passed explicitly, since that defaults to
    // "default" and our real index is named differently.
    await MongoDBAtlasVectorSearch.fromDocuments(documents, embeddings, {
      collection,
      indexName,
    });

    const tookMs = Date.now() - overallStart;
    console.log(`\n🎉 COMPLETE! Embedded and inserted ${documents.length} documents in ${(tookMs / 1000).toFixed(1)}s`);
    return { chunksEmbedded: documents.length, tookMs };
  } finally {
    await client.close();
  }
}

async function main() {
  await embedChunksToMongo({
    inputFile: INPUT_FILE,
    collectionName: TESTPLAN_COLLECTION_NAME,
    indexName: TESTPLAN_VECTOR_INDEX_NAME,
  });
}

module.exports = { embedChunksToMongo };

// Only run as a CLI script when invoked directly (`node create-testplan-embeddings.js`)
// - required by server.js/ingestionAdmin.js without triggering a live embed run.
if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}
