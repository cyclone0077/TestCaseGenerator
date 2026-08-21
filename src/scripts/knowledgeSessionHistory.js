/* ==========================================================================
   knowledgeSessionHistory.js — conversational-memory building blocks for
   Knowledge Search sources that hold a real back-and-forth conversation
   (currently just Test Plan). GDPR/EU AI Act don't use this - they're
   stateless one-shot "map this story to clauses" lookups, not a
   conversation, so there's no history to reformulate against.
   ========================================================================== */

const { InMemoryChatMessageHistory } = require("@langchain/core/chat_history");
const { ChatPromptTemplate, MessagesPlaceholder } = require("@langchain/core/prompts");
const { createHistoryAwareRetriever } = require("@langchain/classic/chains/history_aware_retriever");

// One history per Knowledge Search session - in-memory, lost on server
// restart. Deliberately simple for now (per the phased plan); a persistent
// store would be a drop-in replacement for this Map later if ever needed.
const sessionHistories = new Map();

function getSessionHistory(sessionId) {
  if (!sessionHistories.has(sessionId)) {
    sessionHistories.set(sessionId, new InMemoryChatMessageHistory());
  }
  return sessionHistories.get(sessionId);
}

// Turns a follow-up ("what about its priority?") into a standalone search
// query ("What is TC_5170's priority?") before it reaches a retriever - a
// plain retriever has no way to resolve "it"/"its" on its own.
const REPHRASE_PROMPT = ChatPromptTemplate.fromMessages([
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  [
    "human",
    "Given the above conversation, generate a standalone search query (using the " +
    "conversation's context) to look up information relevant to the last message. " +
    "Respond with ONLY the query text, nothing else.",
  ],
]);

/**
 * Wraps an existing retriever (unchanged from Phase 1) so that when chat
 * history is present, the query is reformulated into a standalone question
 * before retrieval runs. With no history, the query passes through as-is -
 * createHistoryAwareRetriever skips the reformulation call entirely in that
 * case, so a first-ever question in a session costs nothing extra.
 *
 * @param {Runnable<string, Document[]>} baseRetriever
 * @param {BaseChatModel} chatModel - reused, not a new instance per call
 */
async function wrapWithHistoryAwareness(baseRetriever, chatModel) {
  return createHistoryAwareRetriever({
    llm: chatModel,
    retriever: baseRetriever,
    rephrasePrompt: REPHRASE_PROMPT,
  });
}

module.exports = { getSessionHistory, wrapWithHistoryAwareness };
