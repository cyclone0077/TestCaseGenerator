/* ==========================================================================
   euAiActScraper.js — fetches every EU AI Act article
   (artificialintelligenceact.eu, Art. 1-113) and writes one clause PER
   WHOLE ARTICLE (no sub-splitting) to a JSON file ready for the embeddings
   script. No Mongo/Mistral involved here — safe to re-run for free.

   Ported to match the reference Compliance Coverage Agent's
   scrapers/euAiActScraper.ts exactly (extraction logic + output schema),
   so the resulting documents are compatible with a vector index already
   created against that schema.

   Article URLs follow a plain numeric pattern
   (https://artificialintelligenceact.eu/article/N/) confirmed against the
   live site (article/1 and article/113 both resolve, article/114 404s) -
   simpler and more robust than parsing a listing page.

   The page is a Divi (WordPress page builder) layout with an AI-generated
   summary, a machine-translation notice, etc. before the real legal text -
   the actual article body is every <p> inside the ONE element on the page
   carrying the "et_pb_post_content" class (confirmed against real pages
   for Art. 1 and Art. 17; that class's third token has a page-specific
   numeric suffix, so matching is done on the shared substring only).
   ========================================================================== */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const BASE_URL = "https://artificialintelligenceact.eu";
const ARTICLE_COUNT = 113; // confirmed: article/113 exists, article/114 404s
const REQUEST_DELAY_MS = 1000; // be polite to the server

const OUTPUT_FILE = "src/data/compliance/eu-ai-act-clauses.json";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts one EU AI Act article page's HTML into the {standard, clauseId,
 * title, text, url} shape. Returns null for a 404 (skipped, not fatal).
 */
async function fetchArticle(n) {
  const url = `${BASE_URL}/article/${n}/`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetch failed for ${url} (HTTP ${res.status})`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const h1 = $("h1.entry-title").first();
  if (h1.length === 0) return null;

  // "Article N: <title>" - the title half is the only part not already
  // known from n itself.
  const h1Text = h1.text().replace(/\s+/g, " ").trim();
  const match = h1Text.match(/Article\s*\d+\s*:\s*(.*)/);
  const title = match ? match[1].trim() : h1Text;
  if (!title) return null;

  const bodyContainer = $('div[class*="et_pb_post_content"]').first();
  if (bodyContainer.length === 0) return null;

  const parts = [];
  bodyContainer.find("p").each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
  });

  const text = parts.join("\n");
  if (!text) return null;

  return {
    standard: "EU AI Act",
    clauseId: `Article ${n}`,
    title,
    text,
    url,
  };
}

/**
 * Reusable core: fetch every EU AI Act article, write the result to `outputFile`.
 *
 * @param {{outputFile: string}} params
 * @returns {Promise<{clauseCount: number, outputFile: string}>}
 */
async function scrapeEuAiActToChunks({ outputFile }) {
  console.log(`🚀 Fetching EU AI Act articles 1-${ARTICLE_COUNT} from ${BASE_URL}...`);
  const documents = [];
  for (let n = 1; n <= ARTICLE_COUNT; n++) {
    const doc = await fetchArticle(n);
    if (doc) {
      documents.push(doc);
      console.log(`   ✓ ${doc.clauseId}`);
    } else {
      console.log(`   ⚠️  Article ${n} EU AI Act not found - skipped`);
    }
    if (n < ARTICLE_COUNT) await sleep(REQUEST_DELAY_MS);
  }
  console.log(`📦 Produced ${documents.length} clause document(s)`);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(documents, null, 2), "utf-8");
  console.log(`✅ Wrote ${documents.length} clauses to ${outputFile}`);

  return { clauseCount: documents.length, outputFile };
}

async function main() {
  await scrapeEuAiActToChunks({ outputFile: OUTPUT_FILE });
}

module.exports = { scrapeEuAiActToChunks };

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}
