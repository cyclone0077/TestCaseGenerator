# Test Case Generator

A custom chat UI that calls the Langflow REST API directly to turn user
stories or PRD files into structured, execution-ready test cases, with a
Jira Connector that imports a ticket's Summary/Description/Acceptance
Criteria to seed generation. A separate **Knowledge Search** mode answers
questions directly from your org's own data — Confluence Test Plan docs
(vector search) or an existing test case repository (real hybrid search:
BM25 + vector) — via MongoDB Atlas, independent of Langflow, with source
citations.

Frontend: vanilla HTML/CSS/JS, no build step (in `public/`).
Backend: a small Express server (`server.js`) that serves the frontend,
proxies Jira Cloud so the browser never holds a Jira API token, and exposes
the Knowledge Search RAG endpoint (`src/scripts/`).

## Setup

### 1. Install dependencies

```bash
cd /path/to/CustomChatUI
npm install
```

### 2. Configure the frontend

Copy `public/config.example.js` to `public/config.js` and fill in your values:

```js
const CONFIG = {
  BASE_URL: "http://localhost:7860",     // your Langflow server
  FLOW_ID: "your-flow-id",              // from the flow's URL in Langflow
  API_KEY: "your-api-key",              // Langflow API key
  MODEL_TWEAKS: {},                      // optional component overrides
  FILE_COMPONENT_ID: "File-AbC12",      // see step below
  PREFETCHED_STORY_COMPONENT_ID: ""     // see Jira Connector step below
};
```

**Finding `FILE_COMPONENT_ID`:** In Langflow, open your flow, click the
**File** component, and copy its component ID from the component header or
settings panel (e.g. `File-AbC12`).

**Finding `PREFETCHED_STORY_COMPONENT_ID`:** points at a text-input
component in your flow that receives the composed Jira story (Generate
sends it via `tweaks`, not the chat message). Click that component in
Langflow and copy its ID (e.g. `TextInput-xYz89`). If left blank, it's
auto-discovered from the flow definition by matching a node whose type/id
contains "prefetched-story" or "text-input".

`public/config.js` is gitignored — never commit real API keys.

### 3. Configure the Jira proxy

Copy `.env.example` to `.env` and fill in your Jira Cloud details:

```
PORT=8000
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@yourcompany.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_AC_FIELD_ID=customfield_10105
```

- Create an API token at
  https://id.atlassian.com/manage-profile/security/api-tokens
- `JIRA_AC_FIELD_ID` is the custom field holding Acceptance Criteria on your
  tickets (standard Jira has no built-in AC field). Find its ID via
  `GET {JIRA_BASE_URL}/rest/api/3/field` and search the response for its
  display name. Leave blank to skip fetching Acceptance Criteria.

`.env` is gitignored — never commit real Jira credentials.

### 4. Configure Knowledge Search (Test Plan RAG)

This is a separate pipeline from Langflow: source content is embedded into
MongoDB Atlas once (offline, or via the in-app Ingestion panel), then
queried at chat time — the Knowledge Search mode never touches the Langflow
flow used by the other 3 modes. One source is wired up so far, selected via
a dropdown in the Knowledge panel (Test Cases and PRD are shown as "coming
soon" - Test Cases was removed along with its backing collection; PRD is
planned but not built as a distinct source yet):

| Source | Backing data | Search type |
|---|---|---|
| **Test Plan** | Confluence pages, ingested by the scripts below (or the in-app Ingestion panel) | Real hybrid search — BM25 + vector, combined via Reciprocal Rank Fusion |

Add to the same `.env`:

```
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/
DB_NAME=your_db_name

# Test Plan (Confluence-backed, hybrid search)
TESTPLAN_COLLECTION_NAME=test_plans
TESTPLAN_VECTOR_INDEX_NAME=vector_index_test_plans
TESTPLAN_BM25_INDEX_NAME=bm25_search_test_plans
CONFLUENCE_BASE_URL=https://yourcompany.atlassian.net
CONFLUENCE_EMAIL=you@yourcompany.com
CONFLUENCE_API_TOKEN=your-confluence-api-token
TESTPLAN_ROOT_PAGE_ID=root-page-id-of-your-test-plan-folder

MISTRAL_API_KEY=your-mistral-api-key
```

**Test Plan setup:**
- In MongoDB Atlas, create a **Vector Search** index named to match
  `TESTPLAN_VECTOR_INDEX_NAME` on the `test_plans` collection: a `vector`
  field on `embedding` (1024 dimensions, cosine similarity), plus `docType`
  and `pageId` as `filter` fields.
- Create an **Atlas Search** (BM25) index named to match
  `TESTPLAN_BM25_INDEX_NAME` on the same collection, mapping `title` and
  `text` as `string` fields:
  ```json
  { "mappings": { "dynamic": false, "fields": {
    "title": { "type": "string" }, "text": { "type": "string" }
  } } }
  ```
- Create a Confluence API token at the same
  [Atlassian token page](https://id.atlassian.com/manage-profile/security/api-tokens)
  used for Jira above.
- `TESTPLAN_ROOT_PAGE_ID` scopes ingestion to one Confluence page's
  descendant subtree (e.g. a "Test Plan" folder), not the whole space —
  find it in that page's URL.
- Run the one-time ingestion (safe to re-run whenever the Confluence docs
  change — embedding is idempotent by page, so re-running never duplicates
  chunks), or use the in-app **Ingestion** panel instead:
  ```bash
  node src/scripts/confluence-to-json.js        # fetch + convert + chunk -> src/data/testplan-chunks.json
  node src/scripts/create-testplan-embeddings.js # embed (Mistral) + store in MongoDB
  ```
- Verify completeness afterward (cross-checks Mongo against the live
  Confluence page list — coverage gaps, chunk-sequence gaps, duplicates,
  malformed embeddings):
  ```bash
  node src/scripts/validate-testplan-embeddings.js
  ```

### 5. Start Langflow

```bash
python -m langflow run
# or: langflow run --host 0.0.0.0 --port 7860
```

### 6. Start the app server

```bash
npm start
```

This serves the frontend AND the `/api/jira/:ticketId` and
`/api/knowledge/query` routes on one port — no separate static file server,
no CORS setup needed. Open `http://localhost:8000` (or your configured
`PORT`) in your browser.

## Features

| Feature | Details |
|---|---|
| Text mode | Type any user story and send |
| File mode | Attach a PDF (paperclip or drag-and-drop) |
| Jira Connector | Fetch Summary/Description/Acceptance Criteria from a Jira ticket ID via the Express proxy, edit them, then generate test cases |
| Knowledge Search | Ask questions answered from your org's own data (Confluence Test Plans via vector search, or an existing test case repository via real hybrid BM25+vector search) — independent of Langflow, with source citations |
| Markdown rendering | Tables, headers, bold, italic, code blocks |
| Sample stories | Banking, Insurance, Finance cards to fill input |
| Dark / Light mode | Persisted in localStorage; follows system preference |
| Clear chat | Resets session with confirmation |
| Copy message | Per-bubble copy button (raw markdown) |
| Copy all | Copies all assistant responses |
| Export Excel | Parses last table → `TestCases_<date>.xlsx` |
| Status bar | Shows target URL, model override, last response time |
