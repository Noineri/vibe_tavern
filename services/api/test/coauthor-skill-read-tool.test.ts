import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSkillFile,
  SkillReadError,
  buildReadSkillFileTool,
} from "../src/domain/coauthor/skills/skill-read-tool.js";

/**
 * CTX-S4 — the read_skill_file sandbox. The model reads skill files on demand,
 * so the read must be tightly scoped: only regular UTF-8 text files INSIDE a
 * skill root are readable; everything else rejects. Pins every self-check
 * category: valid SKILL/template/reference/shared/cross-skill/internal-`..`
 * reads resolve; escape, absolute, symlink, directory, binary, missing, and
 * empty/NUL paths reject. Drives {@link readSkillFile} directly (input-agnostic)
 * and also exercises the AI-SDK tool wrapper end-to-end.
 */

const tmpRoots: string[] = [];
let builtinRoot = "";
let userRoot = "";

async function freshRoot(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `coauthor-skill-read-${prefix}-`));
  tmpRoots.push(d);
  return d;
}

beforeEach(async () => {
  builtinRoot = await freshRoot("builtin");
  userRoot = await freshRoot("user");
});
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seedSkill(root: string, id: string, description: string): Promise<void> {
  await mkdir(join(root, id, "assets"), { recursive: true });
  await mkdir(join(root, id, "references"), { recursive: true });
  await writeFile(
    join(root, id, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\nRead [template](assets/template.md) or [shared](../../shared-references/rules.md).\n`,
    "utf8",
  );
  await writeFile(join(root, id, "assets", "template.md"), "# Template\n...", "utf8");
  await writeFile(join(root, id, "references", "rules.md"), "# Rules\n...", "utf8");
}

describe("readSkillFile — valid reads", () => {
  test("reads a SKILL.md manifest by root-relative path", async () => {
    await seedSkill(builtinRoot, "janitor-card-creator", "Creates cards.");
    const res = await readSkillFile("janitor-card-creator/SKILL.md", [builtinRoot]);
    expect(res.path).toBe("janitor-card-creator/SKILL.md");
    expect(res.content).toContain("Creates cards.");
  });

  test("reads a local asset and a local reference inside a skill dir", async () => {
    await seedSkill(builtinRoot, "janitor-card-creator", "Creates cards.");
    expect((await readSkillFile("janitor-card-creator/assets/template.md", [builtinRoot])).content).toContain("Template");
    expect((await readSkillFile("janitor-card-creator/references/rules.md", [builtinRoot])).content).toContain("Rules");
  });

  test("reads a shared sibling references directory at the root", async () => {
    await seedSkill(builtinRoot, "janitor-card-creator", "Creates cards.");
    await mkdir(join(builtinRoot, "shared-references"), { recursive: true });
    await writeFile(join(builtinRoot, "shared-references", "rules.md"), "# Shared rules\n", "utf8");
    expect((await readSkillFile("shared-references/rules.md", [builtinRoot])).content).toContain("Shared rules");
  });

  test("internal '..' that stays inside the root resolves (root-relative link form)", async () => {
    await seedSkill(builtinRoot, "janitor-card-creator", "Creates cards.");
    await mkdir(join(builtinRoot, "shared-references"), { recursive: true });
    await writeFile(join(builtinRoot, "shared-references", "rules.md"), "# Shared rules\n", "utf8");
    // A path written relative to the skill dir, re-rooted by the model with a
    // leading skill dir + '..' — must resolve to the shared dir, not be rejected.
    const res = await readSkillFile("janitor-card-creator/../shared-references/rules.md", [builtinRoot]);
    expect(res.content).toContain("Shared rules");
  });

  test("user precedence: a path in both roots reads the USER copy", async () => {
    await seedSkill(builtinRoot, "shared", "built-in version");
    await seedSkill(userRoot, "shared", "user-customized version");
    const res = await readSkillFile("shared/SKILL.md", [userRoot, builtinRoot]);
    expect(res.content).toContain("user-customized version");
  });

  test("falls back to the built-in root when the path is absent from the user root", async () => {
    await seedSkill(builtinRoot, "only-builtin", "built-in only");
    const res = await readSkillFile("only-builtin/SKILL.md", [userRoot, builtinRoot]);
    expect(res.content).toContain("built-in only");
  });
});

describe("readSkillFile — rejections", () => {
  test("escape via traversal resolves outside every root → reject (nothing read)", async () => {
    await seedSkill(builtinRoot, "x", "x");
    // Place a sensitive file outside the root to PROVE it is never read.
    const outside = join(builtinRoot, "..", "vt-skill-read-escape-target.txt");
    await writeFile(outside, "SECRET", "utf8");
    await expect(readSkillFile("../vt-skill-read-escape-target.txt", [builtinRoot])).rejects.toThrow(SkillReadError);
    await expect(readSkillFile("../../etc/passwd", [builtinRoot, userRoot])).rejects.toThrow(SkillReadError);
    await rm(outside, { force: true });
  });

  test("absolute paths (POSIX + Windows drive) → reject", async () => {
    await seedSkill(builtinRoot, "x", "x");
    await expect(readSkillFile("/etc/passwd", [builtinRoot])).rejects.toThrow(SkillReadError);
    await expect(readSkillFile("C:\\Windows\\system32\\drivers\\etc\\hosts", [builtinRoot])).rejects.toThrow(SkillReadError);
  });

  test("symlink → reject (never followed)", async () => {
    await seedSkill(builtinRoot, "x", "x");
    const target = join(builtinRoot, "x", "assets", "template.md");
    const link = join(builtinRoot, "x", "link.md");
    await symlink(target, link);
    await expect(readSkillFile("x/link.md", [builtinRoot])).rejects.toThrow(/symlink/i);
  });

  test("directory → reject", async () => {
    await seedSkill(builtinRoot, "x", "x");
    await expect(readSkillFile("x/assets", [builtinRoot])).rejects.toThrow(/not a regular file/i);
    await expect(readSkillFile("x", [builtinRoot])).rejects.toThrow(/not a regular file/i);
  });

  test("binary file (NUL byte) → reject", async () => {
    await mkdir(join(builtinRoot, "bin"), { recursive: true });
    await writeFile(join(builtinRoot, "bin", "image.bin"), Uint8Array.from([1, 2, 3, 0, 4, 5]), "utf8");
    await expect(readSkillFile("bin/image.bin", [builtinRoot])).rejects.toThrow(/binary/i);
  });

  test("missing file → reject", async () => {
    await seedSkill(builtinRoot, "x", "x");
    await expect(readSkillFile("x/assets/nope.md", [builtinRoot])).rejects.toThrow(/not found/i);
    await expect(readSkillFile("does-not-exist/SKILL.md", [builtinRoot, userRoot])).rejects.toThrow(/not found/i);
  });

  test("empty path and NUL in path → reject", async () => {
    await expect(readSkillFile("", [builtinRoot])).rejects.toThrow(SkillReadError);
    await expect(readSkillFile("x\0.md", [builtinRoot])).rejects.toThrow(SkillReadError);
  });

  test("no roots provided → every read rejects", async () => {
    await expect(readSkillFile("any/SKILL.md", [])).rejects.toThrow(/not found/i);
  });
});

describe("buildReadSkillFileTool — AI-SDK wrapper", () => {
  test("execute reads via the sandbox and returns {path, content}; rejects propagate as thrown errors", async () => {
    await seedSkill(builtinRoot, "janitor-card-creator", "Creates cards.");
    const t = buildReadSkillFileTool([builtinRoot]);
    const out = await t.execute({ path: "janitor-card-creator/SKILL.md" }, {
      messages: [], toolCallId: "tc_1", abortSignal: undefined as never,
    } as never);
    expect(out.path).toBe("janitor-card-creator/SKILL.md");
    expect(out.content).toContain("Creates cards.");
    await expect(
      (t.execute as (a: { path: string }) => Promise<unknown>)({ path: "../escape.md" }),
    ).rejects.toThrow(SkillReadError);
  });
});
