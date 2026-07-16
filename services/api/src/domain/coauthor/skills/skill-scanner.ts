/**
 * Filesystem skill discovery — COAUTHOR_TOOLSET_EXPANSION_PLAN, Wave 1 (CTX-S1).
 *
 * A skill is a directory containing `SKILL.md` (the manifest), plus optional
 * `references/`, `assets/`, and any other ordinary text files alongside the
 * manifest. This module discovers skills from one or more roots (a read-only
 * built-in root and a writable user root), parses ONLY the discovery metadata
 * (`name`, `description`) from each manifest's YAML frontmatter, and returns
 * stable skill IDs plus normalized root-relative paths.
 *
 * Discovery is strictly READ-ONLY: it never rewrites, reformats, or truncates a
 * manifest. Unknown frontmatter fields (e.g. `modeSlugs`) are read past, never
 * written back — the YAML is parsed to an object, two fields are read, and the
 * original file bytes stay untouched on disk (pinned by tests).
 *
 * Compatibility fixture shape (N:/.../.roo/skills, external — production code
 * never references that path): nine `<name>/SKILL.md` manifests, skill-local
 * `assets/` + `references/`, a shared sibling references directory that has NO
 * `SKILL.md` (therefore NOT a skill), and cross-skill relative links. An
 * imported copy of that tree under the user root must behave identically.
 *
 * The scanner is pure w.r.t. root locations: callers pass {@link ScanRoot}s in,
 * so tests drive temp directories and production wiring (CTX-S3) resolves the
 * real roots via {@link resolveBuiltinSkillsRoot} / {@link resolveUserSkillsRoot}.
 */

import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePromptAssetPath } from "../../../shared/prompt-asset-loader.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SkillSource = "builtin" | "user";

/** A successfully discovered skill — discovery metadata + stable locations. */
export interface DiscoveredSkill {
  /** Stable skill ID = the skill directory name. Unique within a root. */
  readonly id: string;
  /** Where the skill lives (built-in read-only vs user-writable root). */
  readonly source: SkillSource;
  /** Human-readable name from manifest frontmatter (falls back to id at the catalog layer). */
  readonly name: string;
  /** One-line description from manifest frontmatter (empty string if absent). */
  readonly description: string;
  /** Absolute path to the skill directory. */
  readonly skillDir: string;
  /** Absolute path to `SKILL.md` inside the skill directory. */
  readonly manifestPath: string;
  /** Path to `SKILL.md` relative to its own root — portable across machines (`<id>/SKILL.md`). */
  readonly rootRelativeManifestPath: string;
}

/** A skill directory that exists but whose manifest could not be parsed. */
export interface SkillScanError {
  readonly source: SkillSource;
  readonly skillDir: string;
  readonly reason: string;
}

export interface SkillScanResult {
  readonly skills: DiscoveredSkill[];
  readonly errors: SkillScanError[];
}

/** A root to scan: a filesystem path plus which kind of root it is. */
export interface ScanRoot {
  readonly path: string;
  readonly source: SkillSource;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MANIFEST_NAME = "SKILL.md";
const SKILLS_ASSET_DIR = "coauthor/skills";
/** A built-in manifest that always exists after the Wave-1 directory conversion — used to locate the built-in root. */
const BUILTIN_LOCATOR_MANIFEST = `${SKILLS_ASSET_DIR}/profile-overview/${MANIFEST_NAME}`;

// ─── Manifest parsing (read-only) ────────────────────────────────────────────

/**
 * Extract the YAML frontmatter block (the text between the opening and closing
 * `---` fences) from a manifest. Returns `null` when the document does not
 * start with a frontmatter fence or the closing fence is missing.
 *
 * Fence detection is line-based (the same convention every skill manifest in
 * the fixture, Roo, and pi uses). A line whose trimmed content is exactly
 * `---` closes the block; a folded/block-scalar value never contains such a
 * line, so this does not truncate real values.
 */
function extractFrontmatter(text: string): string | null {
  // The opening fence must be the very first line (no leading blank/byte-order mark).
  const opening = text.match(/^---\r?\n/);
  if (!opening) return null;
  const after = text.slice(opening[0].length);
  const lines = after.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(0, i).join("\n");
    }
  }
  return null;
}

/** Outcome of parsing a manifest's discovery metadata. */
export type ManifestParseResult = { name: string; description: string } | { error: string };

/**
 * Parse ONLY `name` and `description` from a manifest's YAML frontmatter. The
 * full document text is accepted (not a pre-extracted block) so callers cannot
 * accidentally feed a stripped body; this function reads nothing but the
 * frontmatter and writes nothing back. Unknown fields are ignored.
 */
