/* ==========================================================================
   create-eu-ai-act-embeddings.js — reads the clauses JSON produced by
   euAiActScraper.js, embeds each clause via Mistral, and upserts into the
   EU AI Act collection in the Compliance cluster - a SEPARATE Atlas
   account from Test Plan's (COMPLIANCE_MONGODB_URI, not MONGODB_URI). Thin
   wrapper around complianceIngest.js's shared ingestClausesToMongo() -
   same pattern as create-gdpr-embeddings.js, only the destination
   collection differs.
   ========================================================================== */

require("dotenv").config();
const { ingestClausesToMongo } = require("./complianceIngest");

const COMPLIANCE_MONGODB_URI = process.env.COMPLIANCE_MONGODB_URI || "";
const COMPLIANCE_DB_NAME = process.env.COMPLIANCE_DB_NAME || "";
const EU_AI_ACT_COLLECTION_NAME = process.env.EU_AI_ACT_COLLECTION_NAME || "euai";

const INPUT_FILE = "src/data/compliance/eu-ai-act-clauses.json";

async function main() {
  await ingestClausesToMongo({
    inputFile: INPUT_FILE,
    mongoUri: COMPLIANCE_MONGODB_URI,
    dbName: COMPLIANCE_DB_NAME,
    collectionName: EU_AI_ACT_COLLECTION_NAME,
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}
