/**
 * Default prompt loading for AI assistant modes.
 *
 * Reads `.md` files from the assets directory via the shared prompt-asset
 * loader (`shared/prompt-asset-loader.ts`), which owns the candidate-path
 * ladder (env override → standalone artifact → API source assets → cwd source
 * → build output) and re-reads on every call (no process cache, so an edit
 * beside the executable is live on the next model request). This module keeps
 * the mode-keyed public surface (`getDefaultPromptForMode`,
 * `resolveSystemPrompt`, etc.) that callers depend on; resolution is delegated
 * so there is a single source of truth for where prompt `.md` files are loaded
 * from.
 */

import type { AiAssistantMode } from "@vibe-tavern/prompt-pipeline";
import type { AppDb } from "@vibe-tavern/db";
import type { ServicePromptFieldKey } from "@vibe-tavern/domain";
import { loadPromptAsset, resolvePromptAssetPath } from "../../shared/prompt-asset-loader.js";
import { getModeConfig, getDefaultPromptFile } from "./ai-assistant-modes.js";
import { getActiveServicePromptProfile } from "../service-prompts/service-prompt-resolver.js";

// ─── Path resolution ─────────────────────────────────────────────────────────

export async function resolvePromptPathForMode(mode: AiAssistantMode, promptFormat?: "json" | "xml"): Promise<string> {
  return resolvePromptAssetPath(getDefaultPromptFile(mode, promptFormat));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load the default system prompt for a given assistant mode. Delegates to the
 * shared loader, which re-reads from disk on every call.
 */
export async function getDefaultPromptForMode(mode: AiAssistantMode, promptFormat?: "json" | "xml"): Promise<string> {
  return loadPromptAsset(getDefaultPromptFile(mode, promptFormat));
}

/**
 * Resolve the final system prompt for a mode using the service-prompt
 * profile chain (SP-4):
 *
 * 1. Active service-prompt profile override for the mode's field key
 *    (format-agnostic — wins over both json/xml defaults for scene_schema)
 * 2. Default `.md` file (format-aware via getDefaultPromptFile — xml selects
 *    the xml variant when promptFormat === "xml")
 */
const MODE_TO_FIELD: Record<AiAssistantMode, ServicePromptFieldKey> = {
  script: "script",
  dice_script: "dice_script",
  lore_entry: "lore_entry",
  message_edit: "message_edit",
  message_merge: "message_merge",
  message_tts_annotate: "message_tts_annotate",
  lore_keys: "lore_keys",
  chat_impersonate: "chat_impersonate",
  md_import: "md_import",
  vision_describe: "vision_describe",
  scene_schema: "scene_schema",
  scene_rules: "scene_rules",
  regex: "regex",
};

export async function resolveSystemPrompt(
  db: AppDb,
  mode: AiAssistantMode,
  options?: {
    /** For format-aware modes (scene_schema): select the default file. Ignored
     *  when a profile override is present (overrides are format-agnostic). */
    promptFormat?: "json" | "xml";
  },
): Promise<{ prompt: string; source: "override" | "default" }> {
  const { profile } = await getActiveServicePromptProfile(db);
  const field = MODE_TO_FIELD[mode];
  if (field) {
    const raw = profile.overrides[field];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length > 0) {
      return { prompt: trimmed, source: "override" };
    }
  }

  // Default .md file (format-aware for scene_schema)
  const defaultPrompt = await getDefaultPromptForMode(mode, options?.promptFormat);
  return { prompt: defaultPrompt, source: "default" };
}
