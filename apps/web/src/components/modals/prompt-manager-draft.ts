/**
 * Pure draft helpers for PromptManagerModal (file-size ratchet extraction,
 * pre-authorized; owner report 2026-10-09 fix batch). No React, no I/O —
 * the shapes and builders the modal owns but every consumer can share.
 */
import type { CharacterCanvasDraft } from "../settings/prompt/InjectionTable.js";
import type { DraftData } from "./preset-import-flow.js";

/** The modal's `characterFields` prop — the character-canvas seed shape. */
export interface CharacterCanvasFields {
  systemPrompt: string | null;
  postHistoryInstructions: string | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  description: string;
  personalitySummary: string | null;
  scenario: string;
  mesExample: string | null;
}

export function toCharacterCanvasDraft(
  fields: CharacterCanvasFields | null | undefined,
): CharacterCanvasDraft | null {
  return fields ? {
    charSystemPrompt: fields.systemPrompt ?? "",
    charPostHistory: fields.postHistoryInstructions ?? "",
    charDepthPrompt: fields.depthPrompt ?? "",
    charDepthPromptDepth: fields.depthPromptDepth ?? 4,
    charDepthPromptRole: fields.depthPromptRole ?? "system",
    charDescription: fields.description,
    charPersonality: fields.personalitySummary ?? "",
    scenario: fields.scenario,
    dialogueExamples: fields.mesExample ?? "",
  } : null;
}

export const emptyDraft: DraftData = {
  name: "", system: "", jailbreak: "",
  prefill: "", authorsNote: "", authorsNoteDepth: 4, authorsNotePosition: "in_chat", authorsNoteRole: "system", summary: "", tools: "", nsfw: "", enhanceDefinitions: "", scriptAiSystemPrompt: "",
  aiAssistantPrompts: {},
  customInjections: [],
  promptOrder: [],
  advancedMode: false,
  mergeConsecutiveRoles: false,
  perSendPrefillEnabled: false,
  generationFormat: null,
};

/**
 * Build the create-preset payload for "Duplicate" — a DEEP copy of the live
 * draft so the new preset's payload shares no mutable array/object references
 * (`promptOrder`, `customInjections`, `aiAssistantPrompts`) with the source. A
 * former shallow `{...draft}` spread aliased those nested values and let edits
 * to the copy leak back into the source's in-memory state. `aiAssistantPrompts`
 * is stringified to the JSON the DTO/API store expects (matches handleSave).
 * Pure/exported so the no-aliasing invariant has a characterization test
 * (PRESET_COPY_DELETE_CORRUPTION bug 1). */
export function buildDuplicatePayload(draft: DraftData, fallbackName: string) {
  const copy = structuredClone(draft);
  // A null format (= auto) is absent on the wire — strip it from the clone.
  const { generationFormat, ...copyFields } = copy;
  return {
    ...copyFields,
    aiAssistantPrompts: JSON.stringify(copy.aiAssistantPrompts),
    ...(generationFormat ? { generationFormat } : {}),
    name: `${draft.name || fallbackName} (copy)`,
  };
}
