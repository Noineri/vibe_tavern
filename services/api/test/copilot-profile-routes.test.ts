import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { createCopilotProfileRoutes } from "../src/api/routes/copilot-profile.js";
import { CopilotProfileAdapter } from "../src/api/adapters/copilot-profile-adapter.js";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * Wave 3 — copilot profile CRUD HTTP routes. Pins: GET returns the built-in
 * seed FIRST then user rows; POST creates a user profile; PATCH/DELETE reject
 * the read-only built-in id ("builtin") with a 400 and mutate user profiles
 * otherwise. Uses the real store container + adapter so the DB round-trip is
 * exercised end-to-end (no mocked store). A single shared container is used
 * (the SQLite handle is released only at process end via `closeAllDbs`), so
 * assertions are written to be robust against accumulated user profiles.
 */

let stores: StoreContainer;
let app: ReturnType<typeof createCopilotProfileRoutes>;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-copilot-profile-routes-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  app = createCopilotProfileRoutes(new CopilotProfileAdapter(stores));
  // Mount the production DomainError → status mapping (shared helpers, not
  // duplicated logic) so the read-only-builtin 400s are observable.
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
});

const createInput = (over: Record<string, unknown> = {}) => ({
  name: "Card games",
  basePrompt: "You help author card-game experiences.",
  skillIds: ["experience-authoring"],
  toolSet: { write_buffer: true, run_test: true },
  maxSteps: 20,
  ...over,
});

async function createProfile(over: Record<string, unknown> = {}) {
  const res = await app.request("/api/copilot/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createInput(over)),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; name: string; isBuiltIn: boolean };
}

describe("GET /api/copilot/profiles", () => {
  test("returns the built-in seed first", async () => {
    const res = await app.request("/api/copilot/profiles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: Array<{ id: string; isBuiltIn: boolean }> };
    expect(body.profiles[0]?.id).toBe("builtin");
    expect(body.profiles[0]?.isBuiltIn).toBe(true);
  });
});

describe("POST /api/copilot/profiles", () => {
  test("creates a user profile and lists it after the seed", async () => {
    const created = await createProfile();
    expect(created.name).toBe("Card games");
    expect(created.isBuiltIn).toBe(false);
    expect(created.id).toMatch(/^cprof/);

    const list = await app.request("/api/copilot/profiles");
    const body = (await list.json()) as { profiles: Array<{ id: string; isBuiltIn: boolean }> };
    expect(body.profiles[0]?.id).toBe("builtin");
    // The created profile appears after the seed, non-builtin.
    const createdEntry = body.profiles.find((p) => p.id === created.id);
    expect(createdEntry?.isBuiltIn).toBe(false);
  });

  test("rejects a malformed body (empty basePrompt) → 400", async () => {
    const res = await app.request("/api/copilot/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createInput({ basePrompt: "" })),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/copilot/profiles/:id", () => {
  test("rejects the read-only built-in seed → 400", async () => {
    const res = await app.request("/api/copilot/profiles/builtin", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/read-only/i);
  });

  test("updates a user profile (partial update preserves untouched fields)", async () => {
    const created = await createProfile();
    const update = await app.request(`/api/copilot/profiles/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Card games v2", maxSteps: 12 }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { name: string; maxSteps: number; basePrompt: string };
    expect(updated.name).toBe("Card games v2");
    expect(updated.maxSteps).toBe(12);
    expect(updated.basePrompt).toBe("You help author card-game experiences.");
  });
});

describe("DELETE /api/copilot/profiles/:id", () => {
  test("rejects the read-only built-in seed → 400", async () => {
    const res = await app.request("/api/copilot/profiles/builtin", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/read-only/i);
  });

  test("deletes a user profile", async () => {
    const created = await createProfile();
    const del = await app.request(`/api/copilot/profiles/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const list = await app.request("/api/copilot/profiles");
    const body = (await list.json()) as { profiles: Array<{ id: string }> };
    expect(body.profiles.some((p) => p.id === created.id)).toBe(false);
  });
});
