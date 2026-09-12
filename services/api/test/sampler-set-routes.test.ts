import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { createSamplerSetRoutes } from "../src/api/routes/sampler-set.js";
import { SamplerSetAdapter } from "../src/api/adapters/sampler-set-adapter.js";
import {
	isDomainError,
	httpStatusForDomainError,
	domainErrorToJson,
} from "../src/shared/errors.js";

/**
 * LOCAL_SUPPORT_PLAN LS-5b — sampler-set library HTTP routes. Mirrors the
 * small-resource route test (copilot-profile-routes.test.ts) with the real
 * store container + adapter (DB round-trip exercised end-to-end, no mocked
 * store). Pins: GET/POST/GET-list, PATCH rename + payload save, DELETE
 * (clearing provider_profiles.sampler_set_id references first, LS-5e), and
 * the import sniff (VT-native set JSON vs ST TextGen Settings file →
 * parseStTextgen pre-mapping + notes, LS-5g). Name collisions surface as
 * 409 via the same production DomainError mapping the app mounts.
 */

let stores: StoreContainer;
let app: ReturnType<typeof createSamplerSetRoutes>;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-sampler-set-routes-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  app = createSamplerSetRoutes(new SamplerSetAdapter(stores));
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
});

interface WireSet {
  id: string;
  name: string;
  sortOrder: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const jsonHeaders = { "content-type": "application/json" };

async function createSet(name: string, payload: Record<string, unknown> = { temperature: 0.7 }): Promise<WireSet> {
  const res = await app.request("/api/sampler-sets", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name, payload }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as WireSet;
}

/** The owner's real ST TextGen shape (Divine Intellect slice — see the parser
 *  fixtures in packages/import-export/test/st-textgen.test.ts). */
const ST_TEXTGEN = {
  temp: 1.31,
  top_p: 0.14,
  top_k: 49,
  min_p: 0,
  rep_pen: 1.17,
  dry_sequence_breakers: '["\\n", ":", "\\"", "*"]',
  sampler_order: [6, 0, 1, 3, 4, 2, 5],
};

describe("POST /api/sampler-sets", () => {
  test("creates a set and lists it", async () => {
    const created = await createSet("Divine Intellect", { temperature: 1.31, topP: 0.14 });
    expect(created.id).toMatch(/^sset/);
    expect(created.name).toBe("Divine Intellect");
    expect(created.payload).toEqual({ temperature: 1.31, topP: 0.14 });

    const list = await app.request("/api/sampler-sets");
    expect(list.status).toBe(200);
    const body = (await list.json()) as WireSet[];
    expect(body.find((s) => s.id === created.id)?.name).toBe("Divine Intellect");
  });

  test("rejects a duplicate name (case-insensitive) → 409", async () => {
    await createSet("Alpha", {});
    const res = await app.request("/api/sampler-sets", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "alpha", payload: {} }),
    });
    expect(res.status).toBe(409);
  });

  test("rejects a payload the set schema refuses → 400", async () => {
    const res = await app.request("/api/sampler-sets", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "Bad", payload: { temperature: "hot" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/sampler-sets/:setId", () => {
  test("renames and saves payload independently (partial update preserves the rest)", async () => {
    const created = await createSet("Before", { temperature: 0.7, topK: 40 });

    const renamed = await app.request(`/api/sampler-sets/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "After" }),
    });
    expect(renamed.status).toBe(200);
    const afterRename = (await renamed.json()) as WireSet;
    expect(afterRename.name).toBe("After");
    expect(afterRename.payload).toEqual({ temperature: 0.7, topK: 40 });

    const resaved = await app.request(`/api/sampler-sets/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ payload: { temperature: 1.2 } }),
    });
    expect(resaved.status).toBe(200);
    const afterSave = (await resaved.json()) as WireSet;
    expect(afterSave.name).toBe("After");
    expect(afterSave.payload).toEqual({ temperature: 1.2 });
  });

  test("rename onto an existing name → 409; renaming to the set's own name is fine", async () => {
    const a = await createSet("Keep");
    const b = await createSet("Target");

    const clash = await app.request(`/api/sampler-sets/${b.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "keep" }),
    });
    expect(clash.status).toBe(409);

    const self = await app.request(`/api/sampler-sets/${a.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "Keep" }),
    });
    expect(self.status).toBe(200);
  });

  test("unknown id → 400", async () => {
    const res = await app.request("/api/sampler-sets/sset_ghost", {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/sampler-sets/:setId", () => {
  test("clears provider_profiles.sampler_set_id references, then deletes the set", async () => {
    const created = await createSet("Doomed", { temperature: 1.31 });
    const profile = await stores.providers.create({
      name: "linked",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
      samplerSetId: created.id,
    });

    const res = await app.request(`/api/sampler-sets/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(await stores.samplerSets.getById(created.id)).toBeNull();
    // Copy-on-select (LS-5e): the applied VALUES stay on the profile — only
    // the pointer is cleared, never left dangling.
    const after = await stores.providers.getById(profile.id);
    expect(after?.samplerSetId).toBeNull();
  });
});

describe("POST /api/sampler-sets/import", () => {
  test("ST TextGen file: pre-maps the ooba spellings + returns skipped-field notes", async () => {
    const res = await app.request("/api/sampler-sets/import", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "Imported ST", raw: ST_TEXTGEN }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { set: WireSet; notes: string[] };
    expect(body.set.payload).toEqual({
      temperature: 1.31,
      topP: 0.14,
      topK: 49,
      minP: 0,
      repetitionPenalty: 1.17,
      drySequenceBreakers: ["\n", ":", '"', "*"],
    });
    // sampler_order carries a value the mapping can't land — surfaced, never silent.
    expect(body.notes.some((n) => n.startsWith("sampler_order"))).toBe(true);
  });

  test("VT-native set JSON imports as-is with no notes", async () => {
    const res = await app.request("/api/sampler-sets/import", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "VT native", raw: { temperature: 0.9, drySequenceBreakers: ["\n"] } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { set: WireSet; notes: string[] };
    expect(body.set.payload).toEqual({ temperature: 0.9, drySequenceBreakers: ["\n"] });
    expect(body.notes).toEqual([]);
  });

  test("a random JSON object is rejected loudly, not stored as an empty set → 400", async () => {
    const res = await app.request("/api/sampler-sets/import", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "Junk", raw: { hello: "world" } }),
    });
    expect(res.status).toBe(400);
  });

  test("an empty raw object is rejected (the all-optional schema alone would accept it) → 400", async () => {
    const res = await app.request("/api/sampler-sets/import", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "Empty", raw: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("an ST-shaped import with an existing name → 409", async () => {
    await createSet("Dup ST", {});
    const res = await app.request("/api/sampler-sets/import", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "dup st", raw: ST_TEXTGEN }),
    });
    expect(res.status).toBe(409);
  });
});
