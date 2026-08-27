/**
 * Shared prompt-asset copier for every packaging script.
 *
 * `services/api/assets/` mixes three kinds of payload: flat `*.md` prompt
 * files, nested prompt trees (`coauthor/{modules,skills}`,
 * `experience-copilot/{skills}`), and the `tokenizers/` runtime (copied
 * separately by the scripts that need it, to script-specific targets).
 *
 * History: each packager re-implemented this as "flat readdir(*.md) + copy
 * coauthor/" — and when `experience-copilot/` arrived, only `build.ts` was
 * updated. Result: the standalone/npm/linux/windows/android artifacts shipped
 * without ANY copilot prompt (base.md, user-flow.md, skills) — the loader fell
 * through its candidate ladder and the copilot ran prompt-less (owner-reported:
 * "копайлота какие-то промпты не доходят"). One copier, every packager: any
 * future nested prompt tree is included automatically.
 *
 * Semantics: copy every flat `.md` file and every subdirectory EXCEPT
 * `tokenizers` (that one has its own per-script target). Throws if no flat
 * `.md` files exist (the historical build-abort guard). Returns the list of
 * copied target paths for the caller's log output.
 */

import { cp, copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Subdirectory of the assets dir that this copier must NOT touch. */
const EXCLUDED_DIRS = new Set(["tokenizers"]);

export async function copyPromptAssets(assetsDir: string, targetDir: string): Promise<string[]> {
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const targets: string[] = [];
  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md"));
  if (mdFiles.length === 0) {
    throw new Error(`No .md prompt files found in ${assetsDir}`);
  }
  for (const entry of mdFiles) {
    const target = join(targetDir, entry.name);
    await mkdir(targetDir, { recursive: true });
    await copyFile(join(assetsDir, entry.name), target);
    targets.push(target);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
    const target = join(targetDir, entry.name);
    await cp(join(assetsDir, entry.name), target, { recursive: true });
    targets.push(target);
  }
  return targets;
}
