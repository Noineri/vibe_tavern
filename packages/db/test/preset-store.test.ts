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
import { Database } from "bun:sqlite";
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

  test("mergeConsecutiveRoles defaults false and survives create, update, and duplicate", async () => {
    const { store } = await createStore();
    const defaulted = await store.create({ name: "Defaulted" });
    expect(defaulted.mergeConsecutiveRoles).toBe(false);

    const enabled = await store.create({ name: "Enabled", mergeConsecutiveRoles: true });
    expect(enabled.mergeConsecutiveRoles).toBe(true);
    expect((await store.getById(enabled.id))?.mergeConsecutiveRoles).toBe(true);

    const copy = await store.duplicate(enabled.id);
    expect(copy.mergeConsecutiveRoles).toBe(true);

    const disabled = await store.update(enabled.id, { mergeConsecutiveRoles: false });
    expect(disabled.mergeConsecutiveRoles).toBe(false);
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

describe("PresetStore — delete() FK diagnostics (PRESET_COPY_DELETE_CORRUPTION bug 2)", () => {
  beforeEach(() => {
    clockTick = 0;
    idCounters = new Map();
  });

  test("on FK failure, the thrown error names the referencing child table/rows and the preset is NOT deleted", async () => {
    const { db, store } = await createStore();
    const preset = await store.ensureDefault();

    // Synthesize a child table with a NO-ACTION FK to prompt_presets and a row
    // referencing the seeded preset — the realistic shape of hypothesis (a): a
    // DB from an older build where the FK was added without ON DELETE SET NULL
    // (SQLite cannot retroactively change an FK; only a table rebuild can).
    // The real schema's three preset FKs are all SET NULL, so they cannot block
    // a delete; this synthetic blocker stands in for the stale-FK case.
    const client = (db as unknown as { $client: Database }).$client;
    client.exec(
      'CREATE TABLE test_preset_blocker (child_id TEXT PRIMARY KEY, preset_id TEXT NOT NULL REFERENCES prompt_presets(id))',
    );
    client
      .prepare('INSERT INTO test_preset_blocker (child_id, preset_id) VALUES (\'b1\', ?)')
      .run(preset.id);

    // The delete fails with the FK constraint, but now carrying the diagnostic.
    let thrown: unknown;
    try {
      await store.delete(preset.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('FOREIGN KEY');
    // The diagnostic surfaced the blocking child (table.column=count).
    expect(msg).toContain('test_preset_blocker');
    expect(msg).toContain('preset_id=1');
    expect(msg).toContain('referencing_children=');
    // No pre-existing orphan corruption in this setup.
    expect(msg).toContain('foreign_key_check=(none)');

    // The delete did NOT happen — preset row still present (diagnostic must not
    // swallow/downgrade the failure into a silent success).
    expect(await store.getById(preset.id)).not.toBeNull();
  });

  test("an unblocked delete still succeeds and throws nothing (diagnostic path is FK-only)", async () => {
    const { store } = await createStore();
    const preset = await store.ensureDefault();
    // Nothing references the preset → delete succeeds; the try/catch must not
    // break the normal path or attach any diagnostic.
    await expect(store.delete(preset.id)).resolves.toBeUndefined();
    expect(await store.getById(preset.id)).toBeNull();
  });
});

// ─── reorder + sort_order (PRESET_PROFILE_DND_PLAN Wave 2) ─────────────────────
// These pin the drag-to-reorder persistence path: PresetStore.reorder rewrites
// sort_order for every submitted id in one transaction, listAll orders by it,
// and create()/duplicate() append at MAX(sort_order)+1 so a new/copied preset
// never jumps to the top on the column default 0.
describe("PresetStore — reorder + sort_order", () => {
  beforeEach(() => {
    clockTick = 0;
    idCounters = new Map();
  });

  test("reorder rewrites sort_order; listAll reflects the submitted order", async () => {
    const { store } = await createStore();
    const a = await store.create({ name: "A" });
    const b = await store.create({ name: "B" });
    const c = await store.create({ name: "C" });
    // Creation appends: A(0), B(1), C(2).
    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "C"]);

    // Reverse to C, B, A.
    await store.reorder([
      { id: c.id, sortOrder: 0 },
      { id: b.id, sortOrder: 1 },
      { id: a.id, sortOrder: 2 },
    ]);
    expect((await store.listAll()).map((p) => p.name)).toEqual(["C", "B", "A"]);
  });

  test("reorder accepts non-sequential sort_order values; order is by value", async () => {
    const { store } = await createStore();
    const a = await store.create({ name: "A" });
    const b = await store.create({ name: "B" });
    // Gappy values — listAll must order by the numeric value, not the row id.
    await store.reorder([
      { id: b.id, sortOrder: 10 },
      { id: a.id, sortOrder: 20 },
    ]);
    expect((await store.listAll()).map((p) => p.name)).toEqual(["B", "A"]);
  });

  test("create() appends at the end even after reorder set a high sort_order", async () => {
    const { store } = await createStore();
    const a = await store.create({ name: "A" });
    const b = await store.create({ name: "B" });
    // Push B above A with a high sort_order (B=10, A=20) → listAll [B, A].
    await store.reorder([
      { id: b.id, sortOrder: 10 },
      { id: a.id, sortOrder: 20 },
    ]);
    // A new preset must get sort_order = max(20)+1 = 21 and land at the END,
    // not sort_order 0 (the column default) which would jump it to the top.
    await store.create({ name: "C" });
    expect((await store.listAll()).map((p) => p.name)).toEqual(["B", "A", "C"]);
  });

  test("duplicate() appends at the end, not sort_order 0", async () => {
    const { store } = await createStore();
    const a = await store.create({ name: "A" });
    await store.create({ name: "B" });
    // listAll: [A(0), B(1)]. Duplicate A → must land after B.
    const dup = await store.duplicate(a.id);
    expect(dup.name).toBe("A (copy)");
    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "A (copy)"]);
  });

  test("reorder preserves the isDefault marker (orthogonal to sort_order)", async () => {
    const { store } = await createStore();
    const a = await store.create({ name: "A", isDefault: true });
    const b = await store.create({ name: "B" });
    expect(a.isDefault).toBe(true);
    // Move B above A.
    await store.reorder([
      { id: b.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
    ]);
    const after = await store.listAll();
    expect(after.map((p) => p.name)).toEqual(["B", "A"]);
    expect(after.find((p) => p.name === "A")?.isDefault).toBe(true);
    expect(after.find((p) => p.name === "B")?.isDefault).toBe(false);
  });
});
