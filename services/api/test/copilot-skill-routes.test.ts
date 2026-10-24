import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { HTTPException } from "hono/http-exception";
import { join } from "node:path";
import { createCopilotSkillRoutes } from "../src/api/routes/copilot-skill.js";
import { CopilotSkillAdapter, createCopilotSkillKindResolver } from "../src/api/adapters/copilot-skill-adapter.js";
import { SkillLibraryService, listTopLevelDirs } from "../src/domain/coauthor/skills/skill-library.js";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";
// Side-effect imports: register the real experience + script kinds so the
// kind resolver routes ?kind= through the live registry (the AS-2a pattern).
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";

/**
 * CP-5 / AS-8d1 — Copilot skill library HTTP routes. Mirrors
 * `coauthor-skill-routes` (same wire contract, same atomic import/delete
 * semantics) against the per-kind copilot roots. Uses the real
 * SkillLibraryService against temp roots so the full parse → validate →
 * atomic-write path is exercised through the adapter, and the REAL kind
 * resolver so `?kind=` dispatch and the unknown-kind 400 are production paths.
 */

const tmpRoots: string[] = [];
let userRoot = "";
let builtinRoot = "";
let scriptUserRoot = "";
let scriptBuiltinRoot = "";
let sidechatUserRoot = "";
let sidechatBuiltinRoot = "";

