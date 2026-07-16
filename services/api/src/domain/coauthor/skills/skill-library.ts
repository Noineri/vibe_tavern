/**
 * Filesystem skill library — mutating operations (import / delete).
 * COAUTHOR_TOOLSET_EXPANSION_PLAN, Wave 1 (CTX-S2).
 *
 * The read-only discovery lives in `skill-scanner.ts`; this module owns the
 * two operations that change the user skill root (`<dataDir>/coauthor/skills`):
 *
 *  - {@link importSkillTree}: validate a complete set of ordinary files (each
 *    with its relative path) IN MEMORY, then recreate the directory tree
 *    atomically under the user root. A failed validation writes nothing.
 *  - {@link deleteUserSkill}: remove one top-level user skill directory.
 *    Built-in skill ids are rejected (built-in immutability).
 *
 * The service is input-agnostic: it takes `{ relativePath, bytes }` records,
 * not Hono `File` objects, so it is exercised directly by tests and could be
 * fed by either a multipart upload (CTX-S2 route) or a future server-side
 * folder read. No SQLite — skills are canonical files on disk.
 *
 * Path safety: every relative path is normalized (backslashes → forward), then
 * rejected if absolute, traversal, empty, NUL-bearing, or resolving outside the
 * user root. Manifests (`SKILL.md`) are parsed via the shared
 * `parseSkillManifest`; a malformed manifest rejects the whole import before
 * any byte is written, so a partial tree can never be left behind.
 */

import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSkillManifest, buildSkillCatalog } from "./skill-scanner.js";
import type { SkillCatalog, SkillCatalogEntry, ScanRoot } from "./skill-scanner.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One ordinary file to import: a POSIX-style relative path plus its bytes. */
export interface SkillImportFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Result of a successful import: the top-level skill ids written (dirs with a SKILL.md). */
export interface SkillImportResult {
  /** Top-level directories that contain a SKILL.md after the import (the actual skills). */
  readonly importedSkillIds: string[];
  /** Every top-level directory written, including non-skill siblings (e.g. shared references). */
  readonly importedTopLevelDirs: string[];
}

export class SkillImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillImportError";
  }
}

// ─── Internal constants ──────────────────────────────────────────────────────

const MANIFEST_NAME = "SKILL.md";
/** Hidden staging/trash prefix (siblings of the skills root, same volume for atomic rename). */
const STAGING_PREFIX = ".~vt-skill-staging-";
const TRASH_PREFIX = ".~vt-skill-trash-";

// ─── Path validation ─────────────────────────────────────────────────────────

/**
 * Validate and normalize ONE relative file path against the user skill root.
 * Returns the POSIX-style normalized path (`a/b/c.md`). Throws
 * {@link SkillImportError} for: empty input, absolute paths (POSIX or Windows
 * drive), backslash/forward-slash traversal (`..`, `.`), NUL bytes, empty
 * segments, and any path that resolves outside the user root (defense in depth
 * beyond the segment check).
 */
export function validateRelativePath(rawPath: string, userRoot: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new SkillImportError("file path is empty");
  }
  // Normalize separators: Windows clients (and some webkit paths) use backslashes.
  const normalized = rawPath.replace(/\\/g, "/");

  if (/\0/.test(normalized)) {
    throw new SkillImportError(`file path contains a NUL byte: ${rawPath}`);
  }
  // Absolute (POSIX leading '/') or a Windows drive letter.
  if (normalized.startsWith("/") || /^[A-Za-z]:[\/\\]/.test(rawPath)) {
    throw new SkillImportError(`refusing absolute file path: ${rawPath}`);
  }

  const trimmed = normalized.replace(/^\.\/+/, "");
  if (trimmed.length === 0) {
    throw new SkillImportError(`file path is empty after normalization: ${rawPath}`);
  }

  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg === "") {
      throw new SkillImportError(`file path has an empty segment (double slash or trailing slash): ${rawPath}`);
    }
    if (seg === "." || seg === "..") {
      throw new SkillImportError(`refusing path traversal segment '${seg}': ${rawPath}`);
    }
  }

  // Defense in depth: resolve against the root and confirm it stays inside.
  const resolved = resolve(userRoot, trimmed);
  const rel = relative(userRoot, resolved);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new SkillImportError(`file path escapes the skill root: ${rawPath}`);
  }
  return trimmed;
}

// ─── Import ──────────────────────────────────────────────────────────────────

interface PreparedEntry {
  readonly normalizedPath: string;
  readonly bytes: Uint8Array;
  readonly topLevelDir: string;
}

/**
 * Prepare + validate every file in memory BEFORE any disk write. Throws
 * {@link SkillImportError} on the first problem (unsafe path, duplicate path,
 * malformed manifest, or no skill in the tree) — and because nothing has been
 * written yet, a failure leaves the user root untouched.
 */
