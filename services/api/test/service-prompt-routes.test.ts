import { describe, test, expect } from "bun:test";
import { createDb } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";
import { createServicePromptRoutes } from "../src/api/routes/service-prompts.js";
import { ServicePromptAdapter } from "../src/api/adapters/service-prompt-adapter.js";

const fixedClock: StoreClock = { now: () => "2026-08-26T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = {
  next: (prefix) => `${prefix}_test_${++counter}`,
};

async function setupAdapter() {
  counter = 0;
  const db = await createDb(":memory:");
  const adapter = new ServicePromptAdapter({ db });
  const app = createServicePromptRoutes(adapter);
  return { db, adapter, app };
}

describe("SP-6 service prompt routes (real adapter + in-memory DB)", () => {
  test("PATCH /reorder persists order, skips Default, keeps activeProfileId", async () => {
    const { app } = await setupAdapter();

    const createA = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alpha", overrides: {} }),
    });
    const a = ((await createA.json()) as { id: string }).id;
    const createB = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Beta", overrides: {} }),
    });
    const b = ((await createB.json()) as { id: string }).id;

    // Activate Beta so the reorder response is checked against a live pointer.
    await app.request("/api/service-prompts/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: b }),
    });

    const res = await app.request("/api/service-prompts/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: [{ id: b, sortOrder: 0 }, { id: a, sortOrder: 1 }, { id: "default", sortOrder: 99 }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: Array<{ id: string }>; activeProfileId: string | null };
    // Default pinned first despite the bogus sortOrder 99, then Beta, Alpha.
    expect(body.profiles.map((p) => p.id)).toEqual(["default", b, a]);
    expect(body.activeProfileId).toBe(b);

    // Empty payload is a no-op.
    const noop = await app.request("/api/service-prompts/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: [] }),
    });
    expect(noop.status).toBe(200);
  });

  test("GET /api/service-prompts/profiles self-heals Default and returns activeProfileId", async () => {
    const { app } = await setupAdapter();

    const first = await app.request("/api/service-prompts/profiles");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { profiles: Array<{ id: string; isDefault: boolean }>; activeProfileId: string | null };
    expect(body.profiles.some((p) => p.id === "default" && p.isDefault)).toBe(true);
    expect(body.activeProfileId).toBe(null);

    // Second call does not duplicate Default
    const second = await app.request("/api/service-prompts/profiles");
    const body2 = (await second.json()) as { profiles: Array<{ id: string }> };
    expect(body2.profiles.filter((p) => p.id === "default")).toHaveLength(1);
  });

  test("POST create then GET detail: resolved map covers all 21 fields", async () => {
    const { app } = await setupAdapter();

    const created = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Custom", overrides: { script: "SCRIPT-OVERRIDE", coauthor_base: "COAUTHOR-OVERRIDE" } }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; name: string; overrides: Record<string, string> };
    expect(createdBody.name).toBe("Custom");
    expect(createdBody.overrides.script).toBe("SCRIPT-OVERRIDE");

    const detail = await app.request(`/api/service-prompts/profiles/${createdBody.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      profile: { id: string; overrides: Record<string, string> };
      resolved: Record<string, { override: string | null; default: string }>;
    };
    // All 21 keys present
    expect(Object.keys(detailBody.resolved)).toHaveLength(SERVICE_PROMPT_FIELD_KEYS.length);
    for (const key of SERVICE_PROMPT_FIELD_KEYS) {
      expect(detailBody.resolved[key]).toBeDefined();
      expect(typeof detailBody.resolved[key].default).toBe("string");
      expect(detailBody.resolved[key].default.length).toBeGreaterThan(0);
    }
    expect(detailBody.resolved.script.override).toBe("SCRIPT-OVERRIDE");
    expect(detailBody.resolved.coauthor_base.override).toBe("COAUTHOR-OVERRIDE");
    // Non-overridden field has null override
    expect(detailBody.resolved.summary.override).toBe(null);
  });

  test("GET detail for Default: all overrides null, defaults non-empty", async () => {
    const { app } = await setupAdapter();
    // Ensure Default exists via list
    await app.request("/api/service-prompts/profiles");
    const detail = await app.request("/api/service-prompts/profiles/default");
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      profile: { id: string; isDefault: boolean; overrides: Record<string, string> };
      resolved: Record<string, { override: string | null; default: string }>;
    };
    expect(body.profile.isDefault).toBe(true);
    expect(Object.keys(body.profile.overrides)).toHaveLength(0);
    for (const key of SERVICE_PROMPT_FIELD_KEYS) {
      expect(body.resolved[key].override).toBe(null);
      expect(body.resolved[key].default.length).toBeGreaterThan(0);
    }
  });

  test("PATCH non-default succeeds; PATCH Default → 403 and unchanged", async () => {
    const { app } = await setupAdapter();
    await app.request("/api/service-prompts/profiles");

    const created = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "PatchMe", overrides: {} }),
    });
    const { id } = (await created.json()) as { id: string };

    const patchOk = await app.request(`/api/service-prompts/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", overrides: { summary: "SUM-OVERRIDE" } }),
    });
    expect(patchOk.status).toBe(200);
    const patched = (await patchOk.json()) as { name: string; overrides: Record<string, string> };
    expect(patched.name).toBe("Renamed");
    expect(patched.overrides.summary).toBe("SUM-OVERRIDE");

    const patchDefault = await app.request("/api/service-prompts/profiles/default", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(patchDefault.status).toBe(403);
    const before = await app.request("/api/service-prompts/profiles/default");
    const beforeBody = (await before.json()) as { profile: { name: string } };
    expect(beforeBody.profile.name).toBe("Default");
  });

  test("PATCH unknown id → 404", async () => {
    const { app } = await setupAdapter();
    const res = await app.request("/api/service-prompts/profiles/unknown_id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(404);
  });

  test("DELETE Default → 403; DELETE custom → ok; active resets to null when deleted was active", async () => {
    const { app } = await setupAdapter();
    await app.request("/api/service-prompts/profiles");

    // Delete Default forbidden
    const delDefault = await app.request("/api/service-prompts/profiles/default", { method: "DELETE" });
    expect(delDefault.status).toBe(403);

    // Create two customs
    const c1 = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ToDelete", overrides: {} }),
    });
    const { id: id1 } = (await c1.json()) as { id: string };
    const c2 = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Keep", overrides: {} }),
    });
    const { id: id2 } = (await c2.json()) as { id: string };

    // Make id1 active
    const activate = await app.request("/api/service-prompts/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id1 }),
    });
    expect(activate.status).toBe(200);
    const listAfterActive = (await (await app.request("/api/service-prompts/profiles")).json()) as { activeProfileId: string | null };
    expect(listAfterActive.activeProfileId).toBe(id1);

    // Delete active → resets to null
    const delActive = await app.request(`/api/service-prompts/profiles/${id1}`, { method: "DELETE" });
    expect(delActive.status).toBe(200);
    const listAfterDelete = (await (await app.request("/api/service-prompts/profiles")).json()) as { activeProfileId: string | null };
    expect(listAfterDelete.activeProfileId).toBe(null);
    const gone = await app.request(`/api/service-prompts/profiles/${id1}`);
    expect(gone.status).toBe(404);

    // Delete non-active custom still ok, active stays null
    const del2 = await app.request(`/api/service-prompts/profiles/${id2}`, { method: "DELETE" });
    expect(del2.status).toBe(200);
    const listAfterDel2 = (await (await app.request("/api/service-prompts/profiles")).json()) as { activeProfileId: string | null };
    expect(listAfterDel2.activeProfileId).toBe(null);
  });

  test("DELETE unknown id → 404", async () => {
    const { app } = await setupAdapter();
    const res = await app.request("/api/service-prompts/profiles/does_not_exist", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("PUT active: unknown id → 404; real id → active changes; null → falls back", async () => {
    const { app } = await setupAdapter();
    await app.request("/api/service-prompts/profiles");

    const unknown = await app.request("/api/service-prompts/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "nope" }),
    });
    expect(unknown.status).toBe(404);

    const created = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ActiveOne", overrides: {} }),
    });
    const { id } = (await created.json()) as { id: string };

    const set = await app.request("/api/service-prompts/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id }),
    });
    expect(set.status).toBe(200);
    const list1 = (await (await app.request("/api/service-prompts/profiles")).json()) as { activeProfileId: string | null };
    expect(list1.activeProfileId).toBe(id);

    // Set back to Default via null
    const toNull = await app.request("/api/service-prompts/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: null }),
    });
    expect(toNull.status).toBe(200);
    const list2 = (await (await app.request("/api/service-prompts/profiles")).json()) as { activeProfileId: string | null };
    expect(list2.activeProfileId).toBe(null);

    // Can also set active to Default explicitly
    const toDefault = await app.request("/api/service-prompts/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "default" }),
    });
    expect(toDefault.status).toBe(200);
    const list3 = (await (await app.request("/api/service-prompts/profiles")).json()) as { activeProfileId: string | null };
    expect(list3.activeProfileId).toBe("default");
  });

  test("GET unknown id → 404", async () => {
    const { app } = await setupAdapter();
    const res = await app.request("/api/service-prompts/profiles/unknown_id");
    expect(res.status).toBe(404);
  });

  test("POST validation: empty name → 400; unknown override key → 400", async () => {
    const { app } = await setupAdapter();
    const emptyName = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", overrides: {} }),
    });
    expect(emptyName.status).toBe(400);

    const badKey = await app.request("/api/service-prompts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", overrides: { not_a_field: "x" } }),
    });
    expect(badKey.status).toBe(400);
  });
});
