/* ==========================================================================
   validate-testplan-embeddings.js — structural integrity check for the
   test_plans collection. Doesn't (and can't) verify semantic correctness of
   111 pages by hand; instead cross-checks completeness and structure:
   every live Confluence page is represented, no gaps in chunk sequences,
   every embedding is well-formed, and no accidental duplicates.
   ========================================================================== */

require("dotenv").config();
const { MongoClient } = require("mongodb");

const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL || "";
const CONFLUENCE_EMAIL = process.env.CONFLUENCE_EMAIL || "";
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN || "";
const TESTPLAN_ROOT_PAGE_ID = process.env.TESTPLAN_ROOT_PAGE_ID || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "";
const TESTPLAN_COLLECTION_NAME = process.env.TESTPLAN_COLLECTION_NAME || "test_plans";

const PAGE_LIMIT = 150;
const EXPECTED_EMBEDDING_DIM = 1024;
const SHORT_CONTENT_THRESHOLD = 100; // total chars across all of a page's chunks

function authHeader() {
  const token = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64");
  return { Authorization: `Basic ${token}`, Accept: "application/json" };
}

// Lightweight listing only (no body content) - just confirming which pages
// currently exist under the Test Plan root, for coverage comparison.
async function fetchLivePageList() {
  const pages = [];
  let start = 0;

  while (true) {
    const url =
      `${CONFLUENCE_BASE_URL}/wiki/rest/api/content/${TESTPLAN_ROOT_PAGE_ID}/descendant/page` +
      `?limit=${PAGE_LIMIT}&start=${start}`;
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) throw new Error(`Confluence API error (HTTP ${res.status})`);
    const data = await res.json();
    pages.push(...data.results.map((p) => ({ id: p.id, title: p.title })));
    if (!data._links || !data._links.next || data.results.length === 0) break;
    start += data.results.length;
  }

  return pages;
}

async function main() {
  console.log("🔍 Validating test_plans embeddings...\n");

  console.log("📥 Fetching live page list from Confluence...");
  const livePages = await fetchLivePageList();
  const livePageIds = new Set(livePages.map((p) => p.id));
  console.log(`   Found ${livePages.length} live pages under the Test Plan root.\n`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const collection = client.db(DB_NAME).collection(TESTPLAN_COLLECTION_NAME);

  try {
    const allDocs = await collection
      .find({}, { projection: { pageId: 1, title: 1, chunkIndex: 1, content: 1, embedding: 1 } })
      .toArray();

    console.log(`📦 Total documents in Mongo: ${allDocs.length}\n`);

    // ---- Group by page ----
    const byPage = new Map();
    allDocs.forEach((doc) => {
      if (!byPage.has(doc.pageId)) byPage.set(doc.pageId, []);
      byPage.get(doc.pageId).push(doc);
    });

    const issues = [];

    // ---- 1. Coverage: every live page should have at least one chunk ----
    const pagesInMongo = new Set(byPage.keys());
    const missingPages = livePages.filter((p) => !pagesInMongo.has(p.id));
    if (missingPages.length) {
      issues.push(`❌ ${missingPages.length} live page(s) have ZERO chunks in Mongo:`);
      missingPages.forEach((p) => issues.push(`     - "${p.title}" (${p.id})`));
    }

    // ---- 2. Orphans: pages in Mongo no longer live in Confluence ----
    const orphanPageIds = [...pagesInMongo].filter((id) => !livePageIds.has(id));
    if (orphanPageIds.length) {
      issues.push(`⚠️  ${orphanPageIds.length} pageId(s) in Mongo no longer exist under the live Confluence root (deleted/moved since ingestion):`);
      orphanPageIds.forEach((id) => issues.push(`     - ${id} ("${byPage.get(id)[0].title}")`));
    }

    // ---- 3. Chunk-sequence gaps + duplicates, per page ----
    let gapCount = 0, dupCount = 0, shortContentCount = 0, badEmbeddingCount = 0;
    byPage.forEach((docs, pageId) => {
      const indices = docs.map((d) => d.chunkIndex).sort((a, b) => a - b);
      const seen = new Set();
      indices.forEach((idx) => {
        if (seen.has(idx)) dupCount++;
        seen.add(idx);
      });
      const expectedRun = Array.from({ length: docs.length }, (_, i) => i);
      const uniqueSorted = [...new Set(indices)];
      if (JSON.stringify(uniqueSorted) !== JSON.stringify(expectedRun)) {
        gapCount++;
        issues.push(`❌ Page "${docs[0].title}" (${pageId}) has a chunkIndex gap: got [${uniqueSorted.join(",")}], expected 0..${docs.length - 1}`);
      }

      const totalLen = docs.reduce((sum, d) => sum + (d.content ? d.content.length : 0), 0);
      if (totalLen < SHORT_CONTENT_THRESHOLD) {
        shortContentCount++;
        issues.push(`⚠️  Page "${docs[0].title}" (${pageId}) has only ${totalLen} total chars across ${docs.length} chunk(s) - worth a manual glance`);
      }
    });

    // ---- 4. Embedding integrity ----
    allDocs.forEach((doc) => {
      if (!Array.isArray(doc.embedding) || doc.embedding.length !== EXPECTED_EMBEDDING_DIM || doc.embedding.some((n) => typeof n !== "number" || Number.isNaN(n))) {
        badEmbeddingCount++;
        issues.push(`❌ Malformed embedding on chunk ${doc.pageId}#${doc.chunkIndex} ("${doc.title}")`);
      }
    });

    // ---- Report ----
    console.log("--- SUMMARY ---");
    console.log(`Live Confluence pages:        ${livePages.length}`);
    console.log(`Unique pages represented:     ${pagesInMongo.size}`);
    console.log(`Pages missing entirely:       ${missingPages.length}`);
    console.log(`Orphaned pages (stale data):  ${orphanPageIds.length}`);
    console.log(`Pages with chunk-index gaps:  ${gapCount}`);
    console.log(`Duplicate (pageId,chunkIdx):  ${dupCount}`);
    console.log(`Pages with suspiciously short content: ${shortContentCount}`);
    console.log(`Malformed embeddings:         ${badEmbeddingCount}`);
    console.log();

    if (issues.length) {
      console.log("--- DETAILS ---");
      issues.forEach((i) => console.log(i));
      console.log();
      console.log(`🔶 Validation finished with ${issues.length} item(s) to review.`);
    } else {
      console.log("✅ All checks passed - full coverage, no gaps, no duplicates, all embeddings well-formed.");
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
