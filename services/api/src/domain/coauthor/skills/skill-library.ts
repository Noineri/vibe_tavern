/**
 * Filesystem skill library — mutating operations (import / delete / save).
 * COAUTHOR_TOOLSET_EXPANSION_PLAN, Wave 1 (CTX-S2); save is AGENT_SHELL_POLISH,
 * Wave 5 (AP-23a).
 *
 * The read-only discovery lives in `skill-scanner.ts`; this module owns the
 * three operations that change the user skill root (`<dataDir>/coauthor/skills`):
 *
 *  - {@link importSkillTree}: validate a complete set of ordinary files (each
 *    with its relative path) IN MEMORY, then recreate the directory tree
 *    atomically under the user root. A failed validation writes nothing.
 *  - {@link deleteUserSkill}: remove one top-level user skill directory.
 *    Built-in skill ids are rejected (built-in immutability).
 *  - {@link saveUserSkill}: the ONE save operation behind `POST .../skills`
 *    (create) and `PUT .../skills/:id` (update) — create derives the folder id
 *    from the name and reuses {@link importSkillTree} to write it; update
 *    rewrites ONLY the user copy's `SKILL.md` (frontmatter rebuilt from the
 *    existing block, every key kept) through an atomic staged rename. Both
 *    paths gate on `parseSkillManifest` BEFORE any write.
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

import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSkillManifest, buildSkillCatalog, skillManifestBody, locateFrontmatter } from "./skill-scanner.js";
import type { SkillCatalog, SkillCatalogEntry, ScanRoot } from "./skill-scanner.js";
import { readSkillFile, SkillReadError } from "./skill-read-tool.js";
import { conflict, internal, notFound, validation } from "../../../shared/errors.js";
import type { SkillImportResult, SkillContentDto } from "@vibe-tavern/api-contracts";
// Re-export so callers importing from this module keep resolving; the
// canonical wire type lives in api-contracts (single source of truth).
export type { SkillImportResult };

// ─── Types ───────────────────────────────────────────────────────────────────

/** One ordinary file to import: a POSIX-style relative path plus its bytes. */
export interface SkillImportFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
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
      await Bun.write(dest, entry.bytes);
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
  const root = resolve(userRoot);
  assertSafeSkillId(id, root);
  const target = resolve(root, id);

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

/**
 * Reject skill ids that could escape or confuse the user root — the SAME rules
 * for every mutating operation (delete, save-update): empty input, traversal
 * (`.`/`..`), separators, NUL bytes, and any id that resolves outside the root
 * (defense in depth beyond the character check). Throws
 * {@link SkillImportError} (a 400-class client error at the route layer).
 */
function assertSafeSkillId(id: string, root: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new SkillImportError("skill id is empty");
  }
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new SkillImportError(`refusing unsafe skill id: ${id}`);
  }
  const target = resolve(root, id);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new SkillImportError(`skill id escapes the skill root: ${id}`);
  }
}

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
  const dirNames: string[] = [];

  try {
    for await (const entry of new Bun.Glob("*").scan({
      cwd: rootDir,
      dot: true,
      followSymlinks: false,
      onlyFiles: false,
    })) {
      const stat = await lstat(join(rootDir, entry));
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (entry.startsWith(STAGING_PREFIX) || entry.startsWith(TRASH_PREFIX)) continue;
      dirNames.push(entry);
    }

    return dirNames.sort();
  } catch {
    return [];
  }
}

/**
 * List the ordinary files inside ONE skill folder (AP-21): POSIX-style paths
 * relative to the skill directory, sorted, with `SKILL.md` EXCLUDED (the
 * manifest is surfaced separately as the content view's `content`/`body`, so
 * listing it again would be redundant). Symlinks are skipped and never
 * followed — the same sandbox convention as the scanner's `listSkillDirs` and
 * `readSkillFile`, so the listing can never escape the skill folder. A
 * missing/unreadable folder reads as an empty list (the same tolerant
 * convention as {@link listTopLevelDirs}); the caller then shows the skill as
 * manifest-only.
 */
