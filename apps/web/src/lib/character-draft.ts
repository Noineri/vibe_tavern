/**
 * Character → form-draft mapping (shared by BuildMode and Co-Author).
 *
 * The canonical conversion from a snapshot {@link AppCharacter} into a
 * react-hook-form `BuildCharacterDraft` default-values object. Both the build
 * editor (`BuildMode.tsx`) and the co-author editor (`CoauthorCharacterForm.tsx`)
 * own their own `useForm<BuildCharacterDraft>` but MUST seed it from the same
 * mapping, so a character edited in one surface round-trips identically in the
 * other. Extracted here (was a private function in `BuildMode.tsx`) to avoid
 * two copies drifting — CA-10 introduced the second consumer.
 *
 * Pure function: no React, no I/O. The inverse direction (draft → save patch)
 * lives in `useCharacterController.handleSaveCharacter`, the single write path.
 */

import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import type { AppCharacter } from "../app-client.js";

/** Seed a `BuildCharacterDraft` from a snapshot character (form default values). */
export function characterDefaults(character: AppCharacter): BuildCharacterDraft {
  return {
    name: character.name,
    description: character.description,
    firstMessage: character.firstMessage || "",
    mesExample: character.mesExample || "",
    mesExampleMode: (character.mesExampleMode as "always" | "once" | "depth") || "always",
    mesExampleDepth: character.mesExampleDepth ?? 4,
    scenario: character.scenario,
    personalitySummary: character.personalitySummary || "",
    systemPrompt: character.systemPrompt,
    alternateGreetings: character.alternateGreetings || [],
    postHistoryInstructions: character.postHistoryInstructions || "",
    creatorNotes: character.creatorNotes || "",
    depthPrompt: character.depthPrompt || "",
    depthPromptDepth: character.depthPromptDepth ?? 4,
    depthPromptRole: character.depthPromptRole || "system",
    tags: character.tags || [],
  };
}
