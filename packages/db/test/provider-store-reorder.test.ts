import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { ProviderStore, type CreateProviderData } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const testClock: StoreClock = { now: () => "2026-06-06T00:00:00.000Z" };
let nextId = 0;
const testIdGen: StoreIdGenerator = { next: (prefix: string) => `${prefix}_test_${++nextId}` };

const baseProfile: CreateProviderData = {
  name: "Alpha",
  providerPreset: "custom",
  endpoint: "https://localhost/v1",
};

async function mkStore(): Promise<ProviderStore> {
  const dir = await mkdtemp(join(tmpdir(), "vt-prov-test-"));
  const db = await createDb(join(dir, "test.db"));
  return new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
}

function next(name: string): CreateProviderData {
  return { ...baseProfile, name };
}

describe("ProviderStore — reorder + sort_order", () => {
  beforeEach(() => {
    nextId = 0;
  });

  test("reorder rewrites sort_order; listAll reflects the submitted order", async () => {
    const store = await mkStore();
    const a = await store.create(next("A"));
    const b = await store.create(next("B"));
    const c = await store.create(next("C"));
    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "C"]);

    await store.reorder([
      { id: c.id, sortOrder: 0 },
      { id: b.id, sortOrder: 1 },
      { id: a.id, sortOrder: 2 },
    ]);
    expect((await store.listAll()).map((p) => p.name)).toEqual(["C", "B", "A"]);
  });

  test("create() appends at the end even after reorder set a high sort_order", async () => {
    const store = await mkStore();
    const a = await store.create(next("A"));
    const b = await store.create(next("B"));
    await store.reorder([
      { id: b.id, sortOrder: 10 },
      { id: a.id, sortOrder: 20 },
    ]);
    await store.create(next("C"));
    expect((await store.listAll()).map((p) => p.name)).toEqual(["B", "A", "C"]);
  });

  test("duplicate() appends at the end, not sort_order 0", async () => {
    const store = await mkStore();
    const a = await store.create(next("A"));
    await store.create(next("B"));
    const dup = await store.duplicate(a.id);
    expect(dup.name).toBe("A (copy)");
    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "A (copy)"]);
  });

  test("reorder preserves the isActive marker (orthogonal to sort_order)", async () => {
    const store = await mkStore();
    const a = await store.create(next("A"));
    const b = await store.create(next("B"));
    // Activate a (isActive = 1).
    await store.activate(a.id);
    const active = await store.getActive();
    expect(active?.id).toBe(a.id);
    // Reorder to swap positions.
    await store.reorder([
      { id: a.id, sortOrder: 0 },
      { id: b.id, sortOrder: 1 },
    ]);
    // isActive must survive the reorder.
    const stillActive = await store.getActive();
    expect(stillActive?.id).toBe(a.id);
  });
});
