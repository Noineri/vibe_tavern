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
// Image-gen static capability table: lives in the DOMAIN leaf
// (packages/domain/src/imagegen-capabilities.ts) — NOT re-exported from this
// barrel. apps/web imports it from @vibe-tavern/domain directly: this barrel
// exposes the full server surface (db, bun:sqlite), and any browser-side
// import through it breaks the web bundle (caught by dev-server tests,
// 2026-09-14). API-side code keeps importing it from the image-gen registry,
// which re-exports the domain table.
