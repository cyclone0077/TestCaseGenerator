# Test Case Generator

A custom chat UI that calls the Langflow REST API directly to turn user
stories or PRD files into structured, execution-ready test cases, with a
Jira Connector that imports a ticket's Summary/Description/Acceptance
Criteria to seed generation. A separate **Knowledge Search** mode answers
questions from Confluence Test Plan docs (real hybrid search: BM25 +
vector, synthesized chat answer) or maps a user story to the most relevant
GDPR/EU AI Act/DPDP clauses (vector search + LLM reranking, rendered as a
ranked-matches table) — via MongoDB Atlas, independent of Langflow.

Frontend: vanilla HTML/CSS/JS, no build step (in `public/`).
Backend: a small Express server (`server.js`) that serves the frontend,
proxies Jira Cloud so the browser never holds a Jira API token, and exposes
the Knowledge Search RAG endpoint (`src/scripts/`).

**New to this codebase?** [docs/scraping-pipeline-explained.html](docs/scraping-pipeline-explained.html)
walks through how the Compliance scraping → Cheerio parsing → embedding →
MongoDB ingestion pipeline actually works end to end, with a diagram and
real code from this repo — open it directly in a browser.

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
flow used by the other 3 modes. Four sources are wired up so far, selected
via a dropdown in the Knowledge panel (Test Cases and PRD are shown as
"coming soon" - Test Cases was removed along with its backing collection;
PRD is planned but not built as a distinct source yet):

| Source | Backing data | Search type | Output |
|---|---|---|---|
| **Test Plan** | Confluence pages, ingested by the scripts below (or the in-app Ingestion panel) | Real hybrid search — BM25 + vector, combined via Reciprocal Rank Fusion | Synthesized chat answer + source citations |
| **GDPR** | Every GDPR article (gdpr-info.eu, Art. 1-99), one embedding per whole article, stored in a **separate** MongoDB Atlas cluster/account | Vector search + LLM reranking | Ranked list of matching clauses |
| **EU AI Act** | Every EU AI Act article (artificialintelligenceact.eu, Art. 1-113), one embedding per whole article, same separate cluster (different collection) | Vector search + LLM reranking | Ranked list of matching clauses |
| **DPDP** | Every section of India's Digital Personal Data Protection Act, 2023 (dpdpa.com, Sec. 1-44), same separate cluster (different collection) | Vector search + LLM reranking | Ranked list of matching clauses — **disabled in the dropdown for now**: ingested, but its Atlas index isn't created yet (see below) |

GDPR/EU AI Act/DPDP answer a different kind of question than Test Plan:
given a user story/requirement (not a question), they return the most
relevant legal clauses (e.g. "GDPR Art. 17 — Right to erasure") instead of a
synthesized prose answer — so testers/analysts can map a story to its
compliance obligations. Reranking reuses whichever chat model
`CHAT_MODEL_PROVIDER` already selects (Mistral or Gemini) rather than adding
a new LLM provider just for this step.

