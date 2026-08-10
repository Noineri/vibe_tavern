/**
 * Mode definitions for the universal AI assistant.
 *
 * Each mode defines its system prompt resolution, user message format,
 * output parsing, and streaming behavior.
 */

import type { AiAssistantMode } from "@vibe-tavern/prompt-pipeline";

// ─── Mode config ─────────────────────────────────────────────────────────────

export interface AiAssistantModeConfig {
  /** Mode identifier — matches `AiAssistantMode` in pipeline types. */
  mode: AiAssistantMode;
  /** Key inside `aiAssistantPrompts` JSON to check for user overrides. */
  presetKey: string;
  /** Default .md file basename (loaded from assets dir). */
  defaultPromptFile: string;
  /** For format-aware modes (scene_schema): per-format default prompt files.
   *  When the request carries a promptFormat matching a key here, that file
   *  replaces defaultPromptFile in the default-md fallback branch (preset
   *  overrides still win and are format-agnostic). */
  formatPromptFiles?: Partial<Record<"json" | "xml", string>>;
  /** Backward-compat column for script mode. null for other modes. */
  legacyColumn?: "scriptAiSystemPrompt";
  /** Whether reasoning is stripped from SSE output (only final result emitted). */
  stripReasoning: boolean;
  /** Expected output format. */
  outputFormat: "text" | "json";
  /**
   * JSON output schema description (for prompt instructions).
   * null when outputFormat !== "json".
   */
  jsonSchemaHint: string | null;
}

// ─── Mode registry ───────────────────────────────────────────────────────────

const MODE_CONFIGS: Record<AiAssistantMode, AiAssistantModeConfig> = {
  script: {
    mode: "script",
    presetKey: "script",
    defaultPromptFile: "script-ai-prompt.md",
    legacyColumn: "scriptAiSystemPrompt",
    stripReasoning: false,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  // dice_script generates Dice-script code targeting the dedicated Dice VM
  // (DICE_SYSTEM_BACKEND_PLAN Wave B2). It is a REAL assistant mode using the
  // existing assembler — no thinner prompt shape. It has NO legacyColumn: the
  // generic `script` preset/legacy override stays prompt-only, so a dice-script
  // generation never falls through to scriptAiSystemPrompt. stripReasoning is
  // true so the accumulated output is cleaned (markdown fences stripped) before
  // yielding one final code block.
  dice_script: {
    mode: "dice_script",
    presetKey: "dice_script",
    defaultPromptFile: "dice-script-ai-prompt.md",
    stripReasoning: true,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  // interactive_rules generates interactive-experience rules source — a single
  // `context.experience.register({ apiVersion, manifest, capabilities, create,
  // project, actions, reduce, choose?, flavor?, setup? })` body targeting the
  // dedicated Interactive-experience VM (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
  // Wave 8 / IR-82). It is a REAL code-generating mode, a sibling of
  // dice_script: stripReasoning is true so the accumulated output is cleaned
  // (markdown fences stripped) before yielding one final code block, and it has
  // NO legacyColumn (the generic `script` preset/legacy override stays
  // prompt-only). Its static API reference + canonical starter examples are
  // baked into the `interactive-rules.md` asset, so no runtime context
  // attachment is needed beyond existingContent + the user's instruction.
  interactive_rules: {
    mode: "interactive_rules",
    presetKey: "interactive_rules",
    defaultPromptFile: "interactive-rules.md",
    stripReasoning: true,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  lore_entry: {
    mode: "lore_entry",
    presetKey: "lore_entry",
    defaultPromptFile: "lore-entry-ai-prompt.md",
    stripReasoning: false,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  message_edit: {
    mode: "message_edit",
    presetKey: "message_edit",
    defaultPromptFile: "message-edit-ai-prompt.md",
    stripReasoning: false,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  message_merge: {
    mode: "message_merge",
    presetKey: "message_merge",
    defaultPromptFile: "message-merge-ai-prompt.md",
    stripReasoning: false,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  lore_keys: {
    mode: "lore_keys",
    presetKey: "lore_keys",
    defaultPromptFile: "lore-keys-ai-prompt.md",
    stripReasoning: true,
    outputFormat: "json",
    jsonSchemaHint: '{ "keys": ["..."], "secondaryKeys": ["..."] }',
  },
  chat_impersonate: {
    mode: "chat_impersonate",
    presetKey: "chat_impersonate",
    defaultPromptFile: "chat-impersonate-ai-prompt.md",
    stripReasoning: true,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  md_import: {
    mode: "md_import",
    presetKey: "md_import",
    defaultPromptFile: "md-import-prompt.md",
    stripReasoning: true,
    outputFormat: "json",
    jsonSchemaHint: '{ "name": "...", "tagline": "...", "description": "...", "personality": "...", "scenario": "...", "firstMessage": "...", "alternateGreetings": ["..."], "exampleMessages": ["..."], "creatorNotes": "..." }',
  },
  // vision_describe is NOT user-facing in the assistant modal — it drives the
  // backend attachment-description pipeline (vision gate fallback). Surfaced
  // here purely so its prompt resolves through the same fallback chain as the
  // other modes, and so the Settings prompt editor's existing "vision_describe"
  // entry is backed by a real mode config instead of a phantom key.
  vision_describe: {
    mode: "vision_describe",
    presetKey: "vision_describe",
    defaultPromptFile: "vision-describe-ai-prompt.md",
    stripReasoning: true,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
  scene_schema: {
    mode: "scene_schema",
    presetKey: "scene_schema",
    // Default (and JSON). XML requests select scene-schema-xml.md instead.
    defaultPromptFile: "scene-schema-json.md",
    formatPromptFiles: { json: "scene-schema-json.md", xml: "scene-schema-xml.md" },
    stripReasoning: true,
    outputFormat: "json",
    jsonSchemaHint:
      '{ "mood": { "$type": "string" }, "tension": { "$type": "number", "min": 0, "max": 10 } }',
  },
  scene_rules: {
    mode: "scene_rules",
    presetKey: "scene_rules",
    defaultPromptFile: "scene-rules.md",
    stripReasoning: true,
    outputFormat: "text",
    jsonSchemaHint: null,
  },
};

/** Resolve the default prompt FILE NAME for a mode, honoring a format-aware
 *  mode's per-format override when promptFormat is supplied. */
export function getDefaultPromptFile(
  mode: AiAssistantMode,
  promptFormat?: "json" | "xml",
): string {
  const config = getModeConfig(mode);
  if (promptFormat && config.formatPromptFiles) {
    const file = config.formatPromptFiles[promptFormat];
    if (file) return file;
  }
  return config.defaultPromptFile;
}

export function getModeConfig(mode: AiAssistantMode): AiAssistantModeConfig {
  const config = MODE_CONFIGS[mode];
  if (!config) throw new Error(`Unknown AI assistant mode: ${mode}`);
  return config;
}

export function getAllModeConfigs(): AiAssistantModeConfig[] {
  return Object.values(MODE_CONFIGS);
}
