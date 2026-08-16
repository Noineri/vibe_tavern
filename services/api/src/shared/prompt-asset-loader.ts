/**
 * Shared multi-candidate prompt-asset loader.
 *
 * Resolves a prompt filename across the same candidate ladder used everywhere
 * asset `.md` files are loaded in this process: env override → standalone
 * artifact (next to the executable) → API source assets → cwd source → build
 * output. Returns the first candidate that exists on disk.
 *
 * No content cache: `loadPromptAsset` re-resolves and re-reads on every call, so
 * an edit to a prompt file beside the standalone executable (or under the env
 * override dir) is visible to the next model request without a process restart.
 * The cost is negligible — each load is a few `stat`s plus one small file read,
 * and a prompt load only happens once per LLM turn, which is orders of magnitude
 * more expensive than the read. Path resolution is not cached either, so a newly
 * dropped override file is also picked up live.
 *
 * Extracted from `ai-assistant-prompts.ts` (rule of three: a second consumer —
 * Co-Author skills/base prompt — now needs the same ladder). Both call sites
 * share this one resolver.
 */

import { join, resolve } from "node:path";

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a prompt filename to its on-disk path via the standard candidate ladder.
 * Returns the first existing candidate; falls back to the last candidate (so the
 * subsequent read fails with a clear path-bearing error instead of a bare null).
 */
export async function resolvePromptAssetPath(filename: string): Promise<string> {
  const candidates = [
    // Environment override.
    process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR
      ? join(process.env.VIBE_TAVERN_AI_ASSISTANT_PROMPTS_DIR, filename)
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
 * Load a prompt asset's text, re-reading from disk on every call so external
 * edits are picked up without a restart. Re-throws the read error (with the
 * resolved path) if the file is missing.
 *
 * Line endings are NORMALIZED to `\n`: the repo authors prompt assets with LF,
 * but a Windows checkout with `core.autocrlf=true` (e.g. CI runners) or a user
 * override saved by a CRLF editor materializes `\r\n` on disk — and a stray
 * `\r` leaking into a system prompt both changes the bytes sent to the LLM on
 * a platform-dependent basis and breaks byte-level prompt pins (see
 * experience-copilot-prompt.test.ts). Prompts are prose; nothing in them
 * depends on a carriage return surviving.
 */
export async function loadPromptAsset(filename: string): Promise<string> {
  const path = await resolvePromptAssetPath(filename);
  const raw = await Bun.file(path).text();
  return raw.replace(/\r\n?/g, "\n");
}