export function parseSkillManifest(manifestText: string): ManifestParseResult {
  const frontmatter = extractFrontmatter(manifestText);
  if (frontmatter === null) return { error: "manifest has no YAML frontmatter block" };

  let doc: unknown;
  try {
    doc = parseYaml(frontmatter);
  } catch (e) {
    return { error: `invalid YAML frontmatter: ${(e as Error).message}` };
  }
  if (doc === null) return { error: "manifest frontmatter is empty" };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { error: "manifest frontmatter is not a YAML mapping" };
  }

  const obj = doc as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || !name.trim()) {
    return { error: "manifest frontmatter is missing a non-empty string 'name'" };
  }
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  return { name: name.trim(), description };
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Reject directory names that could escape or confuse the root: traversal
 * (`.`/`..`), separators, NUL, and empty. `readdir` never yields these in
 * practice, but the scanner must not trust filenames as paths without a check.
 */
function isSafeSkillDirName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

// ─── Root scanning ───────────────────────────────────────────────────────────

/**
 * List immediate child directories of a root (sorted, deterministic). Symlinked
 * directories are excluded so a skill root cannot be redirected outside its
 * root via a symlink. A missing root (e.g. no user skills imported yet) yields
 * `[]` — not an error — so a fresh install scans cleanly.
 */
async function listSkillDirs(rootPath: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => e.name)
    .filter(isSafeSkillDirName)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Scan one root: every immediate child directory that contains a `SKILL.md`
 * manifest becomes a {@link DiscoveredSkill}; a child without a manifest (the
 * shared-references-directory case) is simply not a skill and is skipped
 * silently; a child whose manifest fails to parse becomes a {@link SkillScanError}.
 *
 * Symlinked manifests are rejected (recorded as an error) so discovery cannot
 * follow a link out of the skill root.
 */
export async function scanSkillRoot(root: ScanRoot): Promise<SkillScanResult> {
  const skills: DiscoveredSkill[] = [];
  const errors: SkillScanError[] = [];
  const rootPath = resolve(root.path);
  const dirNames = await listSkillDirs(rootPath);

  for (const dirName of dirNames) {
    const skillDir = join(rootPath, dirName);
    const manifestPath = join(skillDir, MANIFEST_NAME);

    let stat: import("node:fs").Stats;
    try {
      stat = await lstat(manifestPath);
    } catch {
      // No SKILL.md in this directory → it is not a skill (shared references
      // dir, an `assets/`-only folder, etc.). Skip silently.
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push({ source: root.source, skillDir, reason: "manifest SKILL.md is a symlink (rejected)" });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ source: root.source, skillDir, reason: "manifest SKILL.md is not a regular file" });
      continue;
    }

    const text = await Bun.file(manifestPath).text();
    const parsed = parseSkillManifest(text);
    if ("error" in parsed) {
      errors.push({ source: root.source, skillDir, reason: parsed.error });
      continue;
    }

    skills.push({
      id: dirName,
      source: root.source,
      name: parsed.name,
      description: parsed.description,
      skillDir,
      manifestPath,
      rootRelativeManifestPath: `${dirName}/${MANIFEST_NAME}`,
    });
  }

  return { skills, errors };
}

/**
 * Scan multiple roots and merge results. Order is stable: roots are scanned in
 * array order and results concatenated, so a caller that lists built-ins first
 * then user skills gets a deterministic catalog. The scanner does NOT deduplicate
 * by id or name — a user skill with the same id as a built-in is surfaced
 * alongside it, and the catalog layer (Wave 2 / CTX-S3) decides precedence.
 */
export async function discoverSkills(roots: readonly ScanRoot[]): Promise<SkillScanResult> {
  const results = await Promise.all(roots.map(scanSkillRoot));
  return {
    skills: results.flatMap((r) => r.skills),
    errors: results.flatMap((r) => r.errors),
  };
}

// ─── Root resolvers (production wiring) ──────────────────────────────────────

/**
 * Resolve the built-in (read-only) skills root via the SAME candidate ladder
 * `resolvePromptAssetPath` uses for every prompt asset, then climb from a known
 * built-in manifest up to its containing `coauthor/skills` directory. This keeps
 * a single source of truth for asset location (env override → standalone
 * artifact → API source assets → cwd → build output) instead of forking it.
 *
 * Returns the resolved directory (which may not exist if the locator manifest
 * itself is missing — the caller treats a non-existent root as "no built-ins").
 */
export async function resolveBuiltinSkillsRoot(): Promise<string> {
  const locator = await resolvePromptAssetPath(BUILTIN_LOCATOR_MANIFEST);
  // locator = <skills-root>/profile-overview/SKILL.md → climb twice.
  return dirname(dirname(locator));
}

/**
 * Resolve the user (writable) skills root from a data directory: `<dataDir>/coauthor/skills`.
 * The directory is NOT created here — creation belongs to import (CTX-S2); a
 * missing root simply scans as empty.
 */
export function resolveUserSkillsRoot(dataDir: string): string {
  return resolve(dataDir, SKILLS_ASSET_DIR);
}
