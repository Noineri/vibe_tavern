import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteUserSkill,
  importSkillTree,
  listTopLevelDirs,
  SkillImportError,
  validateRelativePath,
  type SkillImportFile,
} from "../src/domain/coauthor/skills/skill-library.js";
import { scanSkillRoot } from "../src/domain/coauthor/skills/skill-scanner.js";
import { SkillLibraryService } from "../src/domain/coauthor/skills/skill-library.js";

/**
 * CTX-S2 — Filesystem skill library (import + delete). Pins the eight
 * self-check categories the COAUTHOR_TOOLSET_EXPANSION_PLAN Wave 1 S2 gate
 * requires: traversal, absolute path, symlink/regular-file, partial failure
 * (atomic — no partial tree), overwrite, rescan, delete, and built-in
 * immutability. The service is input-agnostic (`{ relativePath, bytes }`),
 * so every case is driven in-memory against a temp user root — no HTTP.
 */

const tmpRoots: string[] = [];
let userRoot = "";

async function freshRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "coauthor-skill-lib-"));
  tmpRoots.push(d);
  return d;
}

beforeEach(async () => {
  userRoot = await freshRoot();
});
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function file(relativePath: string, text: string): SkillImportFile {
  return { relativePath, bytes: enc(text) };
}

function manifest(name: string, description = "A skill.", body = `# ${name}\nBody.\n`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

async function readText(p: string): Promise<string> {
  return await Bun.file(p).text();
}

// ─── validateRelativePath ────────────────────────────────────────────────────

describe("validateRelativePath", () => {
  test("accepts a simple relative path and normalizes backslashes", () => {
    expect(validateRelativePath("a/b.md", userRoot)).toBe("a/b.md");
    expect(validateRelativePath("a\\b.md", userRoot)).toBe("a/b.md");
    expect(validateRelativePath("./a/b.md", userRoot)).toBe("a/b.md");
  });

  test("rejects traversal, absolute, empty, and NUL", () => {
    expect(() => validateRelativePath("../x.md", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("a/../../x.md", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("a/../b.md", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("/etc/passwd", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("C:\\Windows\\x", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("a\0b.md", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("a//b.md", userRoot)).toThrow(SkillImportError);
    expect(() => validateRelativePath("a/b.md/", userRoot)).toThrow(SkillImportError);
  });
});

// ─── importSkillTree — happy path + rescan ───────────────────────────────────

describe("importSkillTree — happy path + rescan", () => {
  test("writes the full tree, returns skill ids, and scanner discovers the skill", async () => {
    const files: SkillImportFile[] = [
      file("janitor-card-creator/SKILL.md", manifest("janitor-card-creator", "Creates cards.")),
      file("janitor-card-creator/assets/character-template.md", "# Template\n..."),
      file("janitor-card-creator/references/creation-rules.md", "# Rules\n..."),
      // A non-skill sibling dir is written but is not a skill id.
      file("shared-card-references/evaluation-principles.md", "# Evaluation principles"),
    ];

    const result = await importSkillTree(files, userRoot);
    expect(result.importedSkillIds).toEqual(["janitor-card-creator"]);
    expect(result.importedTopLevelDirs).toEqual(["janitor-card-creator", "shared-card-references"]);

    // Files written at their relative paths.
    expect(await readText(join(userRoot, "janitor-card-creator", "SKILL.md"))).toContain("Creates cards.");
    expect(await readText(join(userRoot, "janitor-card-creator", "assets", "character-template.md"))).toBe("# Template\n...");
    expect(await readText(join(userRoot, "shared-card-references", "evaluation-principles.md"))).toBe("# Evaluation principles");

    // Rescan (scanner integration): only the dir with a SKILL.md is a skill.
    const { skills } = await scanSkillRoot({ path: userRoot, source: "user" });
    expect(skills.map((s) => s.id)).toEqual(["janitor-card-creator"]);
    expect(skills[0].description).toBe("Creates cards.");
  });

  test("writes only regular files and directories (no symlinks)", async () => {
    await importSkillTree(
      [
        file("a-skill/SKILL.md", manifest("a-skill")),
        file("a-skill/assets/x.md", "x"),
      ],
      userRoot,
    );
    const walk = async (dir: string): Promise<import("node:fs").Stats[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: import("node:fs").Stats[] = [];
      for (const e of entries) {
        const p = join(dir, e.name);
        const st = await lstat(p);
        expect(st.isSymbolicLink()).toBe(false);
        out.push(st);
        if (e.isDirectory()) out.push(...await walk(p));
      }
      return out;
    };
    const stats = await walk(userRoot);
    expect(stats.every((s) => s.isFile() || s.isDirectory())).toBe(true);
  });

  test("duplicate relative path: last entry wins", async () => {
    await importSkillTree(
      [
        file("dup/SKILL.md", manifest("dup", "first")),
        file("dup/SKILL.md", manifest("dup", "second")),
      ],
      userRoot,
    );
    expect(await readText(join(userRoot, "dup", "SKILL.md"))).toContain("second");
  });
});

// ─── importSkillTree — rejections (atomic: nothing written) ──────────────────

describe("importSkillTree — rejections write nothing", () => {
  test("traversal path → rejected, no tree written", async () => {
    await expect(
      importSkillTree([file("../escape.md", "x"), file("a/SKILL.md", manifest("a"))], userRoot),
    ).rejects.toThrow(SkillImportError);
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("absolute path → rejected, no tree written", async () => {
    await expect(
      importSkillTree([file("/etc/passwd", "x"), file("a/SKILL.md", manifest("a"))], userRoot),
    ).rejects.toThrow(SkillImportError);
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("malformed manifest among valid skills → whole import rejected, NOTHING written (atomic)", async () => {
    const good = file("good/SKILL.md", manifest("good"));
    const bad = file("bad/SKILL.md", "# no frontmatter at all");
    await expect(importSkillTree([good, bad], userRoot)).rejects.toThrow(SkillImportError);
    // Critical: the good skill was NOT written either — no partial tree.
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
    expect(await Bun.file(join(userRoot, "good", "SKILL.md")).exists()).toBe(false);
  });

  test("one unsafe path among many → whole import rejected, nothing written", async () => {
    await expect(
      importSkillTree([
        file("good/SKILL.md", manifest("good")),
        file("good/../../escape.md", "x"),
      ], userRoot),
    ).rejects.toThrow(SkillImportError);
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("no SKILL.md in the tree → rejected", async () => {
    await expect(
      importSkillTree([file("shared/x.md", "no manifest here")], userRoot),
    ).rejects.toThrow(/no SKILL.md manifest/);
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("root-level SKILL.md (no parent dir) → rejected", async () => {
    await expect(
      importSkillTree([file("SKILL.md", manifest("root"))], userRoot),
    ).rejects.toThrow(/root-level SKILL.md/);
  });

  test("empty file list → rejected", async () => {
    await expect(importSkillTree([], userRoot)).rejects.toThrow(/no files/);
  });
});

// ─── importSkillTree — overwrite ─────────────────────────────────────────────

describe("importSkillTree — overwrite (atomic replace)", () => {
  test("re-importing a skill replaces the directory wholesale (new content in, stale files gone)", async () => {
    // v1: two files.
    await importSkillTree(
      [
        file("my-skill/SKILL.md", manifest("my-skill", "v1")),
        file("my-skill/will-be-removed.md", "stale"),
      ],
      userRoot,
    );
    expect(await readText(join(userRoot, "my-skill", "SKILL.md"))).toContain("v1");
    expect(await Bun.file(join(userRoot, "my-skill", "will-be-removed.md")).exists()).toBe(true);

    // v2: SKILL.md updated, no will-be-removed.md, a new file added.
    await importSkillTree(
      [
        file("my-skill/SKILL.md", manifest("my-skill", "v2")),
        file("my-skill/new-file.md", "fresh"),
      ],
      userRoot,
    );

    expect(await readText(join(userRoot, "my-skill", "SKILL.md"))).toContain("v2");
    expect(await readText(join(userRoot, "my-skill", "new-file.md"))).toBe("fresh");
    // The stale file from v1 is gone — overwrite replaced the whole directory.
    expect(await Bun.file(join(userRoot, "my-skill", "will-be-removed.md")).exists()).toBe(false);
    // No staging/trash directories left behind.
    const top = await listTopLevelDirs(userRoot);
    expect(top).toEqual(["my-skill"]);
  });
});

// ─── deleteUserSkill ─────────────────────────────────────────────────────────

describe("deleteUserSkill", () => {
  test("deletes an imported skill directory; scanner no longer finds it", async () => {
    await importSkillTree([file("gone/SKILL.md", manifest("gone"))], userRoot);
    expect(await listTopLevelDirs(userRoot)).toEqual(["gone"]);

    const res = await deleteUserSkill("gone", userRoot, []);
    expect(res).toEqual({ id: "gone" });
    expect(await listTopLevelDirs(userRoot)).toEqual([]);

    const { skills } = await scanSkillRoot({ path: userRoot, source: "user" });
    expect(skills).toEqual([]);
  });

  test("pure built-in (no user dir) → rejected as read-only; nothing written", async () => {
    // No user directory exists for this id; it is a pure built-in. The built-in
    // files live in a separate root `deleteUserSkill` never touches — this is the
    // immutability boundary (the S2 user-verified case: DELETE profile-overview → 400).
    await expect(deleteUserSkill("profile-overview", userRoot, ["profile-overview"])).rejects.toThrow(
      /cannot delete built-in skill/,
    );
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("user shadow of a built-in → deletable, removes ONLY the user copy (built-in immutability preserved)", async () => {
    // A user imported their own copy of a built-in id (a shadow / customization).
    // The shadow lives under userRoot, so deleting it removes the user copy and
    // restores the built-in in the catalog — it does NOT touch the built-in root.
    await importSkillTree([file("profile-overview/SKILL.md", manifest("profile-overview", "user copy"))], userRoot);
    expect(await listTopLevelDirs(userRoot)).toEqual(["profile-overview"]);

    const res = await deleteUserSkill("profile-overview", userRoot, ["profile-overview"]);
    expect(res).toEqual({ id: "profile-overview" });
    // The user's shadow directory is gone; the (separate) built-in root is untouched.
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
    expect(await Bun.file(join(userRoot, "profile-overview", "SKILL.md")).exists()).toBe(false);
  });

  test("unsafe ids and missing dirs are rejected", async () => {
    await expect(deleteUserSkill("..", userRoot)).rejects.toThrow(SkillImportError);
    await expect(deleteUserSkill("a/b", userRoot)).rejects.toThrow(SkillImportError);
    await expect(deleteUserSkill("never-imported", userRoot)).rejects.toThrow(/does not exist/);
  });
});

// ─── SkillLibraryService — catalog (list/read) ───────────────────────────────

/**
 * CTX-S3 — the service-layer catalog. Verifies `listCatalog` / `readCatalogEntry`
 * merge the service's two roots with user precedence and that `deleteSkill`
 * honors the corrected shadow model (user shadow deletable, pure built-in
 * rejected) through the cached built-in id set.
 */
describe("SkillLibraryService — catalog + shadow-aware delete", () => {
  test("listCatalog merges builtin + user with user precedence; readCatalogEntry resolves by id", async () => {
    const builtin = await freshRoot();
    const user = await freshRoot();
    await importSkillTree([file("alpha/SKILL.md", manifest("alpha", "built-in alpha"))], builtin);
    await importSkillTree(
      [
        file("alpha/SKILL.md", manifest("alpha", "user shadow of alpha")),
        file("beta/SKILL.md", manifest("beta", "user-only beta")),
      ],
      user,
    );

    const service = new SkillLibraryService(user, builtin);
    const { entries, errors } = await service.listCatalog();
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual(["alpha", "beta"]);

    const alpha = entries.find((e) => e.id === "alpha");
    expect(alpha?.source).toBe("user");
    expect(alpha?.description).toBe("user shadow of alpha");
    expect(alpha?.shadowsBuiltin).toBe(true);
    expect(entries.find((e) => e.id === "beta")?.shadowsBuiltin).toBe(false);

    const read = await service.readCatalogEntry("beta");
    expect(read?.id).toBe("beta");
    expect(await service.readCatalogEntry("nope")).toBeNull();
  });

  test("deleteSkill removes a user shadow of a built-in (built-in root untouched)", async () => {
    const builtin = await freshRoot();
    const user = await freshRoot();
    await importSkillTree([file("profile-overview/SKILL.md", manifest("profile-overview", "built-in"))], builtin);
    await importSkillTree([file("profile-overview/SKILL.md", manifest("profile-overview", "user shadow"))], user);

    const service = new SkillLibraryService(user, builtin);
    const res = await service.deleteSkill("profile-overview");
    expect(res).toEqual({ id: "profile-overview" });
    // User shadow gone; built-in file intact in its own root.
    expect(await Bun.file(join(user, "profile-overview", "SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(builtin, "profile-overview", "SKILL.md")).exists()).toBe(true);

    // After shadow removal, the catalog falls back to the built-in version.
    const after = await service.readCatalogEntry("profile-overview");
    expect(after?.source).toBe("builtin");
    expect(after?.shadowsBuiltin).toBe(false);
  });

  test("deleteSkill rejects a pure built-in (no user dir) as read-only", async () => {
    const builtin = await freshRoot();
    const user = await freshRoot();
    await importSkillTree([file("profile-overview/SKILL.md", manifest("profile-overview", "built-in"))], builtin);

    const service = new SkillLibraryService(user, builtin);
    await expect(service.deleteSkill("profile-overview")).rejects.toThrow(/cannot delete built-in skill/);
    expect(await Bun.file(join(builtin, "profile-overview", "SKILL.md")).exists()).toBe(true);
  });
});

// ─── top-level directory listing + persistence ───────────────────────────────

describe("listTopLevelDirs — filesystem entry characterization", () => {
  test("a missing root lists as empty", async () => {
    expect(await listTopLevelDirs(join(userRoot, "missing-root"))).toEqual([]);
  });

  test("returns only immediate non-symlink directories, excludes staging/trash, and retains ordinary hidden names", async () => {
    const outsideRoot = await freshRoot();
    const outsideDir = join(outsideRoot, "outside-dir");
    const linkedDir = join(userRoot, "linked-dir");
    const danglingDir = join(userRoot, "dangling-dir");
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await Promise.all([
      mkdir(join(userRoot, "zeta", "nested"), { recursive: true }),
      mkdir(join(userRoot, "alpha"), { recursive: true }),
      mkdir(join(userRoot, ".ordinary-hidden"), { recursive: true }),
      mkdir(join(userRoot, ".~vt-skill-staging-interrupted"), { recursive: true }),
      mkdir(join(userRoot, ".~vt-skill-trash-interrupted"), { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
      writeFile(join(userRoot, "regular-file.md"), "not a directory"),
    ]);
    // Deliberately uncaught: a runner without symlink permission fails this gate.
    symlinkSync(outsideDir, linkedDir, directoryLinkType);
    symlinkSync(join(outsideRoot, "missing-dir"), danglingDir, directoryLinkType);

    const entries = await listTopLevelDirs(userRoot);

    expect(entries).toEqual([".ordinary-hidden", "alpha", "zeta"]);
    // OBSERVED PLAN DIVERGENCE: only the dedicated staging/trash prefixes are
    // hidden; ordinary dot directories remain visible to listTopLevelDirs.
    expect(entries).toContain(".ordinary-hidden");
  });
});

describe("SkillLibraryService — durable import reload", () => {
  test("writes through one service instance and a fresh instance rescans the persisted skill", async () => {
    const builtinRoot = await freshRoot();
    const persistentUserRoot = await freshRoot();
    const first = new SkillLibraryService(persistentUserRoot, builtinRoot);

    await first.importSkills([
      file("durable-skill/SKILL.md", manifest("durable-skill", "survives restart")),
      file("durable-skill/references/durable.md", "persisted reference"),
    ]);

    const restarted = new SkillLibraryService(persistentUserRoot, builtinRoot);
    const { entries, errors } = await restarted.listCatalog();

    expect(errors).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({ id: "durable-skill", source: "user", description: "survives restart" }),
    ]);
    expect(await restarted.readCatalogEntry("durable-skill")).toEqual(
      expect.objectContaining({ id: "durable-skill", source: "user" }),
    );
  });
});