function prepareImport(files: readonly SkillImportFile[], userRoot: string): {
  entries: Map<string, PreparedEntry>;
  skillIds: string[];
} {
  if (files.length === 0) {
    throw new SkillImportError("no files provided");
  }

  const entries = new Map<string, PreparedEntry>();
  const topLevelDirs = new Set<string>();
  const manifestPaths: string[] = [];

  for (const file of files) {
    const normalizedPath = validateRelativePath(file.relativePath, userRoot);
    // Last-write-wins on a duplicate path (deterministic; the client should not
    // send the same path twice, but we do not crash on it).
    const segments = normalizedPath.split("/");
    const topLevelDir = segments[0];
    topLevelDirs.add(topLevelDir);

    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    entries.set(normalizedPath, { normalizedPath, bytes, topLevelDir });

    // Any file named SKILL.md is a manifest: it must parse. A bare root-level
    // `SKILL.md` (no parent dir) is rejected — the skill root holds skill
    // DIRECTORIES, each with its own manifest; a root-level manifest would make
    // the root itself a skill, which breaks the directory contract.
    if (segments[segments.length - 1] === MANIFEST_NAME) {
      if (segments.length < 2) {
        throw new SkillImportError(
          "a root-level SKILL.md is not allowed — skills must live in their own directory",
        );
      }
      manifestPaths.push(normalizedPath);
    }
  }

  if (manifestPaths.length === 0) {
    throw new SkillImportError("import contains no SKILL.md manifest — not a skill tree");
  }

  // Validate every manifest parses (discovery metadata is well-formed). Parse
  // results are intentionally discarded: we never rewrite the file, only gate
  // the import on the manifest being readable.
  const skillIds = new Set<string>();
  for (const manifestPath of manifestPaths) {
    const entry = entries.get(manifestPath)!;
    const text = new TextDecoder().decode(entry.bytes);
    const parsed = parseSkillManifest(text);
    if ("error" in parsed) {
      throw new SkillImportError(`manifest ${manifestPath}: ${parsed.error}`);
    }
    // A manifest at <dir>/SKILL.md (depth 2) marks that top-level dir a skill.
    // Deeper manifests (e.g. nested examples) validate but do not register a
    // new top-level skill — only the direct child of the root is a skill id.
    const segments = manifestPath.split("/");
    if (segments.length === 2) {
      skillIds.add(segments[0]);
    }
  }

  if (skillIds.size === 0) {
    throw new SkillImportError("import contains no top-level skill directory with a SKILL.md");
  }

  return { entries, skillIds: [...skillIds].sort() };
}

/**
 * Validate + write a skill tree atomically. The full tree is staged into a
 * hidden sibling of the user root, then each top-level directory is swapped
 * into place with a rename (same filesystem → atomic). Existing top-level dirs
 * are moved to a trash sibling first, so an overwrite never half-replaces a
 * skill. Staging and trash are cleaned up in every outcome.
 *
 * Returns the imported skill ids (top-level dirs containing a SKILL.md) and the
 * full set of top-level dirs written.
 */
