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
import { loadPromptAsset, resolvePromptAssetPath } from "../../shared/prompt-asset-loader.js";
import { getModeConfig, getDefaultPromptFile } from "./ai-assistant-modes.js";

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
 * Resolve the final system prompt for a mode using the fallback chain:
 *
 * 1. `aiAssistantPrompts[mode]` — user override from active preset
 * 2. `scriptAiSystemPrompt` — backward compat for script mode only
 * 3. Default `.md` file
 */
export async function resolveSystemPrompt(
  mode: AiAssistantMode,
  options: {
    /** Parsed `aiAssistantPrompts` JSON from the active preset. */
    aiAssistantPrompts: Record<string, string> | null;
    /** Legacy `scriptAiSystemPrompt` value (used only for script mode). */
    scriptAiSystemPrompt?: string | null;
    /** For format-aware modes (scene_schema): select the default file. Ignored
     *  when a preset override is present (overrides are format-agnostic). */
    promptFormat?: "json" | "xml";
  },
): Promise<{ prompt: string; source: "preset_override" | "preset_legacy" | "default_md" }> {
  const config = getModeConfig(mode);

  // 1. Check aiAssistantPrompts override for this mode
  if (options.aiAssistantPrompts) {
    const override = options.aiAssistantPrompts[config.presetKey]?.trim();
    if (override) {
      return { prompt: override, source: "preset_override" };
    }
  }

  // 2. Backward compat: scriptAiSystemPrompt for script mode
  if (config.legacyColumn && options.scriptAiSystemPrompt?.trim()) {
    return { prompt: options.scriptAiSystemPrompt.trim(), source: "preset_legacy" };
  }

  // 3. Default .md file (format-aware for scene_schema)
  const defaultPrompt = await getDefaultPromptForMode(mode, options.promptFormat);
  return { prompt: defaultPrompt, source: "default_md" };
}
