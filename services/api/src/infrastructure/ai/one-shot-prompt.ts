import type { AssemblePromptResponse } from "@vibe-tavern/domain";

/** Build the minimal one-shot AssemblePromptResponse the executor consumes. */
export function buildOneShotPrompt(system: string, user: string): AssemblePromptResponse {
  return {
    layers: [],
    tokenAccounting: { total: 0 },
    activatedLoreEntries: [],
    scriptInjections: [],
    retrievedMemories: [],
    finalPayload: {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  };
}
