import { describe, test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db-connection.js";
import { ProviderStore, type CreateProviderData } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ASYNC_TRANSACTION_AUDIT fix-step 4 (provider state + cache): pins the three
// provider-store transactions are truly SYNCHRONOUS bun:sqlite callbacks AND
// carries the two validate/dedup changes the audit names:
//  - activate() validates the target BEFORE clearing the old active flag, so a
//    stale id throws instead of silently leaving NO provider active;
//  - saveCachedModels() dedups duplicate model slugs before the delete, so a
//    duplicate slug in the provider response can't wipe the cache via the
//    unique (provider_profile_id, model_slug) index.

// ─── Test harness ────────────────────────────────────────────────────────────

const testClock: StoreClock = { now: () => "2026-07-21T00:00:00.000Z" };

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_arb_${String(n).padStart(4, "0")}`;
  },
};

const baseProfile: CreateProviderData = {
  name: "Alpha",
  providerPreset: "custom",
  endpoint: "https://localhost/v1",
};

let db: AppDb;
let store: ProviderStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  store = new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ProviderStore synchronous-transaction rollback + validate/dedup (ASYNC_TRANSACTION_AUDIT step 4)", () => {
  test("activate on a stale id throws and preserves the currently-active provider", async () => {
    const a = await store.create({ ...baseProfile, name: "A" });
    await store.create({ ...baseProfile, name: "B" });
    await store.activate(a.id);
    expect((await store.getActive())?.id).toBe(a.id);

    // Stale id: OLD code cleared every active flag first, then updated zero
    // rows on the missing id without throwing → NO provider active. The
    // validate-before-clear makes it throw BEFORE any write, so A stays active.
    await expect(store.activate("prov_does_not_exist")).rejects.toThrow(/not found/i);
    expect((await store.getActive())?.id).toBe(a.id);

    // Control: activating a real id still flips the active marker.
    const b = (await store.listAll()).find((p) => p.name === "B")!;
    await store.activate(b.id);
    expect((await store.getActive())?.id).toBe(b.id);
  });

  test("saveCachedModels collapses duplicate slugs and preserves the prior cache on insert failure", async () => {
    const p = await store.create({ ...baseProfile, name: "P" });
    await store.saveCachedModels(p.id, [
      { modelSlug: "old-1", modelName: "Old1" },
      { modelSlug: "old-2", modelName: "Old2" },
    ]);

    // Dedup: a duplicate slug would otherwise hit the unique index on the bulk
    // insert AFTER the old cache was deleted. First occurrence wins.
    await store.saveCachedModels(p.id, [
      { modelSlug: "gpt-4", modelName: "GPT-4" },
      { modelSlug: "gpt-4", modelName: "GPT-4 dup" },
      { modelSlug: "claude", modelName: "Claude" },
    ]);
    const deduped = await store.getCachedModels(p.id);
    expect(deduped.length).toBe(2);
    expect(deduped.map((m) => m.modelSlug).sort()).toEqual(["claude", "gpt-4"]);
    expect(deduped.find((m) => m.modelSlug === "gpt-4")?.modelName).toBe("GPT-4");

    // Re-seed a known prior cache, then fail the replace mid-tx.
    await store.saveCachedModels(p.id, [
      { modelSlug: "old-1", modelName: "Old1" },
      { modelSlug: "old-2", modelName: "Old2" },
    ]);
    db.run(sql`CREATE TRIGGER fail_cmod_insert BEFORE INSERT ON cached_models BEGIN SELECT RAISE(ABORT, 'injected cache boom'); END`);
    await expect(store.saveCachedModels(p.id, [
      { modelSlug: "new-1", modelName: "New1" },
    ])).rejects.toThrow("injected cache boom");

    // Prior complete cache survived — the delete rolled back with the failed insert.
    const afterFail = await store.getCachedModels(p.id);
    expect(afterFail.map((m) => m.modelSlug).sort()).toEqual(["old-1", "old-2"]);
  });

  test("reorder preserves the prior complete order when a mid-reorder update fails", async () => {
    const a = await store.create({ ...baseProfile, name: "A" }); // sortOrder 0
    const b = await store.create({ ...baseProfile, name: "B" }); // sortOrder 1
    const c = await store.create({ ...baseProfile, name: "C" }); // sortOrder 2
    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "C"]);

    // Fail on the LAST reorder update (c). The two earlier updates (a, b)
    // already landed inside the tx; they must roll back too.
    db.run(sql`CREATE TRIGGER fail_reorder_c BEFORE UPDATE ON provider_profiles WHEN NEW.id = '${sql.raw(c.id)}' BEGIN SELECT RAISE(ABORT, 'injected reorder boom'); END`);

    await expect(store.reorder([
      { id: a.id, sortOrder: 2 },
      { id: b.id, sortOrder: 1 },
      { id: c.id, sortOrder: 0 },
    ])).rejects.toThrow("injected reorder boom");

    // Prior order intact — no half-applied reorder leaked.
    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "C"]);
  });
});
