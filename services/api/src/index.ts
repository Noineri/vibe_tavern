import type { AssemblePromptResponse } from "@vibe-tavern/domain";

export function buildEmptyPromptTrace(): AssemblePromptResponse {
  return {
    layers: [],
    tokenAccounting: {},
    activatedLoreEntries: [],
    scriptInjections: [],
    retrievedMemories: [],
    finalPayload: {},
  };
}

export * from "./domain/chat/chat-application-service.js";
export * from "./domain/prompt/prompt-assembly-service.js";
export type { AppType } from "./api/routes/index.js";
