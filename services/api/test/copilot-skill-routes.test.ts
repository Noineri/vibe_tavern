import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotSkillRoutes } from "../src/api/routes/copilot-skill.js";
import { CopilotSkillAdapter } from "../src/api/adapters/copilot-skill-adapter.js";
import { SkillLibraryService } from "../src/domain/coauthor/skills/skill-library.js";
import { listTopLevelDirs } from "../src/domain/coauthor/skills/skill-library.js";

/**
 * CP-5 — Copilot skill library HTTP routes. Mirrors `coauthor-skill-routes`
 * (same wire contract, same atomic import/delete semantics) against the copilot
 * roots. Uses the real SkillLibraryService against temp roots so the full
 * parse → validate → atomic-write path is exercised through the adapter.
 */

const tmpRoots: string[] = [];
let userRoot = "";
let builtinRoot = "";

beforeEach(async () => {
  userRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-user-"));
  builtinRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-builtin-"));
  tmpRoots.push(userRoot, builtinRoot);
});
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeApp() {
  const service = new SkillLibraryService(userRoot, builtinRoot);
  return createCopilotSkillRoutes(new CopilotSkillAdapter(service));
}

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (name: string, desc = "A skill.") =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

describe("POST /api/copilot/skills/import — multipart", () => {
  test("each file part's field name is its relative path → 201 + tree written", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("experience-authoring/SKILL.md", new File([enc(manifest("experience-authoring", "Creates cards."))], "SKILL.md"));
    form.append("experience-authoring/assets/template.md", new File([enc("# Template\n...")], "template.md"));

    const res = await app.request("/api/copilot/skills/import", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.importedSkillIds).toEqual(["experience-authoring"]);

    expect(await Bun.file(join(userRoot, "experience-authoring", "SKILL.md")).text()).toContain("Creates cards.");
  });

  test("unsafe path among parts → 400 and nothing written", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("../escape.md", new File([enc("x")], "escape.md"));
    form.append("a/SKILL.md", new File([enc(manifest("a"))], "SKILL.md"));

    const res = await app.request("/api/copilot/skills/import", { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/escape the skill root|traversal/i);
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });
});

describe("DELETE /api/copilot/skills/:id", () => {
  test("deletes an imported user skill → 200", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("gone/SKILL.md", new File([enc(manifest("gone"))], "SKILL.md"));
    expect((await app.request("/api/copilot/skills/import", { method: "POST", body: form })).status).toBe(201);
    expect(await listTopLevelDirs(userRoot)).toEqual(["gone"]);

    const res = await app.request("/api/copilot/skills/gone", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "gone" });
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("built-in id → 400 (built-in immutability)", async () => {
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview"));

    const app = makeApp();
    const res = await app.request("/api/copilot/skills/profile-overview", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot delete built-in skill/);
    expect(await Bun.file(join(builtinRoot, "profile-overview", "SKILL.md")).exists()).toBe(true);
  });
});

describe("GET /api/copilot/skills — catalog", () => {
  test("list returns the merged metadata-only catalog (built-in + user, user precedence)", async () => {
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "built-in"));
    await mkdir(join(userRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(userRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "user shadow"));
    await mkdir(join(userRoot, "my-skill"), { recursive: true });
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), manifest("my-skill", "mine"));

    const app = makeApp();
    const res = await app.request("/api/copilot/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([]);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["my-skill", "profile-overview"]);

    const overview = body.entries.find((e: { id: string }) => e.id === "profile-overview");
    expect(overview.source).toBe("user");
    expect(overview.shadowsBuiltin).toBe(true);
    expect(overview.description).toBe("user shadow");
    expect(overview.manifestPath).toBe("profile-overview/SKILL.md");
    expect(JSON.stringify(body)).not.toContain(builtinRoot.replace(/\\/g, "/"));
    expect(JSON.stringify(body)).not.toContain(userRoot.replace(/\\/g, "/"));
  });
});