export async function listSkillFolderFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    for await (const entry of new Bun.Glob("**/*").scan({
      cwd: skillDir,
      dot: true,
      followSymlinks: false,
      onlyFiles: true,
    })) {
      const stat = await lstat(join(skillDir, entry));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const posixPath = entry.replace(/\\/g, "/");
      if (posixPath === MANIFEST_NAME) continue;
      files.push(posixPath);
    }

    return files.sort();
  } catch {
    return [];
  }
}

// ─── Service (owns roots, caches built-in ids) ───────────────────────────────

// ─── Id derivation (create path) ─────────────────────────────────────────────

/**
 * Latin replacements for the 32 lowercase Cyrillic letters, indexed by their
 * code-point offset from U+0430 (the contiguous Cyrillic block U+0430..U+044F
 * runs a..ya with no gaps). Pure DATA for the save operation's folder-id
 * derivation (AP-23a): spelled as code-point offsets instead of Cyrillic
 * literals because the code repo is Cyrillic-free (owner ruling 2026-09-19;
 * vt-guard enforces it on staged added-lines). The uppercase counterparts
 * (U+0410..U+042F) reuse this table with the replacement title-cased; yo
 * (U+0451/U+0401) sits outside the block and maps to e/E. Transliteration
 * scheme: the common BGN/PCGN-style letter map (kh for KHA, shch for SHCHA,
 * hard/soft signs dropped) — chosen for familiarity; ids are one-way slugs,
 * so no round-trip property is needed.
 */
const CYRILLIC_TO_LATIN: readonly string[] = [
  "a", "b", "v", "g", "d", "e", // U+0430..U+0435
  "zh", "z", "i", "y", // U+0436..U+0439
  "k", "l", "m", "n", "o", "p", // U+043A..U+043F
  "r", "s", "t", "u", "f", // U+0440..U+0444
  "kh", "ts", "ch", "sh", "shch", // U+0445..U+0449
  "", "y", "", "e", // U+044A..U+044D: hard sign dropped, y, soft sign dropped, e
  "yu", "ya", // U+044E..U+044F
];

