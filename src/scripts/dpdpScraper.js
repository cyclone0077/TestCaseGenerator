/* ==========================================================================
   dpdpScraper.js — fetches every section of India's Digital Personal Data
   Protection Act, 2023 (dpdpa.com, Sec. 1-44) and writes one clause PER
   WHOLE SECTION (no sub-splitting) to a JSON file ready for the embeddings
   script. No Mongo/Mistral involved here — safe to re-run for free.

   Unlike gdprScraper.js/euAiActScraper.js, section URLs aren't a flat
   numeric range - they're nested under a chapter prefix that varies per
   section (e.g. chapter-5/section18.html), confirmed against the live
   site's own homepage nav. So this discovers the real section->URL mapping
   from the homepage first, then fetches each one - the same "discover via
   an index, don't guess" approach confluence-to-json.js uses, just via a
   plain nav-link scrape instead of an API.

   dpdpa.com uses the SAME page template/class names as gdpr-info.eu
   (dsgvo-number/dsgvo-title/.entry-content - confirmed against real pages
   for Sections 1, 18, and 44), plus one extra DPDP-specific block: an
   "Applicable DPDP Rule 2025" cross-reference paragraph inside
   .entry-content, filtered out the same way GDPR's Suitable Recitals are -
   only the operative Section text should be embedded.
   ========================================================================== */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const BASE_URL = "https://dpdpa.com";
const INDEX_URL = `${BASE_URL}/index.html`;
const REQUEST_DELAY_MS = 1000; // be polite to the server

const OUTPUT_FILE = "src/data/compliance/dpdp-clauses.json";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Discovers every chapter-N/sectionM.html link from the site's own nav,
 * returning URLs in section-number order. Confirmed against the live site:
 * all 44 sections (Sec. 1-44, chapters 1-9) are linked from the homepage.
 */
async function discoverSectionUrls() {
  const res = await fetch(INDEX_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Fetch failed for ${INDEX_URL} (HTTP ${res.status})`);

  const html = await res.text();
  const pattern = /https:\/\/(?:www\.)?dpdpa\.com\/dpdpa2023\/chapter-\d+\/section(\d+)\.html/g;
  const bySectionNumber = new Map();
  let match;
  while ((match = pattern.exec(html))) {
    bySectionNumber.set(Number(match[1]), match[0]);
  }

  return [...bySectionNumber.entries()].sort((a, b) => a[0] - b[0]).map(([, url]) => url);
}

function cleanText(raw) {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Converts one DPDP section page's HTML into the {standard, clauseId,
 * title, text, url} shape.
 */
async function fetchSection(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetch failed for ${url} (HTTP ${res.status})`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const clauseId = $(".dsgvo-number").first().text().replace(/\s+/g, " ").trim();
  const title = $(".dsgvo-title").first().text().replace(/\s+/g, " ").trim();
  if (!title) return null;

  const parts = [];
  $(".entry-content")
    .children("ol, p, ul")
    .each((_i, el) => {
      const $el = $(el);
      // "Applicable DPDP Rule 2025" cross-reference block - not part of the
      // Act's own text, same reasoning as GDPR's Suitable Recitals filter.
      if (/^applicable dpdp rule/i.test($el.text().trim())) return;

      const tag = (el.tagName || "").toLowerCase();
      if (tag === "ol" || tag === "ul") {
        $el.find("li").each((_j, li) => {
          // Own text only - a parent <li> wrapping a nested <ol>/<ul> would
          // otherwise have its .text() recurse into the nested items too,
          // duplicating them as their own separate parts right after (same
          // issue confirmed on gdpr-info.eu, which shares this template).
          // Also strip <sup> sentence-citation markers - see gdprScraper.js.
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
    standard: "DPDP",
    clauseId: clauseId || url,
    title,
    text,
    url,
  };
}

/**
 * Reusable core: fetch every DPDP section, write the result to `outputFile`.
 *
 * @param {{outputFile: string}} params
 * @returns {Promise<{clauseCount: number, outputFile: string}>}
 */
async function scrapeDpdpToChunks({ outputFile }) {
  console.log(`🚀 Discovering DPDP section URLs from ${INDEX_URL}...`);
  const urls = await discoverSectionUrls();
  console.log(`   Found ${urls.length} section(s)`);

  const documents = [];
  for (let i = 0; i < urls.length; i++) {
    const doc = await fetchSection(urls[i]);
    if (doc) {
      documents.push(doc);
      console.log(`   ✓ ${doc.clauseId}`);
    } else {
      console.log(`   ⚠️  ${urls[i]} not found/empty - skipped`);
    }
    if (i < urls.length - 1) await sleep(REQUEST_DELAY_MS);
  }
  console.log(`📦 Produced ${documents.length} clause document(s)`);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(documents, null, 2), "utf-8");
  console.log(`✅ Wrote ${documents.length} clauses to ${outputFile}`);

  return { clauseCount: documents.length, outputFile };
}

async function main() {
  await scrapeDpdpToChunks({ outputFile: OUTPUT_FILE });
}

module.exports = { scrapeDpdpToChunks };

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}
