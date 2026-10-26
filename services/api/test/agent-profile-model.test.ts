import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
// Side-effect imports: register the real kinds the model routes address —
// experience (the family default) and sidechat-ooc (ships the second built-in
// seed `builtin-director` since DR-1; production registers both in
// server-runtime.ts).
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/sidechat-ooc-kind.js";
import { createCopilotProfileRoutes } from "../src/api/routes/copilot-profile.js";
import { CopilotProfileAdapter } from "../src/api/adapters/copilot-profile-adapter.js";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * DR-2 (owner ruling 2026-10-25, M1 — see DIRECTOR_MODE_PLAN.md) — a
 * profile's own model, read/set/clear per (agent kind, profile id). Pins the
 * plan's route contract through the REAL adapter + routes + store container
 * (no mocked store — the same end-to-end shape as copilot-profile-routes
 * .test.ts):
 *
 * 1. set + clear a BUILT-IN's model — including `builtin-director` — works:
 *    the model is a setting, not an edit, so the read-only guard that 400s
 *    prompt/tool edits never fires here (juxtaposed with the guard itself);
 * 2. set + clear a USER profile's model;
 * 3. nothing stored reads `{ model: null }` — same-as-sidechat on the wire;
 * 4. the (kind, id) pair must address something: a foreign kind's built-in
 *    id, another kind's user profile, a dangling user id, and an unknown
 *    kind are 404 / 400 respectively;
 * 5. deleting a USER profile removes its model row (the store-level cascade);
 * 6. the PUT body is `.strict()` and requires a non-empty providerProfileId.
 */

let stores: StoreContainer;
let app: ReturnType<typeof createCopilotProfileRoutes>;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-profile-model-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  app = createCopilotProfileRoutes(new CopilotProfileAdapter(stores));
  // Mount the production DomainError → status mapping (shared helpers, not
  // duplicated logic) so the 400/404 boundaries are observable — the same
  // pattern as copilot-profile-routes.test.ts.
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
});

const MODEL_PATH = (kind: string, profileId: string) =>
  `/api/agent/kinds/${kind}/profiles/${profileId}/model`;

async function getModel(kind: string, profileId: string) {
  const res = await app.request(MODEL_PATH(kind, profileId));
  expect(res.status).toBe(200);
  return (await res.json()) as { model: { providerProfileId: string; modelName: string | null } | null };
}

async function putModel(kind: string, profileId: string, body: Record<string, unknown>) {
  return app.request(MODEL_PATH(kind, profileId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A user profile of the sidechat kind (the director's kind — the M1 user). */
async function createSidechatProfile(): Promise<string> {
  const res = await app.request("/api/copilot/profiles?kind=sidechat-ooc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Director-ish",
      basePrompt: "You direct.",
      toolSet: { search_context: true },
      agentKind: "sidechat-ooc",
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

// ─── Built-in profiles: set / clear (a setting, not an edit) ─────────────────

describe("PUT/GET/DELETE profile model — built-ins (DR-2)", () => {
  test("nothing stored reads { model: null } (same as sidechat)", async () => {
    expect(await getModel("sidechat-ooc", "builtin-director")).toEqual({ model: null });
  });

  test("PUT sets a built-in's model and GET round-trips it", async () => {
    const res = await putModel("sidechat-ooc", "builtin-director", {
      providerProfileId: "prov-own",
      modelName: "dir-model",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: { providerProfileId: "prov-own", modelName: "dir-model" } });
    expect(await getModel("sidechat-ooc", "builtin-director")).toEqual({
      model: { providerProfileId: "prov-own", modelName: "dir-model" },
    });
  });

  test("the FIRST built-in (`builtin`) is settable alike, modelName null = provider default", async () => {
    const res = await putModel("sidechat-ooc", "builtin", { providerProfileId: "prov-own" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: { providerProfileId: "prov-own", modelName: null } });
  });

  test("DELETE clears a built-in's model back to { model: null }", async () => {
    await putModel("sidechat-ooc", "builtin-director", { providerProfileId: "prov-own", modelName: "m" });
    const res = await app.request(MODEL_PATH("sidechat-ooc", "builtin-director"), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getModel("sidechat-ooc", "builtin-director")).toEqual({ model: null });
  });

  test("the model routes never hit the read-only guard (the prompt edit still 400s)", async () => {
    // Juxtaposition: the SAME built-in id accepts a model write while the
    // prompt/tool edit keeps the read-only 400 — a setting, not an edit.
    const modelRes = await putModel("sidechat-ooc", "builtin-director", { providerProfileId: "p" });
    expect(modelRes.status).toBe(200);
    const patchRes = await app.request("/api/copilot/profiles/builtin-director", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(patchRes.status).toBe(400);
  });
});

// ─── User profiles: set / clear + the delete cascade ─────────────────────────

describe("PUT/GET/DELETE profile model — user profiles (DR-2)", () => {
  test("PUT sets a user profile's model and DELETE clears it", async () => {
    const id = await createSidechatProfile();
    const res = await putModel("sidechat-ooc", id, { providerProfileId: "prov-x", modelName: "m-x" });
    expect(res.status).toBe(200);
    expect(await getModel("sidechat-ooc", id)).toEqual({
      model: { providerProfileId: "prov-x", modelName: "m-x" },
    });
    const clear = await app.request(MODEL_PATH("sidechat-ooc", id), { method: "DELETE" });
    expect(clear.status).toBe(200);
    expect(await getModel("sidechat-ooc", id)).toEqual({ model: null });
  });

  test("deleting the USER profile removes its model row (store-level cascade)", async () => {
    const id = await createSidechatProfile();
    await putModel("sidechat-ooc", id, { providerProfileId: "prov-x", modelName: "m-x" });
    expect(await stores.agentProfileModels.get("sidechat-ooc", id)).not.toBeNull();

    const res = await app.request(`/api/copilot/profiles/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    // The row is GONE at the store level, not merely unreachable through the
    // 404-ing route (the plan's delete-cascade test).
    expect(await stores.agentProfileModels.get("sidechat-ooc", id)).toBeNull();
  });
});

// ─── Addressability + body strictness ────────────────────────────────────────

describe("profile model — addressability and body (DR-2)", () => {
  test("an unknown kind is the family 400 UNKNOWN_AGENT_KIND", async () => {
    const res = await putModel("no-such-kind", "builtin", { providerProfileId: "p" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details?: { code?: string } } };
    expect(body.error.details?.code).toBe("UNKNOWN_AGENT_KIND");
  });

  test("a foreign kind's built-in id is a 404 (not one of that kind's seeds)", async () => {
    const res = await putModel("experience", "builtin-director", { providerProfileId: "p" });
    expect(res.status).toBe(404);
  });

  test("a user profile under the WRONG kind is a 404", async () => {
    const id = await createSidechatProfile();
    const res = await putModel("experience", id, { providerProfileId: "p" });
    expect(res.status).toBe(404);
  });

  test("a dangling user profile id is a 404", async () => {
    const res = await app.request(MODEL_PATH("sidechat-ooc", "cprof_missing"));
    expect(res.status).toBe(404);
  });

  test("the PUT body is strict and requires a non-empty providerProfileId", async () => {
    for (const bad of [
      { providerProfileId: "" },
      { modelName: "m" },
      { providerProfileId: "p", extra: true },
    ]) {
      const res = await putModel("sidechat-ooc", "builtin", bad);
      expect(res.status).toBe(400);
    }
  });
});
