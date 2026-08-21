/* ==========================================================================
   gdprScraper.js — fetches every GDPR article (gdpr-info.eu, Art. 1-99) and
   writes one clause PER WHOLE ARTICLE (no sub-splitting) to a JSON file
   ready for the embeddings script. No Mongo/Mistral involved here — safe to
   re-run for free.

   Ported to match the reference Compliance Coverage Agent's
   scrapers/gdprScraper.ts exactly (extraction logic + output schema), so
   the resulting documents are compatible with a vector index already
   created against that schema.

   Article URLs follow a plain numeric pattern (https://gdpr-info.eu/art-N-gdpr/)
   confirmed against the live site (art-1-gdpr and art-99-gdpr both resolve,
   art-100-gdpr 404s) - simpler and more robust than parsing a listing page.

   Only DIRECT ol/p/ul children of .entry-content are the article body - the
   recitals list (.empfehlung-erwaegungsgruende), page-navigation, and
   feedback link are sibling divs in that same container, so a "known tags
   only" allowlist excludes them without needing to name each noise class.
   ========================================================================== */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const BASE_URL = "https://gdpr-info.eu";
const ARTICLE_COUNT = 99; // confirmed: art-99-gdpr exists, art-100-gdpr 404s
const REQUEST_DELAY_MS = 1000; // be polite to the server

const OUTPUT_FILE = "src/data/compliance/gdpr-clauses.json";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(raw) {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Converts one GDPR article page's HTML into the {standard, clauseId,
 * title, text, url} shape. Returns null for a 404 (some numbers may not
 * resolve - skipped, not fatal).
 */
async function fetchArticle(n) {
  const url = `${BASE_URL}/art-${n}-gdpr/`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetch failed for ${url} (HTTP ${res.status})`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const h1 = $("h1.entry-title").first();
  if (h1.length === 0) return null;

  const clauseId = h1.find(".dsgvo-number").text().replace(/\s+/g, " ").trim();
  const title = h1.find(".dsgvo-title").text().replace(/\s+/g, " ").trim();
  if (!title) return null;

  const parts = [];
  $(".entry-content")
    .children("ol, p, ul")
    .each((_i, el) => {
      const $el = $(el);
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "ol" || tag === "ul") {
        $el.find("li").each((_j, li) => {
          // Own text only - a parent <li> wrapping a nested <ol>/<ul> (e.g.
          // Art. 20's point 1 with sub-points (a)/(b)) would otherwise have
          // its .text() recurse into the nested items too, duplicating them
          // as their own separate parts right after. Also strip <sup>
          // sentence-citation markers (e.g. "<sup>1</sup>The exercise...",
          // "<sup>2</sup>That right...") - these pinpoint-cite individual
          // sentences for legal citation purposes, not list numbering; left
          // in, they read as stray "1"/"2" prefixes once flattened to text.
          const $li = $(li).clone();
          $li.find("ol, ul, sup").remove();
          const text = cleanText($li.text());
          if (text) parts.push(text);
        });
      } else {
        const $clone = $el.clone();
        $clone.find("sup").remove();
        const text = cleanText($clone.text());
        if (text) parts.push(text);
      }
    });

  const text = parts.join("\n");
  if (!text) return null;

  return {
    standard: "GDPR",
    clauseId: clauseId || `Art. ${n} GDPR`,
    title,
    text,
    url,
  };
}

/**
 * Reusable core: fetch every GDPR article, write the result to `outputFile`.
 *
 * @param {{outputFile: string}} params
 * @returns {Promise<{clauseCount: number, outputFile: string}>}
 */
async function scrapeGdprToChunks({ outputFile }) {
  console.log(`🚀 Fetching GDPR articles 1-${ARTICLE_COUNT} from ${BASE_URL}...`);
  const documents = [];
  for (let n = 1; n <= ARTICLE_COUNT; n++) {
    const doc = await fetchArticle(n);
    if (doc) {
      documents.push(doc);
      console.log(`   ✓ ${doc.clauseId}`);
    } else {
      console.log(`   ⚠️  Art. ${n} GDPR not found - skipped`);
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
  await scrapeGdprToChunks({ outputFile: OUTPUT_FILE });
}

module.exports = { scrapeGdprToChunks };

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}
