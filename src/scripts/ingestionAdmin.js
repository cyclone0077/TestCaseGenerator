/* ==========================================================================
   ingestionAdmin.js — thin helpers backing the in-app Ingestion panel's
   HTTP routes (server.js). The actual fetch/chunk/embed logic lives in
   confluence-to-json.js and create-testplan-embeddings.js, unchanged - this
   module only adapts those reusable functions for HTTP use (deriving an
   output filename from a user-typed label, listing what's on disk, and
   keeping filenames from the browser confined to src/data/).
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const { fetchConfluenceSourceToChunks } = require("./confluence-to-json");
const { embedChunksToMongo } = require("./create-testplan-embeddings");

const DATA_DIR = path.join(__dirname, "..", "data");

function slugify(label) {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "source";
}

/**
 * Lists the intermediate chunk JSON files sitting in src/data/, newest
 * first - the "Available Files" list the Ingestion panel's Step 2 shows.
 */
function listChunkFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return fs
    .readdirSync(DATA_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((fileName) => {
      const stat = fs.statSync(path.join(DATA_DIR, fileName));
      return { fileName, sizeBytes: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

/**
 * Step 1: fetch a Confluence page (plus descendants, or just that one page)
 * and write its chunks to src/data/<slug>-chunks.json. The "Source Name"
 * typed in the form becomes both the chunk metadata's docType and the
 * output filename's slug, so the user only fills in one label.
 */
async function runFetch({ pageId, mode, sourceName }) {
  if (!pageId || !pageId.trim()) throw new Error("pageId is required");
  if (!sourceName || !sourceName.trim()) throw new Error("sourceName is required");

  const outputFile = path.join(DATA_DIR, `${slugify(sourceName)}-chunks.json`);

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
 * collection/index.
 */
async function runEmbed({ fileName, collectionName, indexName }) {
  if (!fileName || !fileName.trim()) throw new Error("fileName is required");
  if (!collectionName || !collectionName.trim()) throw new Error("collectionName is required");
  if (!indexName || !indexName.trim()) throw new Error("indexName is required");

  // fileName comes from the browser - resolve it strictly inside DATA_DIR so
  // a "../" traversal can't reach anything outside src/data/.
  const resolved = path.resolve(DATA_DIR, fileName);
  if (path.dirname(resolved) !== DATA_DIR) {
    throw new Error("Invalid fileName");
  }

  const { chunksEmbedded, tookMs } = await embedChunksToMongo({
    inputFile: resolved,
    collectionName: collectionName.trim(),
    indexName: indexName.trim(),
  });

  return { chunksEmbedded, tookMs };
}

module.exports = { listChunkFiles, runFetch, runEmbed };
