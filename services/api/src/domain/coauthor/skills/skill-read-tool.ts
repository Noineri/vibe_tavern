/**
 * Co-Author skill file read tool — COAUTHOR_TOOLSET_EXPANSION_PLAN, Wave 2 (CTX-S4).
 *
 * One sandboxed read-only tool the model uses to load skill files on demand
 * (progressive disclosure): the system prompt carries only the skill CATALOG
 * (id / name / description / manifest path); the model matches the request,
 * reads the relevant `SKILL.md`, obeys its workflow, and reads only the
 * referenced assets/references it actually needs for this turn.
 *
 * {@link readSkillFile} is input-agnostic (a path + the skill roots) so the
 * sandboxing contract is tested directly; {@link buildReadSkillFileTool} wraps
 * it as an AI-SDK tool. Reads are immutable and side-effect-free, so multiple
 * reads in one turn are safe to run concurrently.
 *
 * Sandbox: the path is resolved against each skill root (user first — shadow
 * precedence, matching the catalog) and the resolved target MUST stay inside a
 * root. Symlinks, directories, and binary (NUL-bearing) files are rejected, and
 * a path that resolves outside every root (escape / absolute / traversal) is
 * rejected — the tool never reads anything that is not a regular file inside a
 * skill root.
 */

import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of a successful read: the normalized path plus its UTF-8 text. */
export interface ReadSkillFileResult {
  /** The normalized root-relative path that was read (`a/b.md`). */
  readonly path: string;
  /** The file's UTF-8 text content. */
  readonly content: string;
}

/** Client-facing read error (escape / symlink / directory / binary / missing). */
export class SkillReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillReadError";
  }
}

// ─── Sandboxed read ──────────────────────────────────────────────────────────

/**
 * Read one UTF-8 text file from inside the skill roots. The `rawPath` is
 * resolved against each root in order (user roots before built-in, so a user
 * shadow wins — consistent with the catalog precedence); the first root that
 * contains the file as a regular non-symlink text file wins.
 *
 * Rejects (throws {@link SkillReadError}) for: empty input, absolute paths
 * (POSIX or Windows drive), NUL bytes, a target that is a symlink or a
 * directory, a binary file (detected via a NUL byte), and any path that does
 * not resolve to a regular file inside one of the roots (escape / traversal /
 * missing). Internal `..` segments are allowed as long as the resolved path
 * stays inside a root, so a root-relative link like
 * `janitor-card-creator/../shared-card-references/x.md` resolves correctly.
 */
export async function readSkillFile(
  rawPath: string,
  skillRoots: readonly string[],
): Promise<ReadSkillFileResult> {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new SkillReadError("path is empty");
  }
  // Normalize separators (Windows clients / webkit paths use backslashes).
  const normalized = rawPath.replace(/\\/g, "/");
  if (/\0/.test(normalized)) {
    throw new SkillReadError("path contains a NUL byte");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:[\/\\]/.test(rawPath)) {
    throw new SkillReadError(`refusing absolute path: ${rawPath}`);
  }

  for (const root of skillRoots) {
    const resolved = resolve(root, normalized);
    const rel = relative(root, resolved);
    const insideRoot = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    if (!insideRoot) continue; // resolves outside this root — try the next

    let stat: import("node:fs").Stats;
    try {
      stat = await lstat(resolved);
    } catch {
      continue; // not present under this root — try the next
    }
    if (stat.isSymbolicLink()) {
      throw new SkillReadError(`refusing to read a symlink: ${rawPath}`);
    }
    if (!stat.isFile()) {
      throw new SkillReadError(`path is not a regular file (directory or special): ${rawPath}`);
    }

    const bytes = new Uint8Array(await Bun.file(resolved).arrayBuffer());
    // Binary heuristic: a NUL byte means this is not UTF-8 text. Reading it as
    // a string would be lossy and dump noise into the model context.
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        throw new SkillReadError(`refusing to read a binary file (NUL byte): ${rawPath}`);
      }
    }
    const content = new TextDecoder().decode(bytes);
    return { path: normalized, content };
  }

  throw new SkillReadError(`file not found inside any skill root: ${rawPath}`);
}

// ─── AI-SDK tool wrapper ─────────────────────────────────────────────────────

/**
 * Build the `read_skill_file` tool bound to the given skill roots. The roots
 * are captured in the closure (immutable strings), so the tool is safe to hold
 * across the multi-step turn. Always available in Co-Author mode — it is the
 * universal, read-only skill-access channel and is NOT gated by a module's
 * `toolSet` (which only scopes the mutating profile/greeting tools).
 */
export function buildReadSkillFileTool(skillRoots: readonly string[]): Tool {
  return tool({
    description:
      "Read one UTF-8 text file from the Co-Author skill library (a SKILL.md manifest, a referenced template, or a reference file). " +
      "Use it to follow the standard skill flow: match the request against the 'Available skills' catalog, read the relevant SKILL.md, obey its workflow, and read only the assets/references needed for the current task. " +
      "`path` is ROOT-RELATIVE (e.g. 'janitor-card-creator/SKILL.md', 'janitor-card-creator/assets/character-template.md', 'shared-card-references/evaluation-principles.md'). " +
      "It must resolve inside a skill root; absolute, traversal-escape, directory, symlink, and binary paths are rejected. Reads are immutable — call this as many times as needed in one turn.",
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe(
          "Root-relative path of the skill file to read, e.g. 'janitor-card-creator/SKILL.md' or 'janitor-card-creator/assets/character-template.md'.",
        ),
    }),
    execute: async ({ path }): Promise<ReadSkillFileResult> => readSkillFile(path, skillRoots),
  });
}
