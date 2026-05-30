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

export * from "./chat/chat-application-service.js";
export * from "./prompt/prompt-assembly-service.js";
export type { AppType } from "./routes/index.js";
