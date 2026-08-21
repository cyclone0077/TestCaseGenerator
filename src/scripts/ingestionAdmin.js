/* ==========================================================================
   ingestionAdmin.js — thin helpers backing the in-app Ingestion panel's
   HTTP routes (server.js). The actual fetch/chunk/embed logic lives in
   confluence-to-json.js, create-testplan-embeddings.js, gdprScraper.js,
   euAiActScraper.js, dpdpScraper.js, and complianceIngest.js, unchanged -
   this module only adapts those reusable functions for HTTP use (deriving
   an output filename from a user-typed label, listing what's on disk, and
   keeping filenames from the browser confined to their source's own
   directory).

   Confluence and Compliance files live in separate directories
   (src/data/confluence/, src/data/compliance/) - that split IS the routing
   mechanism: which directory a selected file resolves into tells
   runEmbed()/runComplianceEmbed() which cluster/ingestion mechanism it
   needs, with no separate "source type" to track/get out of sync.
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const { fetchConfluenceSourceToChunks } = require("./confluence-to-json");
const { embedChunksToMongo } = require("./create-testplan-embeddings");
const { scrapeGdprToChunks } = require("./gdprScraper");
const { scrapeEuAiActToChunks } = require("./euAiActScraper");
const { scrapeDpdpToChunks } = require("./dpdpScraper");
const { ingestClausesToMongo } = require("./complianceIngest");

const CONFLUENCE_DATA_DIR = path.join(__dirname, "..", "data", "confluence");
const COMPLIANCE_DATA_DIR = path.join(__dirname, "..", "data", "compliance");

// Compliance scrapers always write to these exact, fixed filenames (unlike
// Confluence's user-named "<slug>-chunks.json"). collectionName/indexName
// mirror the real defaults gdprRetriever.js/euAiActRetriever.js/
// dpdpRetriever.js and their create-*-embeddings.js counterparts actually
// use, single-sourced here so the Ingestion panel's Step 3 can show the
// TRUE destination (getComplianceConfig() below) instead of the stale
// Test Plan placeholders it started with before any standard was picked.
const COMPLIANCE_STANDARDS = {
  gdpr: {
    scrape: scrapeGdprToChunks,
    fileName: "gdpr-clauses.json",
    collectionName: process.env.GDPR_COLLECTION_NAME || "gdpr",
    indexName: process.env.GDPR_VECTOR_INDEX_NAME || "gdpr_index",
  },
  euai: {
    scrape: scrapeEuAiActToChunks,
    fileName: "eu-ai-act-clauses.json",
    collectionName: process.env.EU_AI_ACT_COLLECTION_NAME || "euai",
    indexName: process.env.EU_AI_ACT_VECTOR_INDEX_NAME || "euai_index",
  },
  dpdp: {
    scrape: scrapeDpdpToChunks,
    fileName: "dpdp-clauses.json",
    collectionName: process.env.DPDP_COLLECTION_NAME || "dpdp",
    indexName: process.env.DPDP_VECTOR_INDEX_NAME || "dpdp_index",
  },
};

function slugify(label) {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "source";
}

/**
 * Resolves a browser-supplied fileName strictly inside the given base dir,
 * so a "../" traversal can't reach anything outside it. Throws on mismatch.
 */
function resolveInside(baseDir, fileName) {
  const resolved = path.resolve(baseDir, fileName);
  if (path.dirname(resolved) !== baseDir) {
    throw new Error("Invalid fileName");
  }
  return resolved;
}

