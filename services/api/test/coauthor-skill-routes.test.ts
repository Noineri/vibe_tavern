import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, SkillOrderStore } from "@vibe-tavern/db";
import { createCoauthorSkillRoutes } from "../src/api/routes/coauthor-skill.js";
import { CoauthorSkillAdapter } from "../src/api/adapters/coauthor-skill-adapter.js";
import { COAUTHOR_SKILL_LIBRARY } from "../src/api/contract/skill-contracts.js";
import { SkillLibraryService } from "../src/domain/coauthor/skills/skill-library.js";
import { listTopLevelDirs } from "../src/domain/coauthor/skills/skill-library.js";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";

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

async function makeApp() {
  const service = new SkillLibraryService(userRoot, builtinRoot);
  // ML-7: a real order store over an in-memory db (template-backed) — the
  // stored order is exercised end-to-end, same library key as production.
  const orderStore = new SkillOrderStore(await createDb(":memory:"));
  const app = createCoauthorSkillRoutes(new CoauthorSkillAdapter(service, orderStore, COAUTHOR_SKILL_LIBRARY));
  // Mount the production DomainError → status mapping (shared helpers, not
  // duplicated logic) so the save-path statuses (409 conflict / 404 notFound /
  // 400 validation) are observable — the same pattern as copilot-skill-routes.
  // HTTPException carries its own status (the json validator's malformed-JSON
  // 400), the same branch app-factory's onError has.
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  return app;
}

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (name: string, desc = "A skill.") =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

describe("POST /api/coauthor/skills/import — multipart", () => {
  test("each file part's field name is its relative path → 201 + tree written", async () => {
    const app = await makeApp();
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
    const app = await makeApp();
    const form = new FormData();
    form.append("../escape.md", new File([enc("x")], "escape.md"));
    form.append("a/SKILL.md", new File([enc(manifest("a"))], "SKILL.md"));

    const res = await app.request("/api/coauthor/skills/import", { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/escape the skill root|traversal/i);
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("no File parts → 400", async () => {
    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/import", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No files/i);
  });
});

describe("DELETE /api/coauthor/skills/:id", () => {
  test("deletes an imported user skill → 200", async () => {
    const app = await makeApp();
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
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview"));

    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/profile-overview", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot delete built-in skill/);
    // The built-in dir is untouched.
    expect(await Bun.file(join(builtinRoot, "profile-overview", "SKILL.md")).exists()).toBe(true);
  });

  test("non-existent id → 400", async () => {
    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/never-imported", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not exist/);
  });
});

describe("GET /api/coauthor/skills/:id/content — skill content (AP-21)", () => {
  test("built-in skill → 200: raw manifest, frontmatter-stripped body, folder files without the manifest", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "built-in"));
    await mkdir(join(builtinRoot, "profile-overview", "references"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "references", "rules.md"), "# Rules\n");
    await Bun.write(join(builtinRoot, "profile-overview", "assets", "template.md"), "# Template\n");

    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/profile-overview/content");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("profile-overview");
    expect(body.path).toBe("profile-overview/SKILL.md");
    // content = the RAW manifest (frontmatter included).
    expect(body.content).toBe(manifest("profile-overview", "built-in"));
    // body = content WITHOUT the frontmatter block — the editor's skill text.
    expect(body.body).toBe("# profile-overview\n");
    expect(body.body).not.toContain("---");
    // files = relative POSIX paths inside the skill folder, manifest excluded, sorted.
    expect(body.files).toEqual(["assets/template.md", "references/rules.md"]);
    // No absolute filesystem path crosses the wire.
    expect(JSON.stringify(body)).not.toContain(builtinRoot.replace(/\\/g, "/"));
  });

  test("user skill → 200 from the user root", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(userRoot, "my-skill"), { recursive: true });
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), manifest("my-skill", "mine"));
    await Bun.write(join(userRoot, "my-skill", "notes.md"), "notes\n");

    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/my-skill/content");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("description: mine");
    expect(body.files).toEqual(["notes.md"]);
  });

  test("shadowed skill → the USER copy wins for content AND files (readSkillFile precedence)", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(builtinRoot, "shared"), { recursive: true });
    await Bun.write(join(builtinRoot, "shared", "SKILL.md"), manifest("shared", "built-in version"));
    await Bun.write(join(builtinRoot, "shared", "builtin-only.md"), "builtin only\n");
    await mkdir(join(userRoot, "shared"), { recursive: true });
    await Bun.write(join(userRoot, "shared", "SKILL.md"), manifest("shared", "user-customized version"));
    await Bun.write(join(userRoot, "shared", "user-only.md"), "user only\n");

    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/shared/content");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("user-customized version");
    expect(body.content).not.toContain("built-in version");
    // The file list mirrors the WINNING folder — the user's — not a merge.
    expect(body.files).toEqual(["user-only.md"]);
  });

  test("missing skill → 404", async () => {
    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/no-such-skill/content");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/does not exist/);
  });
});

