/* ==========================================================================
   complianceIngest.js — shared ingestion core for the Compliance sources
   (GDPR, EU AI Act): reads a scraped clauses JSON file, embeds each clause
   (title + text, batched) via Mistral, and upserts into the given
   Compliance-cluster collection by clauseId.

   Ported to match the reference Compliance Coverage Agent's
   ingestion/gdprIngestion.ts + ingestion/euAiIngestion.ts exactly: uses the
   native mongodb driver directly (bulkWrite upsert), NOT the LangChain
   vector-store abstraction, because the Atlas vector index already created
   for these collections expects metadata.standard/metadata.clauseId as
   NESTED filter paths - LangChain's MongoDBAtlasVectorSearch.fromDocuments()
   (used by create-testplan-embeddings.js) instead flattens metadata onto
   top-level fields, which wouldn't match that index definition.

   Stored document shape mirrors the reference's ClauseDocument exactly:
   top-level standard/clauseId/title/text/url/embedding PLUS a nested
   metadata object (redundant with the top-level fields, but that's what the
   vector index's filter paths point at), createdAt/updatedAt.

   gdprIngestion.ts and euAiIngestion.ts in the reference are two
   near-identical per-standard files; this factors the shared logic into
   one function instead, consistent with this codebase's existing
   "reusable core + thin per-source wrapper" pattern (see
   create-testplan-embeddings.js).
   ========================================================================== */

require("dotenv").config();
const fs = require("fs");
const { MongoClient } = require("mongodb");
const { MistralAIEmbeddings } = require("@langchain/mistralai");
const { applyDnsOverride } = require("./dnsOverride");

applyDnsOverride();

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const MISTRAL_EMBEDDING_MODEL = process.env.MISTRAL_EMBEDDING_MODEL || "mistral-embed";
const COMPLIANCE_VECTOR_DIMENSIONS = Number(process.env.COMPLIANCE_VECTOR_DIMENSIONS) || 1024;
const COMPLIANCE_INGEST_BATCH_SIZE = Number(process.env.COMPLIANCE_INGEST_BATCH_SIZE) || 20;

const embeddings = new MistralAIEmbeddings({ apiKey: MISTRAL_API_KEY, model: MISTRAL_EMBEDDING_MODEL });

async function embedTexts(texts) {
  const vectors = await embeddings.embedDocuments(texts);
  vectors.forEach((vector) => {
    if (vector.length !== COMPLIANCE_VECTOR_DIMENSIONS) {
      throw new Error(`Embedding dimension mismatch: expected ${COMPLIANCE_VECTOR_DIMENSIONS}, got ${vector.length}`);
    }
  });
  return vectors;
}

/**
 * @param {{inputFile: string, mongoUri: string, dbName: string, collectionName: string}} params
 * @returns {Promise<{inserted: number, updated: number}>}
 */
async function ingestClausesToMongo({ inputFile, mongoUri, dbName, collectionName }) {
  if (!mongoUri) throw new Error("Missing Compliance Mongo URI (COMPLIANCE_MONGODB_URI).");
  if (!dbName) throw new Error("Missing Compliance DB name (COMPLIANCE_DB_NAME).");
  if (!MISTRAL_API_KEY) throw new Error("Missing required .env var: MISTRAL_API_KEY");
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}. Run the matching scraper first.`);
  }

  const clauses = JSON.parse(fs.readFileSync(inputFile, "utf-8"));

  const client = new MongoClient(mongoUri);
  await client.connect();
  const collection = client.db(dbName).collection(collectionName);

  let inserted = 0;
  let updated = 0;

  try {
    for (let i = 0; i < clauses.length; i += COMPLIANCE_INGEST_BATCH_SIZE) {
      const batch = clauses.slice(i, i + COMPLIANCE_INGEST_BATCH_SIZE);
      console.log(`🚀 Ingesting batch ${i / COMPLIANCE_INGEST_BATCH_SIZE + 1} (${batch.length} clause(s)) into ${collectionName}...`);

      // Embed title+text together (not text alone) - matches the reference
      // exactly, so a title-heavy query (e.g. quoting a clause's own name)
      // isn't invisible to the embedding.
      const vectors = await embedTexts(batch.map((c) => `${c.title}\n${c.text}`));

      const now = new Date();
      const ops = batch.map((clause, idx) => ({
        updateOne: {
          filter: { clauseId: clause.clauseId },
          update: {
            $set: {
              standard: clause.standard,
              clauseId: clause.clauseId,
              title: clause.title,
              text: clause.text,
              url: clause.url,
              embedding: vectors[idx],
              metadata: { standard: clause.standard, clauseId: clause.clauseId },
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          upsert: true,
        },
      }));

      const result = await collection.bulkWrite(ops);
      inserted += result.upsertedCount;
      updated += result.modifiedCount;
    }

    console.log(`🎉 Done. inserted=${inserted} updated=${updated}`);
    return { inserted, updated };
  } finally {
    await client.close();
  }
}

module.exports = { ingestClausesToMongo };
