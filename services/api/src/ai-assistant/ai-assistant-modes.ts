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
  lore_entry: {
    mode: "lore_entry",
    presetKey: "lore_entry",
    defaultPromptFile: "lore-entry-ai-prompt.md",
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
};

export function getModeConfig(mode: AiAssistantMode): AiAssistantModeConfig {
  const config = MODE_CONFIGS[mode];
  if (!config) throw new Error(`Unknown AI assistant mode: ${mode}`);
  return config;
}

export function getAllModeConfigs(): AiAssistantModeConfig[] {
  return Object.values(MODE_CONFIGS);
}