describe("POST /api/coauthor/skills — save (create, AP-23a)", () => {
  test("create → 201 with the fresh entry DTO; <id>/SKILL.md written under the user root", async () => {
    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Plot Talk", description: "Talk plots.", body: "# Body\n" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: "plot-talk",
      source: "user",
      name: "Plot Talk",
      description: "Talk plots.",
      manifestPath: "plot-talk/SKILL.md",
      shadowsBuiltin: false,
    });
    expect(await Bun.file(join(userRoot, "plot-talk", "SKILL.md")).text()).toContain("Talk plots.");
  });

  test("create from a Russian name → transliterated id over HTTP", async () => {
    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Психолог Речей", description: "d", body: "b" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe("psikholog-rechey");
    expect(await listTopLevelDirs(userRoot)).toEqual(["psikholog-rechey"]);
  });

  test("missing name → zod 400; malformed JSON → 400; nothing written", async () => {
    const app = await makeApp();
    const bad = await app.request("/api/coauthor/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "d", body: "b" }),
    });
    expect(bad.status).toBe(400);

    const malformed = await app.request("/api/coauthor/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);

    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });
});

describe("PUT /api/coauthor/skills/:id — save (update, AP-23a)", () => {
  test("update → 200 with the fresh DTO; references/ kept, frontmatter rebuilt with extra keys kept", async () => {
    await mkdir(join(userRoot, "my-skill", "references"), { recursive: true });
    await Bun.write(
      join(userRoot, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: old\nlicense: MIT\n---\n\n# old\n",
    );
    await Bun.write(join(userRoot, "my-skill", "references", "rules.md"), "# Rules\n");

    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/my-skill", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", description: "new", body: "# New\n" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: "my-skill",
      source: "user",
      name: "Renamed",
      description: "new",
      manifestPath: "my-skill/SKILL.md",
      shadowsBuiltin: false,
    });

    const onDisk = await Bun.file(join(userRoot, "my-skill", "SKILL.md")).text();
    expect(onDisk).toContain("description: new");
    // The extra frontmatter key survives the rebuild.
    expect(onDisk).toContain("license: MIT");
    expect(await Bun.file(join(userRoot, "my-skill", "references", "rules.md")).text()).toBe("# Rules\n");
  });

  test("built-in id → 409 Conflict (built-ins are read-only); the builtin file is untouched", async () => {
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "built-in"));

    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills/profile-overview", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", description: "d", body: "b" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.kind).toBe("Conflict");
    expect(body.error.message).toMatch(/built-in skills are read-only/);
    expect(await Bun.file(join(builtinRoot, "profile-overview", "SKILL.md")).text()).toContain("built-in");
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("missing id → 404; invalid body → zod 400", async () => {
    const app = await makeApp();
    const missing = await app.request("/api/coauthor/skills/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", description: "d", body: "b" }),
    });
    expect(missing.status).toBe(404);

    const invalid = await app.request("/api/coauthor/skills/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "d", body: "b" }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe("GET /api/coauthor/skills — catalog", () => {
  test("list returns the merged metadata-only catalog (built-in + user, user precedence)", async () => {
    // Seed a built-in and a user skill that shadows it, plus a user-only skill.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "built-in"));
    await mkdir(join(userRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(userRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "user shadow"));
    await mkdir(join(userRoot, "my-skill"), { recursive: true });
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), manifest("my-skill", "mine"));

    const app = await makeApp();
    const res = await app.request("/api/coauthor/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([]);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["my-skill", "profile-overview"]);

    const overview = body.entries.find((e: { id: string }) => e.id === "profile-overview");
    expect(overview.source).toBe("user");
    expect(overview.shadowsBuiltin).toBe(true);
    expect(overview.description).toBe("user shadow");
    // Metadata-only DTO: portable manifest path, NO absolute filesystem path.
    expect(overview.manifestPath).toBe("profile-overview/SKILL.md");
    expect(JSON.stringify(body)).not.toContain(builtinRoot.replace(/\\/g, "/"));
    expect(JSON.stringify(body)).not.toContain(userRoot.replace(/\\/g, "/"));
  });

  test("read by id → 200 with the entry; missing id → 404", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(userRoot, "my-skill"), { recursive: true });
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), manifest("my-skill", "hello"));

    const app = await makeApp();
    const ok = await app.request("/api/coauthor/skills/my-skill");
    expect(ok.status).toBe(200);
    expect((await ok.json()).description).toBe("hello");

    const missing = await app.request("/api/coauthor/skills/nope");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/does not exist/);
  });
});

