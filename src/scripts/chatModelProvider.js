/* ==========================================================================
   chatModelProvider.js — shared chat-model factory for the Knowledge Search
   sources (Test Plan, GDPR, EU AI Act). CHAT_MODEL_PROVIDER selects which
   provider handles answer generation, follow-up reformulation, and (for
   GDPR/EU AI Act) clause reranking.

   Embeddings are NOT part of this switch and stay hardcoded to Mistral
   everywhere else (MistralAIEmbeddings, in every retriever file) - the
   stored corpus was embedded with Mistral's model, and a Mistral-embedded
   query has to stay Mistral-embedded too for vector search to mean anything.
   Only the steps that read/write text AFTER retrieval already succeeded -
   answer synthesis, query reformulation, clause reranking - are provider-
   agnostic enough to switch.
   ========================================================================== */

const { ChatMistralAI } = require("@langchain/mistralai");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");

const CHAT_MODEL_PROVIDER = (process.env.CHAT_MODEL_PROVIDER || "mistral").toLowerCase();

/**
 * Builds a fresh chat model instance per call - construction is cheap and
 * synchronous (no network call happens until something actually invokes the
 * model), so callers are free to cache the result themselves if they want a
 * singleton, same as before this factory existed.
 *
 * @param {{temperature?: number, maxTokens?: number}} options
 */
function createChatModel({ temperature = 0.2, maxTokens } = {}) {
  if (CHAT_MODEL_PROVIDER === "gemini") {
    return new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
      // "gemini-flash-latest" is an alias that always resolves to Google's
      // current recommended flash-tier model - confirmed necessary the hard
      // way: a pinned version ("gemini-2.5-flash") returned a live HTTP 404
      // "no longer available to new users" the first time this was tested.
      model: process.env.GEMINI_CHAT_MODEL || "gemini-flash-latest",
      temperature,
      maxOutputTokens: maxTokens,
    });
  }

  return new ChatMistralAI({
    apiKey: process.env.MISTRAL_API_KEY,
    model: process.env.MISTRAL_CHAT_MODEL || "mistral-small-latest",
    temperature,
    maxTokens,
  });
}

module.exports = { createChatModel, CHAT_MODEL_PROVIDER };
