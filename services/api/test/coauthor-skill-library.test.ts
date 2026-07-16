import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

  test("built-in immutability: deleting a built-in id is rejected and touches nothing", async () => {
    // A user skill coincidentally exists, but the requested id is built-in.
    await importSkillTree([file("profile-overview/SKILL.md", manifest("profile-overview", "user copy"))], userRoot);
    expect(await listTopLevelDirs(userRoot)).toEqual(["profile-overview"]);

    await expect(deleteUserSkill("profile-overview", userRoot, ["profile-overview"])).rejects.toThrow(
      /cannot delete built-in skill/,
    );
    // The user's directory is untouched.
    expect(await listTopLevelDirs(userRoot)).toEqual(["profile-overview"]);
    expect(await Bun.file(join(userRoot, "profile-overview", "SKILL.md")).exists()).toBe(true);
  });

  test("unsafe ids and missing dirs are rejected", async () => {
    await expect(deleteUserSkill("..", userRoot)).rejects.toThrow(SkillImportError);
    await expect(deleteUserSkill("a/b", userRoot)).rejects.toThrow(SkillImportError);
    await expect(deleteUserSkill("never-imported", userRoot)).rejects.toThrow(/does not exist/);
  });
});
