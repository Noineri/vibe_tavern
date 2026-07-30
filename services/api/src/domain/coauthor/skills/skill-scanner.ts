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

import { lstat } from "node:fs/promises";
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
/** A built-in manifest that always exists after the Wave-3 skill-bundle rebuild — used to locate the built-in root. */
const BUILTIN_LOCATOR_MANIFEST = `${SKILLS_ASSET_DIR}/character-workshop/${MANIFEST_NAME}`;

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
  const dirNames: string[] = [];

  try {
    for await (const entry of new Bun.Glob("*").scan({
      cwd: rootPath,
      dot: true,
      followSymlinks: false,
      onlyFiles: false,
    })) {
      if (!isSafeSkillDirName(entry)) continue;

      const stat = await lstat(join(rootPath, entry));
      if (stat.isDirectory() && !stat.isSymbolicLink()) dirNames.push(entry);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw e;
  }

  return dirNames.sort((a, b) => a.localeCompare(b));
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
 * alongside it, and the catalog layer ({@link buildSkillCatalog}) decides precedence.
 */
export async function discoverSkills(roots: readonly ScanRoot[]): Promise<SkillScanResult> {
  const results = await Promise.all(roots.map(scanSkillRoot));
  return {
    skills: results.flatMap((r) => r.skills),
    errors: results.flatMap((r) => r.errors),
  };
}

// ─── Catalog (merge + precedence) ────────────────────────────────────────────

/**
 * A catalog entry: a discovered skill plus whether it shadows a built-in. The
 * absolute paths (`skillDir`, `manifestPath`) are kept for server-side readers
 * (Wave 2's `read_skill_file`); the wire DTO strips them (CTX-S3 adapter).
 */
export interface SkillCatalogEntry extends DiscoveredSkill {
  /** True when a user skill with this id shadows a built-in (user precedence won). */
  readonly shadowsBuiltin: boolean;
}

export interface SkillCatalog {
  /** One entry per skill id (user precedence on collision), sorted by id. */
  readonly entries: SkillCatalogEntry[];
  /** Malformed-manifest errors surfaced from every root (not fatal). */
  readonly errors: SkillScanError[];
}

/**
 * Build the merged skill catalog: scan every root, then dedupe by id with
 * **user > built-in precedence** — a user skill with the same id as a built-in
 * shadows it (the user wins), and its entry is flagged `shadowsBuiltin`. This is
 * the standard "user customizes/overrides a built-in" model: importing a same-id
 * skill is a shadow, and deleting it removes only the user copy (restoring the
 * built-in) — handled by `deleteUserSkill`, which never touches the built-in root.
 *
 * Precedence is enforced by iterating built-ins BEFORE user skills when filling
 * the id map, so the result is independent of the input root order. Entries are
 * sorted by id for a stable catalog. Malformed manifests do not abort the build;
 * they are returned in `errors`.
 */
export async function buildSkillCatalog(roots: readonly ScanRoot[]): Promise<SkillCatalog> {
  const { skills, errors } = await discoverSkills(roots);
  const builtinIds = new Set(skills.filter((s) => s.source === "builtin").map((s) => s.id));

  const byId = new Map<string, DiscoveredSkill>();
  // Builtin first, then user → a user entry with a colliding id overwrites the
  // built-in in the map (user precedence), regardless of the caller's root order.
  const ordered = [...skills].sort((a, b) => {
    const au = a.source === "user" ? 1 : 0;
    const bu = b.source === "user" ? 1 : 0;
    return au - bu;
  });
  for (const skill of ordered) byId.set(skill.id, skill);

  const entries: SkillCatalogEntry[] = [...byId.values()]
    .map((skill) => ({
      ...skill,
      shadowsBuiltin: skill.source === "user" && builtinIds.has(skill.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { entries, errors };
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
  // locator = <skills-root>/character-workshop/SKILL.md → climb twice.
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
