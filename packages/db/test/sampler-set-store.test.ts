import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { SamplerSetStore } from "../src/stores/sampler-set-store.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// LOCAL_SUPPORT_PLAN LS-5a — sampler_sets persistence + the provider-side
// sampler_set_id pointer. Pins: (1) CRUD round-trips incl. the JSON payload
// column, (2) list ordering (sortOrder then name — the library's stable
// order), (3) getByName (the adapter's rename/create collision probe),
// (4) duplicate carrying the pointer over, (5) clearSamplerSetReference
// nulling ONLY the profiles that point at the deleted set (LS-5e — copy-on-
// select: deleting a set must not touch the values profiles already applied).

const FIXED_NOW = "2026-09-09T00:00:00.000Z";

const testClock: StoreClock = { now: () => FIXED_NOW };

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  },
};

let db: Awaited<ReturnType<typeof createDb>>;
let store: SamplerSetStore;
let providers: ProviderStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  store = new SamplerSetStore(db, { clock: testClock, idGenerator: testIdGen });
  providers = new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
});

describe("sampler_sets store CRUD (LS-5a)", () => {
  test("create appends after the last sortOrder and round-trips the payload JSON", async () => {
    const first = await store.create({
      name: "Divine Intellect",
      payload: {
        temperature: 1.31,
        topP: 0.14,
        drySequenceBreakers: ["\n", ":", '"', "*"],
        bannedStrings: [" finger"],
      },
    });
    expect(first.id).toMatch(/^sset/);
    expect(first.name).toBe("Divine Intellect");
    expect(first.sortOrder).toBe(0);
    expect(first.payload).toEqual({
      temperature: 1.31,
      topP: 0.14,
      // Nested arrays survive the JSON column round-trip untouched.
      drySequenceBreakers: ["\n", ":", '"', "*"],
      bannedStrings: [" finger"],
    });
    expect(first.createdAt).toBe(FIXED_NOW);
    expect(first.updatedAt).toBe(FIXED_NOW);

    const second = await store.create({ name: "Big O", payload: { tfsZ: 0.68 } });
    expect(second.sortOrder).toBe(1);

    const fetched = await store.getById(first.id);
    expect(fetched?.payload).toEqual(first.payload);
  });

  test("list orders by sortOrder then name", async () => {
    const c = await store.create({ name: "c", payload: {}, sortOrder: 5 });
    const a = await store.create({ name: "a", payload: {}, sortOrder: 5 });
    const b = await store.create({ name: "b", payload: {}, sortOrder: 1 });
    const rows = await store.list();
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id, c.id]);
  });

  test("getByName matches exact names (the adapter's collision probe)", async () => {
    await store.create({ name: "Divine Intellect", payload: {} });
    expect((await store.getByName("Divine Intellect"))?.name).toBe("Divine Intellect");
    expect(await store.getByName("divine intellect")).toBeNull();
    expect(await store.getByName("nope")).toBeNull();
  });

  test("update rewrites name and/or payload and bumps updatedAt only", async () => {
    const created = await store.create({ name: "before", payload: { temperature: 0.7 } });
    const renamed = await store.update(created.id, { name: "after" });
    expect(renamed.name).toBe("after");
    expect(renamed.payload).toEqual({ temperature: 0.7 });
    expect(renamed.createdAt).toBe(FIXED_NOW);
    expect(renamed.updatedAt).toBe(FIXED_NOW);

    const resaved = await store.update(created.id, { payload: { temperature: 1.2, topK: 49 } });
    expect(resaved.name).toBe("after");
    expect(resaved.payload).toEqual({ temperature: 1.2, topK: 49 });
  });

  test("update and delete throw for an unknown id", async () => {
    await expect(store.update("sset_ghost", { name: "x" })).rejects.toThrow(/not found/);
  });

  test("delete removes the row", async () => {
    const created = await store.create({ name: "gone", payload: {} });
    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
    expect(await store.getByName("gone")).toBeNull();
  });
});

describe("provider_profiles.sampler_set_id pointer (LS-5a/e)", () => {
  test("defaults to null and round-trips a set reference (incl. duplicate)", async () => {
    const profile = await providers.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
    });
    expect(profile.samplerSetId).toBeNull();

    const set = await store.create({ name: "Divine Intellect", payload: {} });
    const linked = await providers.update(profile.id, { samplerSetId: set.id });
    expect(linked.samplerSetId).toBe(set.id);

    // Duplicate carries the pointer (the panel's «duplicate profile» flow
    // keeps pointing at the same set).
    const copy = await providers.duplicate(profile.id);
    expect(copy.samplerSetId).toBe(set.id);

    // "No set" round-trips too.
    const cleared = await providers.update(profile.id, { samplerSetId: null });
    expect(cleared.samplerSetId).toBeNull();
  });

  test("clearSamplerSetReference nulls only the profiles pointing at that set", async () => {
    const setA = await store.create({ name: "Set A", payload: {} });
    const setB = await store.create({ name: "Set B", payload: {} });
    const p1 = await providers.create({
      name: "one", providerPreset: "llamacpp", endpoint: "http://one", samplerSetId: setA.id,
    });
    const p2 = await providers.create({
      name: "two", providerPreset: "llamacpp", endpoint: "http://two", samplerSetId: setA.id,
    });
    const p3 = await providers.create({
      name: "three", providerPreset: "llamacpp", endpoint: "http://three", samplerSetId: setB.id,
    });
    const p4 = await providers.create({
      name: "four", providerPreset: "llamacpp", endpoint: "http://four",
    });

    await providers.clearSamplerSetReference(setA.id);

    const after = await Promise.all([
      providers.getById(p1.id),
      providers.getById(p2.id),
      providers.getById(p3.id),
      providers.getById(p4.id),
    ]);
    expect(after[0]?.samplerSetId).toBeNull();
    expect(after[1]?.samplerSetId).toBeNull();
    // Other sets' references and never-linked profiles stay untouched.
    expect(after[2]?.samplerSetId).toBe(setB.id);
    expect(after[3]?.samplerSetId).toBeNull();
  });
});