The Compliance standards use their own Mongo cluster because Atlas caps how
many search indexes a single (especially free-tier) cluster can hold — Test
Plan's cluster is already at that limit; GDPR/EU AI Act/DPDP share this one
new cluster, just in separate collections/indexes — though that cluster has
its own cap too: it's currently maxed out at 2 indexes (`gdpr_index` +
`euai_index`), which is why DPDP's `dpdp_index` hasn't been created (its
data is fully ingested and ready the moment there's room - a tier upgrade
or another separate cluster, same reasoning as Test Plan's own split).
All sources stay connected at the same time regardless; there's no toggle
to flip between them, each Knowledge Search request just picks the right
one based on the selected source.

Intermediate scrape/chunk output is split by source under `src/data/`:
`src/data/confluence/` for Confluence-fetched files, `src/data/compliance/`
for GDPR/EU AI Act/DPDP clause files (both gitignored, regenerated by
re-running the relevant script).

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

# Compliance: GDPR + EU AI Act + DPDP (vector-only, LLM-reranked) - a
# DIFFERENT Atlas cluster/account, shared by all three in separate collections
COMPLIANCE_MONGODB_URI=mongodb+srv://user:pass@another-cluster.mongodb.net/
COMPLIANCE_DB_NAME=your_db_name
GDPR_COLLECTION_NAME=gdpr
GDPR_VECTOR_INDEX_NAME=gdpr_index
EU_AI_ACT_COLLECTION_NAME=euai
EU_AI_ACT_VECTOR_INDEX_NAME=euai_index
DPDP_COLLECTION_NAME=dpdp
DPDP_VECTOR_INDEX_NAME=dpdp_index
COMPLIANCE_VECTOR_DIMENSIONS=1024
COMPLIANCE_INGEST_BATCH_SIZE=20
COMPLIANCE_TOP_K=10

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

**GDPR / EU AI Act / DPDP setup:**
- In the **separate** MongoDB Atlas cluster/account pointed to by
  `COMPLIANCE_MONGODB_URI`, each collection needs a **Vector Search** index
  with TWO filter fields nested under `metadata` (not top-level) - matching
  what `complianceIngest.js` actually stores:
  ```json
  { "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
    { "type": "filter", "path": "metadata.standard" },
    { "type": "filter", "path": "metadata.clauseId" }
  ] }
  ```
  One index per standard, named to match `GDPR_VECTOR_INDEX_NAME` /
  `EU_AI_ACT_VECTOR_INDEX_NAME` / `DPDP_VECTOR_INDEX_NAME` on their
  respective collections. No BM25 index needed — all three are vector-only.
  Compliance ingestion/retrieval use the native `mongodb` driver directly
  (not LangChain's vector-store abstraction, which would flatten metadata
  onto top-level fields instead and not match this index) - create/update
  all three in one step instead of doing it by hand in the Atlas UI:
  ```bash
  npm run create-compliance-indexes
  ```
  Safe to re-run: skips an index that already matches the spec, updates one
  in place if it exists but doesn't match, otherwise creates it. Atlas caps
  how many search indexes a cluster/tier can hold, so this may fail for a
  4th index until there's room (tier upgrade or another cluster) - the
  other indexes it already handled aren't affected.
- Each scraper fetches every article/section of its source directly (GDPR/
  EU AI Act by numeric URL, DPDP by discovering the real section->URL
  mapping from the site's own nav first, since its URLs nest under a
  chapter prefix that isn't a guessable flat range) — no config needed
  beyond the Mongo/Mistral vars above.
- Run the ingestion for each (safe to re-run whenever the source text
  changes — embedding is idempotent by `clauseId`, upserted in batches of
  `COMPLIANCE_INGEST_BATCH_SIZE`, so re-running never duplicates clauses):
  ```bash
  node src/scripts/gdprScraper.js               # fetch Art. 1-99 -> src/data/compliance/gdpr-clauses.json
  node src/scripts/create-gdpr-embeddings.js     # embed (Mistral) + upsert into the Compliance cluster

  node src/scripts/euAiActScraper.js             # fetch Art. 1-113 -> src/data/compliance/eu-ai-act-clauses.json
  node src/scripts/create-eu-ai-act-embeddings.js # embed (Mistral) + upsert into the Compliance cluster

  node src/scripts/dpdpScraper.js                # fetch Sec. 1-44 -> src/data/compliance/dpdp-clauses.json
  node src/scripts/create-dpdp-embeddings.js      # embed (Mistral) + upsert into the Compliance cluster
  ```
  Or use the in-app **Ingestion** panel instead — Step 1 offers Confluence
  vs. Compliance as two source cards; picking Compliance shows GDPR/EU AI
  Act/DPDP as three cards in place of the Confluence-only Page ID field.
- Each scraper fetches sequentially with a 1s delay between requests
  (considerate of the source sites, not a burst of 44-113 concurrent
  requests) - expect it to take a minute or two per source.
- Retrieval scores every vector-search candidate via LLM reranking (0-1
  relevance), reordering by that score — nothing is dropped for a low
  score, so `matches` always returns up to `COMPLIANCE_TOP_K` results per
  query.

**Troubleshooting a Mongo TLS/connection error** (`SSL routines:ssl3_read_bytes:tlsv1 alert internal error`,
or ingestion/retrieval just hanging): almost always one of these, roughly in
order of likelihood -
- **Your public IP isn't (or no longer is) in Atlas's Network Access list.**
  Corporate NAT/VPN gateways rotate the egress IP more often than you'd
  expect - if it worked before and now doesn't with zero code changes,
  check Atlas → Security → Network Access → IP Access List first. Atlas's
  own UI will show a banner ("Current IP Address not added...") if this is
  it, and adding the current IP fixes it immediately - no restart needed.
- **DNS_SERVERS is set but the app hasn't picked it up.** `dns.setServers()`
  alone only redirects the SRV/TXT lookup that discovers a replica set's
  member hostnames - the actual TCP/TLS connection to each discovered host
  still goes through `dns.lookup()`, which keeps using the OS/VPN resolver
  unless separately patched. `dnsOverride.js` does both; if you're seeing
  this on a VPN that mangles DNS, make sure whatever script/module you're
  running actually calls `applyDnsOverride()` (all the Compliance
  scripts/retrievers do, `create-testplan-embeddings.js` only calls
  `dns.setServers()` directly since Test Plan's cluster hasn't needed the
  fuller patch).
- **The running server process is stale.** Node caches `require()`'d
  modules in memory - editing a file on disk doesn't affect a server
  that's already running. If a fix "isn't taking effect," restart the
  server (`lsof -i :8000` to find the PID, kill it, `node server.js` again)
  before assuming the code is wrong.

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
| Knowledge Search | Ask Test Plan questions (real hybrid BM25+vector search, synthesized answer + citations) or map a user story to GDPR/EU AI Act/DPDP clauses (vector search + LLM reranking, rendered as a table — clause / relevance score / excerpt / source link, reusing the same table UI as generated test cases) — independent of Langflow |
| Markdown rendering | Tables, headers, bold, italic, code blocks |
| Sample stories | Banking, Insurance, Finance cards to fill input |
| Dark / Light mode | Persisted in localStorage; follows system preference |
| Clear chat | Resets session with confirmation |
| Copy message | Per-bubble copy button (raw markdown) |
| Copy all | Copies all assistant responses |
| Export Excel | Parses last table → `TestCases_<date>.xlsx` |
| Status bar | Shows target URL, model override, last response time |