export async function importSkillTree(
  files: readonly SkillImportFile[],
  userRoot: string,
): Promise<SkillImportResult> {
  const root = resolve(userRoot);
  // Validate everything in memory FIRST — a rejection here writes nothing.
  const { entries, skillIds } = prepareImport(files, root);

  await mkdir(root, { recursive: true });

  const staging = join(dirname(root), `${STAGING_PREFIX}${randomUUID()}`);
  const trash = join(dirname(root), `${TRASH_PREFIX}${randomUUID()}`);
  let committed = false;

  try {
    // 1. Write the full tree into staging.
    for (const entry of entries.values()) {
      const dest = join(staging, entry.normalizedPath);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, entry.bytes);
    }

    // 2. Swap each top-level directory into place. Atomic per dir: move any
    //    existing target to trash, then rename the staged dir over it.
    const topLevelDirs = [...new Set([...entries.values()].map((e) => e.topLevelDir))].sort();
    for (const dir of topLevelDirs) {
      const target = join(root, dir);
      const staged = join(staging, dir);
      if (await pathExists(target)) {
        await mkdir(trash, { recursive: true });
        await rename(target, join(trash, dir));
      }
      await rename(staged, target);
    }
    committed = true;

    return {
      importedSkillIds: skillIds,
      importedTopLevelDirs: topLevelDirs,
    };
  } finally {
    // Clean up staging always. Clean up trash only after a successful swap —
    // on a mid-swap failure we keep the trash so the previous skill content is
    // recoverable (the user root is still consistent: each dir is either the
    // new version or the untouched original).
    await rm(staging, { recursive: true, force: true });
    if (committed) {
      await rm(trash, { recursive: true, force: true });
    }
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete one top-level user skill directory. Rejects (throws) when:
 *  - the id is unsafe (traversal/absolute/empty) — never resolves outside root;
 *  - the id has NO user directory AND is a built-in skill (built-in immutability:
 *    a pure built-in cannot be removed — it lives in the read-only assets root);
 *  - the id has NO user directory and is not a built-in (does not exist).
 *
 * A user skill that SHADOWS a built-in (same id, user imported their own copy)
 * IS deletable: deleting removes only the user directory under `userRoot`, so the
 * built-in file under the assets root is never touched and reappears in the
 * catalog once the shadow is gone. `builtinSkillIds` is the set of ids discovered
 * in the built-in root (from the scanner), used only to distinguish a pure
 * built-in delete (rejected) from a genuinely missing id.
 */
export async function deleteUserSkill(
  id: string,
  userRoot: string,
  builtinSkillIds: readonly string[] = [],
): Promise<{ id: string }> {
  if (typeof id !== "string" || id.length === 0) {
    throw new SkillImportError("skill id is empty");
  }
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new SkillImportError(`refusing unsafe skill id: ${id}`);
  }

  const root = resolve(userRoot);
  const target = resolve(root, id);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new SkillImportError(`skill id escapes the skill root: ${id}`);
  }

  const stat = await lstat(target).catch(() => null);
  if (stat?.isSymbolicLink()) {
    throw new SkillImportError(`refusing to delete a symlink at '${id}'`);
  }
  if (!stat) {
    // No user directory for this id. If it is a built-in, that is the
    // immutability boundary (cannot remove a read-only built-in); otherwise the
    // id simply does not exist.
    if (builtinSkillIds.includes(id)) {
      throw new SkillImportError(`cannot delete built-in skill '${id}' (built-in skills are read-only)`);
    }
    throw new SkillImportError(`skill '${id}' does not exist`);
  }

  // A real user directory (possibly a shadow of a built-in) — deletable.
  await rm(target, { recursive: true, force: true });
  return { id };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Test/help: list immediate top-level directory names under a root (non-recursive, no symlink dirs). */
export async function listTopLevelDirs(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith(STAGING_PREFIX) && !e.name.startsWith(TRASH_PREFIX))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ─── Service (owns roots, caches built-in ids) ───────────────────────────────

/**
 * Domain service that owns the resolved skill roots and exposes the mutating
 * operations (import/delete) AND the read-only catalog (list/read) to the
 * adapter layer. The built-in skill ids are scanned lazily and cached (they
 * change only on an application update, never at runtime), so the
 * built-in-immutability check on delete is a single lookup after the first call.
 * Read-only discovery + catalog merge live in the scanner (`buildSkillCatalog`).
 */
export class SkillLibraryService {
  private builtinIdsCache: readonly string[] | null = null;

  constructor(
    private readonly userRoot: string,
    private readonly builtinRoot: string,
  ) {}

  importSkills = (files: readonly SkillImportFile[]): Promise<SkillImportResult> =>
    importSkillTree(files, this.userRoot);

  deleteSkill = async (id: string): Promise<{ id: string }> => {
    const builtinIds = await this.getBuiltinSkillIds();
    return deleteUserSkill(id, this.userRoot, builtinIds);
  };

  /** Read-only merged catalog (built-in + user, user precedence on id collision). */
  listCatalog = async (): Promise<SkillCatalog> =>
    buildSkillCatalog(this.scanRoots());

  /** One catalog entry by id, or `null` if no such skill exists in either root. */
  readCatalogEntry = async (id: string): Promise<SkillCatalogEntry | null> => {
    const { entries } = await this.listCatalog();
    return entries.find((e) => e.id === id) ?? null;
  };

  /** The resolved roots this service reads from / writes to. */
  readonly roots = (): { userRoot: string; builtinRoot: string } => ({
    userRoot: this.userRoot,
    builtinRoot: this.builtinRoot,
  });

  private readonly scanRoots = (): ScanRoot[] => [
    { path: this.builtinRoot, source: "builtin" },
    { path: this.userRoot, source: "user" },
  ];

  private async getBuiltinSkillIds(): Promise<readonly string[]> {
    if (this.builtinIdsCache) return this.builtinIdsCache;
    // Import lazily to avoid a static cycle (scanner ↔ library share helpers).
    const { scanSkillRoot } = await import("./skill-scanner.js");
    const { skills } = await scanSkillRoot({ path: this.builtinRoot, source: "builtin" });
    this.builtinIdsCache = skills.map((s) => s.id);
    return this.builtinIdsCache;
  }
}
