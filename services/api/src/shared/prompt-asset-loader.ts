/**
 * Shared multi-candidate prompt-asset loader.
 *
 * Resolves a prompt filename across the same candidate ladder used everywhere
 * asset `.md` files are loaded in this process: env override → standalone
 * artifact (next to the executable) → API source assets → cwd source → build
 * output. Returns the first candidate that exists on disk.
 *
 * Extracted from `ai-assistant-prompts.ts` (rule of three: a second consumer —
 * Co-Author skills/base prompt — now needs the same ladder). Both call sites
 * share one resolver + one cache so asset reads happen once per file per run.
 */

import { join, resolve } from "node:path";

// ─── Cache ───────────────────────────────────────────────────────────────────

const _assetCache = new Map<string, string>();

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a prompt filename to its on-disk path via the standard candidate ladder.
 * Returns the first existing candidate; falls back to the last candidate (so the
 * subsequent read fails with a clear path-bearing error instead of a bare null).
 */
export async function resolvePromptAssetPath(filename: string): Promise<string> {
  const candidates = [
    // Environment override.
    process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR
      ? join(process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR, filename)
      : null,
    // Standalone artifact: prompt next to executable, in prompts/ subdir.
    join(resolve(process.execPath, ".."), "prompts", filename),
    // API source assets.
    resolve(import.meta.dir, "..", "..", "assets", filename),
    join(process.cwd(), "services", "api", "assets", filename),
    // Build output.
    resolve(import.meta.dir, filename),
    resolve(import.meta.dir, "..", "..", "..", "..", "out", "services", "api", filename),
    join(process.cwd(), "out", "services", "api", filename),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }
  return candidates[candidates.length - 1];
}

/**
 * Load a prompt asset's text, cached per filename after first successful read.
 * Re-throws the read error (with the resolved path) if the file is missing.
 */
export async function loadPromptAsset(filename: string): Promise<string> {
  const cached = _assetCache.get(filename);
  if (cached !== undefined) return cached;
  const path = await resolvePromptAssetPath(filename);
  const content = await Bun.file(path).text();
  _assetCache.set(filename, content);
  return content;
}

/** Test-only: clear the asset cache. */
export function clearPromptAssetCache(): void {
  _assetCache.clear();
}