beforeEach(async () => {
  userRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-user-"));
  builtinRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-builtin-"));
  scriptUserRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-script-user-"));
  scriptBuiltinRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-script-builtin-"));
  sidechatUserRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-sidechat-user-"));
  sidechatBuiltinRoot = await mkdtemp(join(tmpdir(), "copilot-skill-route-sidechat-builtin-"));
  tmpRoots.push(userRoot, builtinRoot, scriptUserRoot, scriptBuiltinRoot, sidechatUserRoot, sidechatBuiltinRoot);
});
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeApp() {
  const experience = new CopilotSkillAdapter(new SkillLibraryService(userRoot, builtinRoot));
  const script = new CopilotSkillAdapter(new SkillLibraryService(scriptUserRoot, scriptBuiltinRoot));
  const sidechat = new CopilotSkillAdapter(new SkillLibraryService(sidechatUserRoot, sidechatBuiltinRoot));
  const app = createCopilotSkillRoutes(
    createCopilotSkillKindResolver(new Map([ ["experience", experience], ["script", script], ["sidechat-ooc", sidechat] ])),
  );
  // Mount the production DomainError → status mapping (shared helpers, not
  // duplicated logic) so the unknown-kind 400 boundary is observable — the
  // same pattern as copilot-profile-kind.test.ts.
  // Mount the production DomainError → status mapping (shared helpers, not
  // duplicated logic) so the unknown-kind 400 boundary is observable — the
  // same pattern as copilot-profile-kind.test.ts. HTTPException carries its
  // own status (the json validator's malformed-JSON 400), the same branch
  // app-factory's onError has.
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

describe("GET /api/copilot/skills/:id/content — skill content (AP-21)", () => {
  test("built-in skill → 200: raw manifest, frontmatter-stripped body, folder files without the manifest", async () => {
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "built-in"));
    await mkdir(join(builtinRoot, "profile-overview", "references"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "references", "rules.md"), "# Rules\n");
    await Bun.write(join(builtinRoot, "profile-overview", "assets", "template.md"), "# Template\n");

    const app = makeApp();
    const res = await app.request("/api/copilot/skills/profile-overview/content");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("profile-overview");
    expect(body.path).toBe("profile-overview/SKILL.md");
    // content = the RAW manifest (frontmatter included).
    expect(body.content).toBe(manifest("profile-overview", "built-in"));
    // body = content WITHOUT the frontmatter block — the editor's skill text.
    expect(body.body).toBe("# profile-overview\n");
    expect(body.body).not.toContain("---");
    expect(body.body).not.toContain("name: profile-overview");
    // files = relative POSIX paths inside the skill folder, manifest excluded, sorted.
    expect(body.files).toEqual(["assets/template.md", "references/rules.md"]);
    // No absolute filesystem path crosses the wire.
    expect(JSON.stringify(body)).not.toContain(builtinRoot.replace(/\\/g, "/"));
  });

  test("user skill → 200 from the user root", async () => {
    await mkdir(join(userRoot, "my-skill"), { recursive: true });
    await Bun.write(join(userRoot, "my-skill", "SKILL.md"), manifest("my-skill", "mine"));
    await Bun.write(join(userRoot, "my-skill", "notes.md"), "notes\n");

    const app = makeApp();
    const res = await app.request("/api/copilot/skills/my-skill/content");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("description: mine");
    expect(body.files).toEqual(["notes.md"]);
  });

  test("shadowed skill → the USER copy wins for content AND files (readSkillFile precedence)", async () => {
    await mkdir(join(builtinRoot, "shared"), { recursive: true });
    await Bun.write(join(builtinRoot, "shared", "SKILL.md"), manifest("shared", "built-in version"));
    await Bun.write(join(builtinRoot, "shared", "builtin-only.md"), "builtin only\n");
    await mkdir(join(userRoot, "shared"), { recursive: true });
    await Bun.write(join(userRoot, "shared", "SKILL.md"), manifest("shared", "user-customized version"));
    await Bun.write(join(userRoot, "shared", "user-only.md"), "user only\n");

    const app = makeApp();
    const res = await app.request("/api/copilot/skills/shared/content");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("user-customized version");
    expect(body.content).not.toContain("built-in version");
    // The file list mirrors the WINNING folder — the user's — not a merge.
    expect(body.files).toEqual(["user-only.md"]);
  });

  test("missing skill → 404", async () => {
    const app = makeApp();
    const res = await app.request("/api/copilot/skills/no-such-skill/content");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/does not exist/);
  });

  test("?kind=script reads the script roots — no cross-kind content leak", async () => {
    await mkdir(join(scriptBuiltinRoot, "dice-helper"), { recursive: true });
    await Bun.write(join(scriptBuiltinRoot, "dice-helper", "SKILL.md"), manifest("dice-helper", "Notation recipes."));
    await mkdir(join(userRoot, "dice-helper"), { recursive: true });
    await Bun.write(join(userRoot, "dice-helper", "SKILL.md"), manifest("dice-helper", "Experience side."));

    const app = makeApp();
    const scriptRes = await app.request("/api/copilot/skills/dice-helper/content?kind=script");
    expect(scriptRes.status).toBe(200);
    expect((await scriptRes.json()).content).toContain("Notation recipes.");

    // The default kind (experience) sees its OWN user copy instead.
    const defRes = await app.request("/api/copilot/skills/dice-helper/content");
    expect((await defRes.json()).content).toContain("Experience side.");

    const missing = await app.request("/api/copilot/skills/dice-helper/content?kind=sidechat-ooc");
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/copilot/skills + PUT /api/copilot/skills/:id — save (AP-23a)", () => {
  test("create → 201 with the fresh entry DTO written under the kind's user root", async () => {
    const app = makeApp();
    const res = await app.request("/api/copilot/skills", {
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

  test("create with ?kind=script lands in the SCRIPT user root — not the experience one", async () => {
    const app = makeApp();
    const res = await app.request("/api/copilot/skills?kind=script", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Dice Notation", description: "d.", body: "b" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe("dice-notation");
    expect(await Bun.file(join(scriptUserRoot, "dice-notation", "SKILL.md")).text()).toContain("description: d");
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("update → 200 with the fresh DTO; other files of the skill folder kept", async () => {
    await mkdir(join(userRoot, "my-skill", "references"), { recursive: true });
    await Bun.write(
      join(userRoot, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: old\nlicense: MIT\n---\n\n# old\n",
    );
    await Bun.write(join(userRoot, "my-skill", "references", "rules.md"), "# Rules\n");

    const app = makeApp();
    const res = await app.request("/api/copilot/skills/my-skill", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", description: "new", body: "# New\n" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Renamed");
    expect(body.description).toBe("new");

    const onDisk = await Bun.file(join(userRoot, "my-skill", "SKILL.md")).text();
    expect(onDisk).toContain("license: MIT");
    expect(await Bun.file(join(userRoot, "my-skill", "references", "rules.md")).text()).toBe("# Rules\n");
  });

  test("built-in id → 409 Conflict; malformed JSON → 400; missing id → 404", async () => {
    await mkdir(join(builtinRoot, "profile-overview"), { recursive: true });
    await Bun.write(join(builtinRoot, "profile-overview", "SKILL.md"), manifest("profile-overview", "built-in"));

    const app = makeApp();
    const conflict = await app.request("/api/copilot/skills/profile-overview", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", description: "d", body: "b" }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.kind).toBe("Conflict");
    expect(await Bun.file(join(builtinRoot, "profile-overview", "SKILL.md")).text()).toContain("built-in");

    const malformed = await app.request("/api/copilot/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);

    const missing = await app.request("/api/copilot/skills/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", description: "d", body: "b" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("?kind= per-kind dispatch (AS-8d1)", () => {
  test("?kind=script lists the script roots only; the default stays experience", async () => {
    await mkdir(join(scriptUserRoot, "dice-helper"), { recursive: true });
    await Bun.write(join(scriptUserRoot, "dice-helper", "SKILL.md"), manifest("dice-helper", "Notation recipes."));
    await mkdir(join(userRoot, "exp-only"), { recursive: true });
    await Bun.write(join(userRoot, "exp-only", "SKILL.md"), manifest("exp-only", "Experience side."));

    const app = makeApp();
    const scriptRes = await app.request("/api/copilot/skills?kind=script");
    expect(scriptRes.status).toBe(200);
    const scriptBody = await scriptRes.json();
    expect(scriptBody.errors).toEqual([]);
    expect(scriptBody.entries.map((e: { id: string }) => e.id)).toEqual(["dice-helper"]);

    // No kind (default) and explicit ?kind=experience are the SAME list —
    // the script skill must not leak into the experience catalog.
    const defRes = await app.request("/api/copilot/skills");
    const expRes = await app.request("/api/copilot/skills?kind=experience");
    const defBody = await defRes.json();
    const expBody = await expRes.json();
    expect(defBody.entries.map((e: { id: string }) => e.id)).toEqual(["exp-only"]);
    expect(expBody.entries.map((e: { id: string }) => e.id)).toEqual(["exp-only"]);
  });

  test("an import with ?kind=script lands in the script user root — not the experience one", async () => {
    const app = makeApp();
    const form = new FormData();
    form.append("dice-helper/SKILL.md", new File([enc(manifest("dice-helper", "Notation recipes."))], "SKILL.md"));

    const res = await app.request("/api/copilot/skills/import?kind=script", { method: "POST", body: form });
    expect(res.status).toBe(201);
    expect((await res.json()).importedSkillIds).toEqual(["dice-helper"]);

    expect(await Bun.file(join(scriptUserRoot, "dice-helper", "SKILL.md")).text()).toContain("Notation recipes.");
    expect(await listTopLevelDirs(userRoot)).toEqual([]);
  });

  test("?kind=sidechat-ooc lists the sidechat roots only; experience and script lists stay unchanged (SC-5)", async () => {
    // The same id exists in EVERY kind's user root with a distinct body: each
    // kind's list must show only its own root's copy (no cross-kind leak).
    for (const [root, desc] of [
      [sidechatUserRoot, "Sidechat side."],
      [userRoot, "Experience side."],
      [scriptUserRoot, "Script side."],
    ] as const) {
      await mkdir(join(root, "plot-talk"), { recursive: true });
      await Bun.write(join(root, "plot-talk", "SKILL.md"), manifest("plot-talk", desc));
    }

    const app = makeApp();
    const scRes = await app.request("/api/copilot/skills?kind=sidechat-ooc");
    expect(scRes.status).toBe(200);
    const scBody = await scRes.json();
    expect(scBody.errors).toEqual([]);
    expect(scBody.entries.map((e: { id: string }) => e.id)).toEqual(["plot-talk"]);
    expect(scBody.entries[0].description).toBe("Sidechat side.");

    // The other kinds' lists are unchanged by the third library: experience
    // (default and explicit) and script each see only their own copy.
    const defBody = await (await app.request("/api/copilot/skills")).json();
    expect(defBody.entries.map((e: { id: string }) => e.id)).toEqual(["plot-talk"]);
    expect(defBody.entries[0].description).toBe("Experience side.");
    const expBody = await (await app.request("/api/copilot/skills?kind=experience")).json();
    expect(expBody.entries.map((e: { id: string }) => e.id)).toEqual(["plot-talk"]);
    expect(expBody.entries[0].description).toBe("Experience side.");
    const scriptBody = await (await app.request("/api/copilot/skills?kind=script")).json();
    expect(scriptBody.entries.map((e: { id: string }) => e.id)).toEqual(["plot-talk"]);
    expect(scriptBody.entries[0].description).toBe("Script side.");
  });

  test("unknown kind → 400 carrying UNKNOWN_AGENT_KIND (no silent fallback)", async () => {
    const app = makeApp();
    const res = await app.request("/api/copilot/skills?kind=no-such-kind");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details?.code).toBe("UNKNOWN_AGENT_KIND");
  });
});
