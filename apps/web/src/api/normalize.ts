import type { AppSnapshot, AppMessage } from "./types.js";

export function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return {
    ...snapshot,
    character: {
      ...snapshot.character,
      firstMessage: snapshot.character.firstMessage ?? null,
      alternateGreetings: Array.isArray(snapshot.character.alternateGreetings)
        ? snapshot.character.alternateGreetings
        : [],
      postHistoryInstructions: snapshot.character.postHistoryInstructions ?? null,
      creatorNotes: snapshot.character.creatorNotes ?? null,
      depthPrompt: snapshot.character.depthPrompt ?? null,
      depthPromptDepth: snapshot.character.depthPromptDepth ?? null,
      depthPromptRole: snapshot.character.depthPromptRole ?? null,
      tags: Array.isArray(snapshot.character.tags) ? snapshot.character.tags : [],
    },
    chats: Array.isArray(snapshot.chats) ? snapshot.chats : [],
    branches: Array.isArray(snapshot.branches) ? snapshot.branches : [],
    messages: Array.isArray(snapshot.messages)
      ? snapshot.messages.map(normalizeMessage)
      : [],
    summaries: Array.isArray(snapshot.summaries) ? snapshot.summaries : [],
    promptTraceHistory: Array.isArray(snapshot.promptTraceHistory)
      ? snapshot.promptTraceHistory
      : [],
  };
}

export function normalizeMessage(message: AppMessage): AppMessage {
  const variants = Array.isArray(message.variants) ? message.variants : [];
  const selectedVariantIndex =
    typeof message.selectedVariantIndex === "number" ? message.selectedVariantIndex : null;

  return {
    ...message,
    variants,
    selectedVariantIndex,
  };
}
