import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import { getLatestMigrationVersion } from "@rp-platform/db";

export function buildEmptyPromptTrace(): AssemblePromptResponse {
  return {
    layers: [],
    tokenAccounting: {},
    activatedLoreEntries: [],
    retrievedMemories: [],
    finalPayload: {},
  };
}

export function buildBootstrapStatus(): { latestMigrationVersion: string } {
  return {
    latestMigrationVersion: getLatestMigrationVersion(),
  };
}

export * from "./chat-application-service.js";
export * from "./prompt-assembly-service.js";
