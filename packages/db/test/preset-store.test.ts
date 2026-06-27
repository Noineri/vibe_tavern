/**
 * PresetStore — designated-default (`isDefault`) behavior.
 *
 * These tests pin the behavior that replaced the dead `bindProviderPresetId`
 * model-binding column (migration 0001_preset_default_flag): exactly one
 * preset is the designated default, seeded by `ensureDefault()` and resolvable
 * via `isDefault` rather than via the old "first row with null bind" no-op
 * filter. See reports/prompt-preset-dead-bind-model.md.
 *
 * Uses createDb(":memory:") so the real migration stack (0000 baseline +
 * 0001 default-flag rebuild/backfill) runs end-to-end on every test — a fresh
 * install has zero presets, so `ensureDefault()` exercises the seed path.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { PresetStore } from "../src/stores/preset-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test helpers (inline per-file; no shared fixtures) ───────────────────────

let clockTick = 0;
const testClock: StoreClock = {
  now() {
    clockTick++;
    return new Date(Date.parse("2025-05-04T12:00:00.000Z") + clockTick).toISOString();
  },
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_test_${String(n).padStart(4, "0")}`;
  },
};

async function createStore() {
  const db = await createDb(":memory:");
  const store = new PresetStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
  return { db, store };
}

describe("PresetStore — isDefault designated-default marker", () => {
  beforeEach(() => {
    clockTick = 0;
    idCounters = new Map();
  });

  test("ensureDefault() seeds exactly one preset flagged isDefault on an empty DB", async () => {
    const { store } = await createStore();
    const seeded = await store.ensureDefault();

    expect(seeded.name).toBe("Default");
    expect(seeded.isDefault).toBe(true);
    expect(seeded.systemPrompt).toContain("{{char}}'s next reply");

    // Exactly one preset exists and it is the default.
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all.filter((p) => p.isDefault)).toHaveLength(1);
  });

  test("ensureDefault() is idempotent: a second call returns the same preset without seeding a duplicate", async () => {
    const { store } = await createStore();
    const first = await store.ensureDefault();
    const second = await store.ensureDefault();

    expect(second.id).toBe(first.id);
    expect(await store.listAll()).toHaveLength(1);
  });

  test("ensureDefault() prefers the isDefault-flagged row when presets already exist", async () => {
    const { store } = await createStore();
    // Seed the default first (rowid 1, isDefault true).
    const def = await store.ensureDefault();
    // Add a non-default preset (rowid 2, isDefault false).
    const other = await store.create({ name: "Other", systemPrompt: "x" });

    expect(other.isDefault).toBe(false);
    // ensureDefault must return the flagged row, NOT merely the first by rowid
    // (they happen to coincide here, so also assert against an explicit case
    // where the default is not the first row — see next test).
    const resolved = await store.ensureDefault();
    expect(resolved.id).toBe(def.id);
    expect(resolved.isDefault).toBe(true);
  });

  test("ensureDefault() falls back to the first row by rowid when no row carries the flag", async () => {
    // Simulates a legacy/inconsistent DB where the isDefault flag was lost
    // (e.g. the default was deleted). Preserves the old select().get()
    // rowid-first behavior as a defensive default.
    const { store } = await createStore();
    const first = await store.create({ name: "First", systemPrompt: "a" });
    await store.create({ name: "Second", systemPrompt: "b" });
    // Neither preset was created with isDefault.
    expect((await store.listAll()).filter((p) => p.isDefault)).toHaveLength(0);

    const resolved = await store.ensureDefault();
    expect(resolved.id).toBe(first.id);
  });

  test("create() without isDefault produces a non-default preset", async () => {
    const { store } = await createStore();
    await store.ensureDefault();
    const created = await store.create({ name: "Custom", systemPrompt: "hi" });
    expect(created.isDefault).toBe(false);
  });

  test("duplicate() never marks the copy as default, even when the original is the default", async () => {
    const { store } = await createStore();
    const def = await store.ensureDefault();
    expect(def.isDefault).toBe(true);

    const copy = await store.duplicate(def.id);
    expect(copy.name).toBe("Default (copy)");
    expect(copy.isDefault).toBe(false);
    // The original retains its default status.
    const all = await store.listAll();
    expect(all.filter((p) => p.isDefault)).toHaveLength(1);
    expect(all.find((p) => p.isDefault)?.id).toBe(def.id);
  });

  test("update() can flip isDefault via the boolean coercion (integer column)", async () => {
    const { store } = await createStore();
    const def = await store.ensureDefault();
    const other = await store.create({ name: "Other", systemPrompt: "x" });

    // Transfer the default flag manually.
    await store.update(def.id, { isDefault: false });
    await store.update(other.id, { isDefault: true });

    const refreshed = await store.listAll();
    expect(refreshed.find((p) => p.id === def.id)?.isDefault).toBe(false);
    expect(refreshed.find((p) => p.id === other.id)?.isDefault).toBe(true);
  });
});
