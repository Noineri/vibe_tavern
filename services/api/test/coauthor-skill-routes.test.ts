import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoauthorSkillRoutes } from "../src/api/routes/coauthor-skill.js";
import { CoauthorSkillAdapter } from "../src/api/adapters/coauthor-skill-adapter.js";
import { SkillLibraryService } from "../src/domain/coauthor/skills/skill-library.js";
import { listTopLevelDirs } from "../src/domain/coauthor/skills/skill-library.js";

/**
 * CTX-S2 — Co-Author skill library HTTP routes. Verifies the multipart import
 * contract (each file part's FIELD NAME is its relative path) end-to-end, plus
 * delete + built-in-immutability over HTTP. Uses the real SkillLibraryService
 * against temp roots (no mock) so the full parse → validate → atomic-write
 * path is exercised through the adapter.
 */

const tmpRoots: string[] = [];
let userRoot = "";
let builtinRoot = "";

beforeEach(async () => {
  userRoot = await mkdtemp(join(tmpdir(), "coauthor-skill-route-user-"));
  builtinRoot = await mkdtemp(join(tmpdir(), "coauthor-skill-route-builtin-"));
  tmpRoots.push(userRoot, builtinRoot);
});
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeApp() {
  const service = new SkillLibraryService(userRoot, builtinRoot);
  return createCoauthorSkillRoutes(new CoauthorSkillAdapter(service));
}

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (name: string, desc = "A skill.") =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

describe("POST /api/coauthor/skills/import — multipart", () => {
  test("each file part's field name is its relative path → 201 + tree written", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("janitor-card-creator/SKILL.md", new File([enc(manifest("janitor-card-creator", "Creates cards."))], "SKILL.md"));
    form.append("janitor-card-creator/assets/template.md", new File([enc("# Template\n...")], "template.md"));
    form.append("shared-card-references/eval.md", new File([enc("# Eval")], "eval.md"));

    const res = await app.request("/api/coauthor/skills/import", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.importedSkillIds).toEqual(["janitor-card-creator"]);
    expect(body.importedTopLevelDirs).toEqual(["janitor-card-creator", "shared-card-references"]);

    // Written to the real temp user root.
    expect(await Bun.file(join(userRoot, "janitor-card-creator", "SKILL.md")).text()).toContain("Creates cards.");
    expect(await Bun.file(join(userRoot, "shared-card-references", "eval.md")).text()).toBe("# Eval");
  });

  test("unsafe path among parts → 400 and nothing written", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("../escape.md", new File([enc("x")], "escape.md"));
    form.append("a/SKILL.md", new File([enc(manifest("a"))], "SKILL.md"));

    const res = await app.request("/api/coauthor/skills/import", { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/escape the skill root|traversal/i);
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("no File parts → 400", async () => {
    const app = makeApp();
    const res = await app.request("/api/coauthor/skills/import", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No files/i);
  });
});

describe("DELETE /api/coauthor/skills/:id", () => {
  test("deletes an imported user skill → 200", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("gone/SKILL.md", new File([enc(manifest("gone"))], "SKILL.md"));
    expect((await app.request("/api/coauthor/skills/import", { method: "POST", body: form })).status).toBe(201);
    expect(await listTopLevelDirs(userRoot)).toEqual(["gone"]);

    const res = await app.request("/api/coauthor/skills/gone", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "gone" });
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("built-in id → 400 (built-in immutability)", async () => {
    // Seed a built-in skill id by writing into the (temp) builtin root.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await writeFile(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview"), "utf8");

    const app = makeApp();
    const res = await app.request("/api/coauthor/skills/profile-overview", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot delete built-in skill/);
    // The built-in dir is untouched.
    expect(await Bun.file(join(builtinRoot, "profile-overview", "SKILL.md")).exists()).toBe(true);
  });

  test("non-existent id → 400", async () => {
    const app = makeApp();
    const res = await app.request("/api/coauthor/skills/never-imported", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not exist/);
  });
});
