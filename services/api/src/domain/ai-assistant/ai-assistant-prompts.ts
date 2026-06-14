/**
 * Default prompt loading for AI assistant modes.
 *
 * Reads `.md` files from the assets directory, cached after first read.
 * Follows the same path resolution strategy as the script-ai prompt loader
 * (dev mode, build output, standalone artifact).
 */

import { join, resolve } from "node:path";
import type { AiAssistantMode } from "@vibe-tavern/prompt-pipeline";
import { getModeConfig } from "./ai-assistant-modes.js";

// ─── Cache ───────────────────────────────────────────────────────────────────

const _promptCache = new Map<string, string>();

// ─── Path resolution ─────────────────────────────────────────────────────────

export async function resolvePromptPathForMode(mode: AiAssistantMode): Promise<string> {
  const config = getModeConfig(mode);
  return resolvePromptPath(config.defaultPromptFile);
}

async function resolvePromptPath(filename: string): Promise<string> {
  const candidates = [
    // Environment override
    process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR
      ? join(process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR, filename)
      : null,
    // Standalone artifact: prompt next to executable, in prompts/ subdir.
    join(resolve(process.execPath, ".."), "prompts", filename),
    // API source assets.
    resolve(import.meta.dir, "..", "..", "assets", filename),
    join(process.cwd(), "services", "api", "assets", filename),
    // Build output.
    resolve(import.meta.dir, "..", filename),
    resolve(import.meta.dir, "..", "..", "..", "..", "out", "services", "api", filename),
    join(process.cwd(), "out", "services", "api", filename),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }

  // Return last candidate as fallback (will fail with a clear error on read).
  return candidates[candidates.length - 1];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load the default system prompt for a given assistant mode.
 * Results are cached after first successful read.
 */
export async function getDefaultPromptForMode(mode: AiAssistantMode): Promise<string> {
  const cached = _promptCache.get(mode);
  if (cached) return cached;

  const config = getModeConfig(mode);
  const mdPath = await resolvePromptPath(config.defaultPromptFile);
  const content = await Bun.file(mdPath).text();

  _promptCache.set(mode, content);
  return content;
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

  // 3. Default .md file
  const defaultPrompt = await getDefaultPromptForMode(mode);
  return { prompt: defaultPrompt, source: "default_md" };
}

/** Clear the prompt cache (useful for testing). */
export function clearPromptCache(): void {
  _promptCache.clear();
}
