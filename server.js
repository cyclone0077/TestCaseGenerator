/* ==========================================================================
   server.js — static file server + Jira fetch proxy.
   Serves the frontend from public/ and exposes GET /api/jira/:ticketId,
   which calls Jira Cloud's REST API server-side so the Jira API token
   never reaches the browser and the frontend never talks to Jira directly.
   ========================================================================== */

require("dotenv").config();
const express = require("express");
const path = require("path");
const { queryTestPlan } = require("./src/scripts/testplanRetriever");
const { listChunkFiles, runFetch, runEmbed } = require("./src/scripts/ingestionAdmin");

const app = express();
const PORT = process.env.PORT || 8000;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_AC_FIELD_ID = process.env.JIRA_AC_FIELD_ID || "";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---- Atlassian Document Format (ADF) -> plain text -------------------------
// Jira Cloud's REST API v3 returns rich-text fields (description, and any
// rich-text custom field) as an ADF node tree instead of a plain string.
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;

  const children = Array.isArray(node.content)
    ? node.content.map(adfToText).join("")
    : "";

  switch (node.type) {
    case "text":
      return node.text || "";
    case "paragraph":
    case "heading":
      return children + "\n";
    case "hardBreak":
      return "\n";
    case "listItem":
      return "- " + children.trim() + "\n";
    case "doc":
      return children.trim();
    default:
      return children;
  }
}

// Jira fields can come back as a plain string, an ADF doc, a single-select
// object ({ value: "..." }), or an array of any of those (multi-select /
// checkboxes). Normalize whatever shows up to plain text.
function fieldToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(fieldToText).filter(Boolean).join("\n");
  if (value.type === "doc") return adfToText(value);
  if (typeof value.value === "string") return value.value;
  return "";
}

app.get("/api/jira/:ticketId", async (req, res) => {
  const ticketId = req.params.ticketId.trim();
  if (!ticketId) return res.status(400).send("Missing Jira ticket ID.");

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).send(
      "Jira proxy is not configured. Copy .env.example to .env and fill in " +
      "JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN."
    );
  }

  const fields = ["summary", "description"];
  if (JIRA_AC_FIELD_ID) fields.push(JIRA_AC_FIELD_ID);

  const url =
    JIRA_BASE_URL.replace(/\/$/, "") +
    "/rest/api/3/issue/" + encodeURIComponent(ticketId) +
    "?fields=" + fields.join(",");

  const auth = Buffer.from(JIRA_EMAIL + ":" + JIRA_API_TOKEN).toString("base64");

  let jiraRes;
  try {
    jiraRes = await fetch(url, {
      headers: { Authorization: "Basic " + auth, Accept: "application/json" },
    });
  } catch (e) {
    return res.status(502).send("Could not reach Jira at " + JIRA_BASE_URL + ".");
  }

  if (jiraRes.status === 404) {
    return res.status(404).send("Jira ticket " + ticketId + " not found.");
  }
  if (jiraRes.status === 401 || jiraRes.status === 403) {
    return res.status(502).send(
      "Jira authentication failed — check JIRA_EMAIL and JIRA_API_TOKEN in .env."
    );
  }
  if (!jiraRes.ok) {
    const detail = await jiraRes.text().catch(function () { return ""; });
    return res.status(502).send("Jira API error (HTTP " + jiraRes.status + "): " + detail);
  }

  const issue = await jiraRes.json();
  const issueFields = issue.fields || {};

  res.json({
    id: issue.key || ticketId,
    summary: fieldToText(issueFields.summary),
    description: fieldToText(issueFields.description),
    acceptanceCriteria: JIRA_AC_FIELD_ID ? fieldToText(issueFields[JIRA_AC_FIELD_ID]) : "",
  });
});

// Knowledge search (4th input): RAG over the org's own content, independent
// of the Langflow flow used by the other 3 input modes. "testcases" and
// "prd" are not wired up - the Test Cases collection was removed (shown as
// "coming soon" in the dropdown, matching PRD's not-yet-built state).
const KNOWLEDGE_SOURCES = {
  testplan: queryTestPlan,
};

app.post("/api/knowledge/query", async function (req, res) {
  const source = (req.body && req.body.source) || "";
  const query = (req.body && req.body.query || "").trim();
  // Optional - a separate session concept from the Langflow modes' session_id
  // (see public/app.js). Omitted entirely = stateless, same as Phase 1.
  const sessionId = (req.body && req.body.sessionId) || undefined;

  if (!query) return res.status(400).json({ error: "Missing query." });

  const handler = KNOWLEDGE_SOURCES[source];
  if (!handler) {
    return res.status(400).json({ error: "Unsupported source: " + source + ". Available: " + Object.keys(KNOWLEDGE_SOURCES).join(", ") + "." });
  }

  try {
    const result = await handler(query, sessionId);
    res.json(result);
  } catch (err) {
    console.error("Knowledge query failed:", err.message);
    res.status(502).json({ error: "Knowledge query failed: " + err.message });
  }
});

// Ingestion admin panel: run the Confluence fetch -> chunk -> embed pipeline
// from the browser instead of the CLI scripts directly. Wraps the same
// reusable functions the CLI scripts call themselves (see ingestionAdmin.js)
// - a source and its destination collection/index are form input here
// instead of hardcoded env vars.
app.get("/api/admin/ingest/files", function (req, res) {
  try {
    res.json({ files: listChunkFiles() });
  } catch (err) {
    console.error("Listing chunk files failed:", err.message);
    res.status(500).json({ error: "Listing chunk files failed: " + err.message });
  }
});

app.post("/api/admin/ingest/fetch", async function (req, res) {
  const { pageId, mode, sourceName } = req.body || {};
  try {
    const result = await runFetch({ pageId, mode, sourceName });
    res.json(result);
  } catch (err) {
    console.error("Ingestion fetch failed:", err.message);
    res.status(400).json({ error: "Ingestion fetch failed: " + err.message });
  }
});

app.post("/api/admin/ingest/embed", async function (req, res) {
  const { fileName, collectionName, indexName } = req.body || {};
  try {
    const result = await runEmbed({ fileName, collectionName, indexName });
    res.json(result);
  } catch (err) {
    console.error("Ingestion embed failed:", err.message);
    res.status(400).json({ error: "Ingestion embed failed: " + err.message });
  }
});

app.listen(PORT, function () {
  console.log("Test Case Generator running at http://localhost:" + PORT);
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.warn("Jira proxy not configured — copy .env.example to .env and fill in Jira credentials.");
  }
});
