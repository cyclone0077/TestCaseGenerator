/* ==========================================================================
   confluence-to-json.js — fetches Confluence page(s) (either one page's full
   descendant subtree, or a single page on its own), converts each page's
   storage-format body to plain text, chunks it, and writes a structured
   JSON file ready for the embeddings script. No Mongo/Mistral involved here
   — safe to re-run for free.

   fetchConfluenceSourceToChunks() is the reusable core, called both by this
   file's own CLI main() (Test Plan, via env vars, unchanged behavior) and
   by the in-app Ingestion panel's /api/admin/ingest/fetch route (any page
   ID / docType / output file, coming from a browser form instead of .env).
   ========================================================================== */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters");
const { confluenceStorageToText } = require("./confluenceStorageToText");

const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL || "";
const CONFLUENCE_EMAIL = process.env.CONFLUENCE_EMAIL || "";
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN || "";
const TESTPLAN_ROOT_PAGE_ID = process.env.TESTPLAN_ROOT_PAGE_ID || "";

const PAGE_LIMIT = 150;
const OUTPUT_FILE = "src/data/confluence/testplan-chunks.json";

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

// Default separators are ["\n\n", "\n", " ", ""] - tries paragraph breaks
// first, then falls back to finer boundaries. Unlike our old hand-rolled
// chunkText(), this recurses into a paragraph that's still too big on its
// own instead of leaving it as one oversized chunk (the real bug we found
// earlier: a 5,778-char table became a single un-split chunk).
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

function validateConfig() {
  const missing = ["CONFLUENCE_BASE_URL", "CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN"]
    .filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required .env vars: ${missing.join(", ")}`);
  }
}

function authHeader() {
  const token = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64");
  return { Authorization: `Basic ${token}`, Accept: "application/json" };
}

/**
 * Fetches every descendant page of the given root, following pagination
 * until Confluence stops returning a `next` link. Content is already
 * included via `expand=body.storage,version` on this same call - no
 * separate per-page fetch needed. Works the same whether `rootPageId` is a
 * root folder or a whole space's homepage ID - Confluence treats a
 * homepage as an ordinary page, so "descendants of the homepage" is just
 * "every page in the space."
 *
 * `_links.next`'s presence is used purely as the continue/stop signal - its
 * embedded `start` value is NOT trusted, because when `expand=body.storage`
 * makes the server cap the actual page size below the requested `limit`,
 * `_links.next` still computes `start` from the *requested* limit, which
 * skips however many results were short-changed on the previous page.
 */
async function fetchAllDescendants(rootPageId) {
  const pages = [];
  let start = 0;

  while (true) {
    const url =
      `${CONFLUENCE_BASE_URL}/wiki/rest/api/content/${rootPageId}/descendant/page` +
      `?limit=${PAGE_LIMIT}&start=${start}&expand=${encodeURIComponent("body.storage,version")}`;

    console.log(`📥 Fetching descendants (start=${start})...`);
    const res = await fetch(url, { headers: authHeader() });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Confluence API error (HTTP ${res.status}): ${detail}`);
    }

    const data = await res.json();
    const { results, _links } = data;
    pages.push(...results);
    console.log(`   Got ${results.length} pages (total so far: ${pages.length})`);

    if (!_links || !_links.next || results.length === 0) break;
    start += results.length;
  }

  return pages;
}

/**
 * Fetches exactly one page by ID, no descendants - the "single page" mode
 * used to add/update one page without touching the rest of an already-
 * ingested source.
 */
async function fetchSinglePage(pageId) {
  const url =
    `${CONFLUENCE_BASE_URL}/wiki/rest/api/content/${pageId}` +
    `?expand=${encodeURIComponent("body.storage,version")}`;

  console.log(`📥 Fetching single page ${pageId}...`);
  const res = await fetch(url, { headers: authHeader() });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Confluence API error (HTTP ${res.status}): ${detail}`);
  }

  return res.json();
}

/**
 * Converts one Confluence page into LangChain Document chunks - the
 * standard { pageContent, metadata } shape used throughout the rest of
 * this pipeline from here on.
 */
async function pageToDocuments(page, docType) {
  const text = confluenceStorageToText(page.body && page.body.storage && page.body.storage.value);
  if (!text) return [];

  const url = `${CONFLUENCE_BASE_URL}${(page._links && page._links.webui) || ""}`;
  const metadata = { pageId: page.id, title: page.title, url, docType };

  const docs = await splitter.createDocuments([text], [metadata]);
  docs.forEach((doc, chunkIndex) => {
    // createDocuments() doesn't number the chunks it produces - assign our
    // own chunkIndex per page, since expandDominantPages() (in
    // testplanRetriever.js) looks it up by page.
    doc.metadata.chunkIndex = chunkIndex;
    // Prepend the page title to every chunk's actual embedded text, not
    // just metadata. Confirmed against real data: a query closely matching
    // a page's TITLE ("What is the Primary Objective of Losing Perception:
    // Egregious Cases?") lost a retrieval race to an unrelated page whose
    // body happened to repeat similar wording - because the title itself
    // was invisible to the embedding (it only ever lived in metadata.title,
    // which the retriever never embeds or searches on).
    doc.pageContent = `${page.title}\n\n${doc.pageContent}`;
  });
  return docs;
}

/**
 * Reusable core: fetch a Confluence source (one page, or one page plus its
 * full descendant subtree), chunk it, write the result to `outputFile`.
 *
 * @param {{pageId: string, mode?: "descendants"|"single", docType: string, outputFile: string}} params
 * @returns {Promise<{pageCount: number, chunkCount: number, outputFile: string}>}
 */
async function fetchConfluenceSourceToChunks({ pageId, mode = "descendants", docType, outputFile }) {
  validateConfig();

  console.log(`🚀 Fetching ${mode === "single" ? "single page" : "page + descendants"} ${pageId} (docType: ${docType})...`);
  const pages = mode === "single" ? [await fetchSinglePage(pageId)] : await fetchAllDescendants(pageId);
  console.log(`✅ Fetched ${pages.length} page(s) total`);

  const docsPerPage = await Promise.all(pages.map((page) => pageToDocuments(page, docType)));
  const documents = docsPerPage.flat();
  console.log(`📦 Produced ${documents.length} chunks from ${pages.length} page(s)`);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(documents, null, 2), "utf-8");
  console.log(`✅ Wrote ${documents.length} chunks to ${outputFile}`);

  return { pageCount: pages.length, chunkCount: documents.length, outputFile };
}

async function main() {
  if (!TESTPLAN_ROOT_PAGE_ID) {
    throw new Error("Missing required .env var: TESTPLAN_ROOT_PAGE_ID");
  }
  await fetchConfluenceSourceToChunks({
    pageId: TESTPLAN_ROOT_PAGE_ID,
    mode: "descendants",
    docType: "TestPlan",
    outputFile: OUTPUT_FILE,
  });
}

module.exports = { fetchConfluenceSourceToChunks };

// Only run as a CLI script when invoked directly (`node confluence-to-json.js`)
// - required by server.js/ingestionAdmin.js without triggering a live fetch.
if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}