function listFilesIn(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((fileName) => {
      const stat = fs.statSync(path.join(dir, fileName));
      return { fileName, sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

/**
 * Lists the intermediate chunk JSON files for one source, newest first -
 * the "Available Files" list the Ingestion panel's Step 2 shows, scoped to
 * whichever source is selected in Step 1.
 */
function listChunkFiles(source) {
  return listFilesIn(source === "compliance" ? COMPLIANCE_DATA_DIR : CONFLUENCE_DATA_DIR);
}

/**
 * Step 1: fetch a Confluence page (plus descendants, or just that one page)
 * and write its chunks to src/data/confluence/<slug>-chunks.json. The
 * "Source Name" typed in the form becomes both the chunk metadata's
 * docType and the output filename's slug, so the user only fills in one
 * label.
 */
async function runFetch({ pageId, mode, sourceName }) {
  if (!pageId || !pageId.trim()) throw new Error("pageId is required");
  if (!sourceName || !sourceName.trim()) throw new Error("sourceName is required");

  const outputFile = path.join(CONFLUENCE_DATA_DIR, `${slugify(sourceName)}-chunks.json`);

  const { pageCount, chunkCount } = await fetchConfluenceSourceToChunks({
    pageId: pageId.trim(),
    mode: mode === "single" ? "single" : "descendants",
    docType: sourceName.trim(),
    outputFile,
  });

  return { pageCount, chunkCount, fileName: path.basename(outputFile) };
}

/**
 * Step 3: embed a previously-fetched chunks file into the given Mongo
 * collection/index. Test Plan's cluster/schema only - resolving strictly
 * inside src/data/confluence/ means a Compliance-scraped file (a different
 * directory entirely) can't reach this path by construction.
 */
async function runEmbed({ fileName, collectionName, indexName }) {
  if (!fileName || !fileName.trim()) throw new Error("fileName is required");
  if (!collectionName || !collectionName.trim()) throw new Error("collectionName is required");
  if (!indexName || !indexName.trim()) throw new Error("indexName is required");

  const resolved = resolveInside(CONFLUENCE_DATA_DIR, fileName);

  const { chunksEmbedded, tookMs } = await embedChunksToMongo({
    inputFile: resolved,
    collectionName: collectionName.trim(),
    indexName: indexName.trim(),
  });

  return { chunksEmbedded, tookMs };
}

/**
 * Step 1 (Compliance variant): scrape every article/section of the given
 * standard directly - no page ID needed, unlike Confluence. Always
 * overwrites the same fixed output file (safe to re-run for free, same as
 * the Confluence fetch).
 */
async function runComplianceScrape({ standard }) {
  const entry = COMPLIANCE_STANDARDS[standard];
  if (!entry) {
    throw new Error(`Unsupported standard: "${standard}". Use one of: ${Object.keys(COMPLIANCE_STANDARDS).join(", ")}.`);
  }

  const outputFile = path.join(COMPLIANCE_DATA_DIR, entry.fileName);
  const { clauseCount } = await entry.scrape({ outputFile });
  return { clauseCount, fileName: entry.fileName };
}

/**
 * The real destination (database + per-standard collection/index) Step 3
 * should show - sourced live from the same env vars the actual ingestion/
 * retrieval scripts use, not hardcoded in the browser, so it can't drift
 * out of sync with .env.
 */
function getComplianceConfig() {
  const standards = {};
  for (const [standard, entry] of Object.entries(COMPLIANCE_STANDARDS)) {
    standards[standard] = { collectionName: entry.collectionName, indexName: entry.indexName };
  }
  return { dbName: process.env.COMPLIANCE_DB_NAME || "", standards };
}

/**
 * Step 3 (Compliance variant): upsert a previously-scraped clauses file
 * into the Compliance cluster (COMPLIANCE_MONGODB_URI - a separate Atlas
 * account from Test Plan's) by clauseId. No index name needed here - that
 * only matters at query time (gdprRetriever.js/euAiActRetriever.js/
 * dpdpRetriever.js), not for writing the documents themselves.
 */
async function runComplianceEmbed({ fileName, collectionName }) {
  if (!fileName || !fileName.trim()) throw new Error("fileName is required");
  if (!collectionName || !collectionName.trim()) throw new Error("collectionName is required");

  const resolved = resolveInside(COMPLIANCE_DATA_DIR, fileName);

  const { inserted, updated } = await ingestClausesToMongo({
    inputFile: resolved,
    mongoUri: process.env.COMPLIANCE_MONGODB_URI,
    dbName: process.env.COMPLIANCE_DB_NAME,
    collectionName: collectionName.trim(),
  });

  return { inserted, updated };
}

module.exports = { listChunkFiles, runFetch, runEmbed, runComplianceScrape, runComplianceEmbed, getComplianceConfig };
