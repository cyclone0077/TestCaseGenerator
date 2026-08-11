/* ==========================================================================
   confluenceStorageToText.js — Confluence storage format -> plain text.
   Confluence Cloud's `body.storage.value` is well-formed XML with custom
   ac:/ri: namespaced macro tags (images, user mentions, page links, task
   lists) mixed in with standard HTML (headings, tables, lists). Macros are
   unwrapped via a real DOM (cheerio) so each replacement is scoped to its
   own element — regex can't safely pair repeated/nested custom tags and
   will silently swallow unrelated content between two occurrences.
   ========================================================================== */

const { htmlToText } = require("html-to-text");
const cheerio = require("cheerio");

function unwrapMacros(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });

  // Images carry no useful text for retrieval - drop entirely.
  $("ac\\:image").remove();

  // Task list items -> "[ ] body text" / "[x] body text", one per task.
  $("ac\\:task").each((_, el) => {
    const $el = $(el);
    const status = $el.find("ac\\:task-status").text().trim();
    const body = $el.find("ac\\:task-body").text().trim();
    const box = status === "complete" ? "[x]" : "[ ]";
    $el.replaceWith(`<p>${box} ${body}</p>`);
  });
  $("ac\\:task-list").each((_, el) => {
    // Children were already replaced with <p> above; unwrap the wrapper itself.
    $(el).replaceWith($(el).html() || "");
  });

  // Links with visible body text (internal page/attachment links) -> keep the
  // body text only. Links with no body (bare user/page mentions) -> no useful
  // text, remove entirely. Each <ac:link> is handled within its own boundary.
  $("ac\\:link").each((_, el) => {
    const $el = $(el);
    const bodyText = $el.find("ac\\:link-body").text().trim();
    $el.replaceWith(bodyText);
  });

  // Inline comment markers wrap text purely for annotation - keep the text.
  $("ac\\:inline-comment-marker").each((_, el) => {
    $(el).replaceWith($(el).text());
  });

  // Self-closing date macro -> just the date string.
  $("time").each((_, el) => {
    $(el).replaceWith($(el).attr("datetime") || "");
  });

  // Jira macro ("Epic Link" / linked issue) - extract just the issue key,
  // dropping the internal macro-id/server parameters that would otherwise
  // run straight into it with no separator (confirmed against real data: a
  // PRD's Epic Link rendered as "RGP-4060e60d0fb9-daf7-...System Jira" -
  // noise that diluted that chunk's embedding enough for it to lose a
  // retrieval race to unrelated content, even for a query almost quoting
  // the chunk's own heading).
  $('ac\\:structured-macro[ac\\:name="jira"]').each((_, el) => {
    const $el = $(el);
    const key = $el.find('ac\\:parameter[ac\\:name="key"]').text().trim();
    $el.replaceWith(key ? `Jira: ${key}` : "");
  });

  // Catch-all: any remaining ac:/ri: elements (attachments, unknown macros) -
  // unwrap keeping their text, so nothing silently vanishes. Confluence's
  // storage XML has no whitespace between sibling tags, and .text() alone
  // concatenates every descendant text node with no separator - for a macro
  // with multiple parameters (title + body, key + server, etc.) that glues
  // unrelated values together into one unreadable run-on. Join each direct
  // child's own text with a space instead, so multi-parameter macros stay
  // readable; falls back to plain .text() for macros with no child elements.
  $("*").each((_, el) => {
    const tagName = el.tagName || el.name || "";
    if (/^(ac|ri):/i.test(tagName)) {
      const $el = $(el);
      const children = $el.children().toArray();
      const text = children.length
        ? children.map((child) => $(child).text().trim()).filter(Boolean).join(" ")
        : $el.text();
      $el.replaceWith(text);
    }
  });

  return $.html();
}

/**
 * @param {string} storageValue - raw body.storage.value from a Confluence page
 * @returns {string} plain text, headings/tables/lists preserved as readable text
 */
function confluenceStorageToText(storageValue) {
  if (!storageValue) return "";

  const cleaned = unwrapMacros(storageValue);

  const text = htmlToText(cleaned, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "table", format: "dataTable" },
    ],
  });

  // html-to-text's dataTable formatter doesn't decode entities inside cells
  // (confirmed against real data: &nbsp; leaks through as literal text) -
  // decode the common ones by hand since this is the only place it happens.
  const decoded = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Collapse the runs of blank lines html-to-text tends to leave behind.
  // (Deliberately NOT collapsing repeated spaces/tabs - the dataTable
  // formatter uses multi-space runs as column separators; collapsing them
  // would merge table labels and values into unreadable run-ons.)
  return decoded.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { confluenceStorageToText };
