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
// Image-gen static capability table — pure data, no I/O, import-safe for the
// web bundle (IG-10): the Providers editor snapshots it onto profiles on
// create/backend-switch (the create contract carries the capability mirror)
// and renders capability-gated controls from it (the registry's own
// documented consumption path).
export { IMAGE_GEN_BACKEND_CAPABILITIES } from "./domain/imagegen/imagegen-registry.js";
