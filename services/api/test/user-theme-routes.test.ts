import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createFileStore } from "@vibe-tavern/db";
import { UserThemeLibrary } from "../src/domain/themes/user-theme-library.js";
import { UserThemeAdapter } from "../src/api/adapters/user-theme-adapter.js";
import { createUserThemeRoutes } from "../src/api/routes/user-theme.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";

// L1: real Hono/adapter/library/FileStore boundary; no mocks, DBs or waits.
// Scratch is tmpdir-derived, per test and swept; no process-global mutations.
let root: string;
let app: Hono;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vt-user-theme-routes-"));
  app = new Hono().route("/", createUserThemeRoutes(new UserThemeAdapter(new UserThemeLibrary(createFileStore(root)))));
  app.onError((error, c) => {
    if (!isDomainError(error)) throw error;
    return c.json(domainErrorToJson(error), httpStatusForDomainError(error) as 400 | 404);
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function upload(name: string, css: string) {
  return app.request("/api/user-themes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, css }) });
}

describe("user-theme HTTP boundary", () => {
  test("uploads, lists metadata without CSS, reads normalized CSS and deletes through real adapter/files", async () => {
    const response = await upload("warm.css", ":root.coffee { --bg: #123; }");
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved.name).toBe("warm.css");
    expect(saved.css).toContain(`:root.user-${saved.id}`);
    const list = await app.request("/api/user-themes");
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(await list.json()).toEqual([{ id: saved.id, name: "warm.css" }]);
    const read = await app.request(`/api/user-themes/${saved.id}`);
    expect(read.headers.get("Content-Type")).toContain("application/json");
    expect(read.headers.get("Cache-Control")).toBe("no-store");
    expect(await read.json()).toEqual(saved);
    expect(await (await app.request(`/api/user-themes/${saved.id}`, { method: "DELETE" })).json()).toEqual({ ok: true });
    expect((await app.request(`/api/user-themes/${saved.id}`)).status).toBe(404);
    expect(await (await app.request("/api/user-themes")).json()).toEqual([]);
  });

  test("missing root is an actionable 400 with expected format, not a successful empty upload", async () => {
    const response = await upload("theme.css", "body { color: red; }");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toContain(":root");
    expect(body.error.details.code).toBe("missing-root");
    expect(await (await app.request("/api/user-themes")).json()).toEqual([]);
  });

  test("validates request bodies and encoded traversal at the HTTP boundary", async () => {
    expect((await upload("theme.txt", ":root { --bg: red; }")).status).toBe(400);
    expect((await upload("../theme.css", ":root { --bg: red; }")).status).toBe(400);
    for (const method of ["GET", "DELETE"]) expect((await app.request("/api/user-themes/..%2Foutside", { method })).status).toBe(400);
    expect((await app.request("/api/user-themes/absent")).status).toBe(404);
  });
});