describe("PATCH /api/coauthor/skills/reorder — stored catalog order (ML-7)", () => {
  /** Seed one skill directory with a parseable manifest under a root. */
  async function seedSkill(root: string, id: string, description = "A skill.") {
    await mkdir(join(root, id), { recursive: true });
    await Bun.write(join(root, id, "SKILL.md"), manifest(id, description));
  }

  /** PATCH the reorder route with the given updates. */
  async function reorder(app: ReturnType<typeof createCoauthorSkillRoutes>, updates: Array<{ id: string; sortOrder: number }>) {
    return app.request("/api/coauthor/skills/reorder", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates }),
    });
  }

  test("GET returns the stored order: known ids in stored positions, a SHADOWED id at ONE deterministic position, unknown ids last alphabetical", async () => {
    // The shadow case the plan calls out: builtin `shared` shadowed by a user
    // copy. The catalog collapses them to ONE user-won entry, and the order
    // table keys rows by id alone — so the shadowed id has exactly one
    // position (source/shadowsBuiltin still cross the wire untouched).
    await seedSkill(builtinRoot, "shared", "built-in");
    await seedSkill(builtinRoot, "beta");
    await seedSkill(userRoot, "shared", "user shadow");
    await seedSkill(userRoot, "alpha");
    await seedSkill(userRoot, "gamma");

    const app = await makeApp();
    const res = await reorder(app, [
      { id: "shared", sortOrder: 0 },
      { id: "gamma", sortOrder: 1 },
    ]);
    expect(res.status).toBe(200);

    const list = await app.request("/api/coauthor/skills");
    const body = await list.json();
    // Known: shared (0), gamma (1). Unknown alphabetical: alpha, beta.
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["shared", "gamma", "alpha", "beta"]);
    const shared = body.entries.find((e: { id: string }) => e.id === "shared");
    expect(shared.source).toBe("user");
    expect(shared.shadowsBuiltin).toBe(true);
    expect(shared.description).toBe("user shadow");
  });

  test("the reorder response IS the refreshed catalog envelope — the same shape the GET serves", async () => {
    await seedSkill(userRoot, "alpha");
    await seedSkill(userRoot, "beta");
    const app = await makeApp();
    const res = await reorder(app, [{ id: "beta", sortOrder: 0 }, { id: "alpha", sortOrder: 1 }]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["entries", "errors"]);
    expect(body.errors).toEqual([]);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["beta", "alpha"]);
  });

  test("a skill that appears AFTER the reorder (fresh import / new built-in) sorts with the unknowns — last, alphabetical", async () => {
    await seedSkill(userRoot, "alpha");
    const app = await makeApp();
    await reorder(app, [{ id: "alpha", sortOrder: 0 }]);
    // Two new skills appear after the stored order was written.
    await seedSkill(userRoot, "zeta");
    await seedSkill(userRoot, "beta");
    const list = await app.request("/api/coauthor/skills");
    expect((await list.json()).entries.map((e: { id: string }) => e.id)).toEqual(["alpha", "beta", "zeta"]);
  });

  test("an UNKNOWN id in the reorder payload gets a slot: importing that id later surfaces it at its stored position", async () => {
    await seedSkill(userRoot, "alpha");
    const app = await makeApp();
    // ghost is not in the catalog — the row is written anyway (inert until the id exists).
    const res = await reorder(app, [{ id: "ghost", sortOrder: 0 }, { id: "alpha", sortOrder: 1 }]);
    expect(res.status).toBe(200);
    expect((await res.json()).entries.map((e: { id: string }) => e.id)).toEqual(["alpha"]);
    // ghost appears (user import) → takes its stored slot, ahead of alpha.
    await seedSkill(userRoot, "ghost");
    const list = await app.request("/api/coauthor/skills");
    expect((await list.json()).entries.map((e: { id: string }) => e.id)).toEqual(["ghost", "alpha"]);
  });

  test("a body without the updates array → zod 400; nothing stored", async () => {
    await seedSkill(userRoot, "alpha");
    const app = await makeApp();
    const bad = await app.request("/api/coauthor/skills/reorder", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(bad.status).toBe(400);
    // The catalog still serves the scanner's alphabetical order.
    const list = await app.request("/api/coauthor/skills");
    expect((await list.json()).entries.map((e: { id: string }) => e.id)).toEqual(["alpha"]);
  });
});
