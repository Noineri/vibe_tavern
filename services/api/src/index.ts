import type { AssemblePromptResponse } from "@rp-platform/domain";

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

export * from "./chat-application-service.js";
export * from "./prompt-assembly-service.js";
export type { AppType } from "./routes.js";