/** One-way Cyrillic → latin transliteration for folder-id derivation. */
function transliterateCyrillic(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.charCodeAt(0);
    if (cp >= 0x0430 && cp <= 0x044f) {
      out += CYRILLIC_TO_LATIN[cp - 0x0430];
    } else if (cp >= 0x0410 && cp <= 0x042f) {
      const replacement = CYRILLIC_TO_LATIN[cp - 0x0410];
      out += replacement.length === 0 ? "" : replacement[0].toUpperCase() + replacement.slice(1);
    } else if (cp === 0x0451) {
      out += "e";
    } else if (cp === 0x0401) {
      out += "E";
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Derive a new skill folder id from a display name: transliterate Cyrillic to
 * latin (the table above — NEW derivation, deliberately not the import-export
 * package's `slugify`, which strips every non-ASCII character and would fold
 * ALL non-latin names into one fallback id), lowercase, collapse every
 * non-[a-z0-9] run into a single hyphen, trim edge hyphens. A name with no
 * transliteratable characters (another script, punctuation-only) falls back to
 * `skill`; de-duplication then suffixes it like any other id.
 */
export function skillIdFromName(name: string): string {
  const slug = transliterateCyrillic(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "skill";
}

// ─── Save (create / update) ────────────────────────────────────────────────────────────────────────────────────────

/** One skill save request (AP-23a): manifest `name`/`description` + skill `body`. */
export interface SkillSaveInput {
  /** Existing skill id to overwrite (update); omit to create a new skill. */
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/**
 * Assemble a manifest document from a frontmatter mapping and the skill body:
 * the YAML fences plus `Bun.YAML.stringify(mapping)` and the body verbatim.
 * The stringified mapping is a single line (stringify quotes any value that
 * could break the fence scan), so the closing fence is always line 2 and the
 * scanner's fence parser reads it back deterministically.
 */
function buildManifestText(mapping: Record<string, unknown>, body: string): string {
  return `---\n${Bun.YAML.stringify(mapping)}\n---\n\n${body}`;
}

/**
 * The write gate (parse-before-write): the assembled manifest must parse as a
 * valid skill manifest BEFORE any filesystem write, so an invalid save (e.g. a
 * whitespace-only name, which YAML would happily carry but the scanner would
 * reject) leaves the user root untouched — no partial folder, no empty file.
 * Throws a 400-class validation DomainError on failure.
 */
function assertManifestParses(manifestText: string): void {
  const parsed = parseSkillManifest(manifestText);
  if ("error" in parsed) {
    throw validation(`refusing to write an invalid skill manifest: ${parsed.error}`);
  }
}

/**
 * The ONE save operation (AGENT_SHELL_POLISH, AP-23a) behind `POST .../skills`
 * (create) and `PUT .../skills/:id` (update) on BOTH route families (copilot
 * per-kind and Co-Author — they differ only in roots, never in save logic).
 *
 * CREATE (`id` absent): the folder id is derived from the name via
 * {@link skillIdFromName} and de-duplicated against BOTH roots — every
 * top-level user directory (any directory physically occupies the name) and
 * every built-in skill id (a create must never shadow a built-in: the
 * user-wins precedence is reserved for imports, and a save under a shadowed
 * id hits the read-only 409 below) — with `-2`, `-3`, ... suffixes. The
 * manifest starts from a MINIMAL mapping (`name` + `description` only —
 * exactly what `parseSkillManifest` requires of discovery metadata); the
 * write itself reuses {@link importSkillTree}, the SAME atomic
 * stage-and-rename mechanism the import uses (one write mechanism, no second
 * one).
 *
 * UPDATE (`id` present): rewrites ONLY `<userRoot>/<id>/SKILL.md`. The
 * manifest is rebuilt from the EXISTING frontmatter — every key kept, only
 * `name`/`description` replaced — and the file is swapped atomically: staged
 * into the same hidden staging sibling the import uses, then renamed over the
 * target on the same volume. Every OTHER file of the skill folder
 * (`references/`, `assets/`, ...) is untouched. Built-in ids are read-only: an
 * update under a built-in id — a pure built-in or a user shadow — is a 409
 * Conflict (duplicating into a new id is the user's path).
 *
 * Both paths run {@link assertManifestParses} before any write; a failure
 * writes nothing. Errors: {@link SkillImportError} for an unsafe id (the same
 * vocabulary as delete, a 400 at the route); DomainError `validation` (400)
 * for an invalid manifest or an unparseable target; DomainError `notFound`
 * (404) for an update of a missing id; DomainError `conflict` (409) for a
 * built-in id.
 */
export async function saveUserSkill(
  input: SkillSaveInput,
  userRoot: string,
  builtinSkillIds: readonly string[] = [],
): Promise<{ id: string }> {
  const root = resolve(userRoot);

  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw validation("skill name must be a non-empty string");
  }

  if (input.id === undefined) {
    // ── Create: derive + de-dupe the folder id, then write via the import.
    const taken = new Set<string>([...(await listTopLevelDirs(root)), ...builtinSkillIds]);
    const base = skillIdFromName(input.name);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

    const manifestText = buildManifestText({ name: input.name, description: input.description }, input.body);
    assertManifestParses(manifestText);

    await importSkillTree(
      [{ relativePath: `${id}/${MANIFEST_NAME}`, bytes: new TextEncoder().encode(manifestText) }],
      root,
    );
    return { id };
  }

  // ── Update: rewrite only the user copy's SKILL.md, atomically.
  assertSafeSkillId(input.id, root);
  if (builtinSkillIds.includes(input.id)) {
    throw conflict(
      `cannot update built-in skill '${input.id}' (built-in skills are read-only; save it under a new name instead)`,
    );
  }

  const skillDir = join(root, input.id);
  const dirStat = await lstat(skillDir).catch(() => null);
  if (dirStat === null) {
    throw notFound("skill", `skill '${input.id}' does not exist`);
  }
  if (dirStat.isSymbolicLink()) {
    throw validation(`refusing to write through a symlinked skill directory '${input.id}'`);
  }

  const manifestPath = join(skillDir, MANIFEST_NAME);
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (manifestStat === null) {
    throw notFound("skill", `skill '${input.id}' has no ${MANIFEST_NAME} manifest`);
  }
  if (manifestStat.isSymbolicLink()) {
    throw validation(`refusing to overwrite a symlinked ${MANIFEST_NAME} at '${input.id}'`);
  }

  // Rebuild the frontmatter from the existing manifest: EVERY key kept, only
  // name/description replaced; the body below the fence is replaced wholesale
  // (the editor's new text).
  const existing = await Bun.file(manifestPath).text();
  const split = locateFrontmatter(existing);
  if (split === null) {
    throw validation(`skill '${input.id}' has no YAML frontmatter block to rebuild`);
  }
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(split.frontmatter);
  } catch (e) {
    throw validation(`skill '${input.id}' has unreadable frontmatter: ${(e as Error).message}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw validation(`skill '${input.id}' frontmatter is not a YAML mapping`);
  }
  const mapping: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  mapping.name = input.name;
  mapping.description = input.description;

  const manifestText = buildManifestText(mapping, input.body);
  assertManifestParses(manifestText);

  // Atomic single-file swap: stage into the same hidden staging sibling the
  // import uses (same volume), then rename over the target. The skill
  // directory and every other file in it stay in place.
  const staging = join(dirname(root), `${STAGING_PREFIX}${randomUUID()}`);
  try {
    const staged = join(staging, input.id, MANIFEST_NAME);
    await mkdir(dirname(staged), { recursive: true });
    await Bun.write(staged, new TextEncoder().encode(manifestText));
    await rename(staged, manifestPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { id: input.id };
}

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

  /**
   * The ONE save operation (AP-23a) both skill route families call: create
   * (`id` absent — folder id derived from the name, de-duped against both
   * roots) or update (`id` present — rewrite only the user copy's SKILL.md;
   * built-in ids are 409-conflict). Returns the FRESH catalog entry of the
   * saved skill — the adapters derive the wire DTO from it with the same
   * `toDto` every other read path uses (one derivation).
   */
  saveSkill = async (input: SkillSaveInput): Promise<SkillCatalogEntry> => {
    const builtinIds = await this.getBuiltinSkillIds();
    const { id } = await saveUserSkill(input, this.userRoot, builtinIds);
    const entry = await this.readCatalogEntry(id);
    if (entry === null) {
      // Unreachable unless the write silently failed: the manifest was
      // parse-validated before the atomic write.
      throw internal(`saved skill '${id}' is not discoverable after the write`);
    }
    return entry;
  };

  /** Read-only merged catalog (built-in + user, user precedence on id collision). */
  listCatalog = async (): Promise<SkillCatalog> =>
    buildSkillCatalog(this.scanRoots());

  /** One catalog entry by id, or `null` if no such skill exists in either root. */
  readCatalogEntry = async (id: string): Promise<SkillCatalogEntry | null> => {
    const { entries } = await this.listCatalog();
    return entries.find((e) => e.id === id) ?? null;
  };

  /**
   * Full content view of one skill (AGENT_SHELL_POLISH, AP-21) — the ONE
   * derivation both skill route families (Co-Author and per-kind copilot) call:
   * the manifest read goes through the SAME sandboxed {@link readSkillFile} the
   * model tool uses, with the user root first so a user shadow of a built-in
   * wins (matching the catalog precedence); `body` is the manifest text with
   * its frontmatter block stripped (the skill editor's text view, derived by
   * the scanner's single fence parser); `files` lists the WINNING folder's
   * relative file paths with the manifest excluded. Returns `null` when the id
   * is not in the catalog or the manifest is unreadable through the sandboxed
   * reader — an unreadable manifest reads as not-found, the metadata routes'
   * 404 convention.
   */
  readSkillContent = async (id: string): Promise<SkillContentDto | null> => {
    const entry = await this.readCatalogEntry(id);
    if (entry === null) return null;

    try {
      // User root first — the same root order the catalog merge uses, so the
      // manifest read and the folder listing always describe the same winner.
      const manifest = await readSkillFile(`${id}/${MANIFEST_NAME}`, [this.userRoot, this.builtinRoot]);
      const body = skillManifestBody(manifest.content) ?? manifest.content;
      const files = await listSkillFolderFiles(entry.skillDir);
      return { id, path: manifest.path, content: manifest.content, body, files };
    } catch (err) {
      if (err instanceof SkillReadError) return null;
      throw err;
    }
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
