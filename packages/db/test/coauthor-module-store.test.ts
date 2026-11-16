import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { coauthorModules } from "../src/db-schema.js";
import { CoauthorModuleStore } from "../src/stores/coauthor-module-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const testClock: StoreClock = {
  now() {
    return "2026-06-06T00:00:00.000Z";
  },
};

let nextId = 0;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    nextId += 1;
    return `${prefix}_test_${nextId}`;
  },
};

async function mkStore(): Promise<CoauthorModuleStore> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
  const db = await createDb(join(dir, "test.db"));
  return new CoauthorModuleStore(db, { clock: testClock, idGenerator: testIdGen });
}

const PAYLOAD = {
  name: "My Module",
  description: "A custom module",
  basePrompt: "You are a co-author. ...",
  openingMessage: "Hi, I'll help with {{char}}.",
  skillIds: ["general-writing"],
  toolSet: { write_profile: true, edit_personality: true },
  maxSteps: 4,
};

describe("CoauthorModuleStore (CS-24)", () => {
  test("create + getById round-trip preserves all fields", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    expect(created.id).toMatch(/^cmod_test_\d+$/);
    expect(created.name).toBe("My Module");
    expect(created.description).toBe("A custom module");
    expect(created.basePrompt).toBe("You are a co-author. ...");
    expect(created.openingMessage).toBe("Hi, I'll help with {{char}}.");
    expect(created.skillIds).toEqual(["general-writing"]);
    expect(created.toolSet).toEqual({ write_profile: true, edit_personality: true });
    expect(created.maxSteps).toBe(4);
    expect(created.sortOrder).toBe(0);
    expect(created.createdAt).toBe("2026-06-06T00:00:00.000Z");
    expect(created.updatedAt).toBe("2026-06-06T00:00:00.000Z");

    const fetched = await store.getById(created.id);
    expect(fetched).toEqual(created);
  });

  test("list returns all created modules", async () => {
    const store = await mkStore();
    await store.create({ ...PAYLOAD, name: "A" });
    await store.create({ ...PAYLOAD, name: "B" });
    const all = await store.list();
    expect(all.length).toBe(2);
    expect(all.map((m) => m.name).sort()).toEqual(["A", "B"]);
  });

  test("update merges a partial (single field) and bumps updatedAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
    const db = await createDb(join(dir, "test.db"));
    let tick = 0;
    const steppedClock: StoreClock = {
      now() {
        tick += 1;
        return `2026-06-06T00:00:0${tick - 1}.000Z`;
      },
    };
    const store = new CoauthorModuleStore(db, { clock: steppedClock, idGenerator: testIdGen });
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, { maxSteps: 9 });
    expect(updated.maxSteps).toBe(9);
    expect(updated.createdAt).toBe("2026-06-06T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-06-06T00:00:01.000Z");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.name).toBe("My Module"); // untouched
    expect(updated.description).toBe(PAYLOAD.description);
    expect(updated.basePrompt).toBe(PAYLOAD.basePrompt); // untouched
    expect(updated.openingMessage).toBe(PAYLOAD.openingMessage);
    expect(updated.skillIds).toEqual(PAYLOAD.skillIds);
    expect(updated.toolSet).toEqual(PAYLOAD.toolSet);
    expect(await store.getById(created.id)).toEqual(updated);
  });

  test("update with a full payload replaces every field", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, {
      name: "Renamed",
      description: "new desc",
      basePrompt: "new prompt",
      openingMessage: "new opening",
      skillIds: ["dialogue-generation"],
      toolSet: { edit_examples: true },
      maxSteps: 7,
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.description).toBe("new desc");
    expect(updated.basePrompt).toBe("new prompt");
    expect(updated.openingMessage).toBe("new opening");
    expect(updated.skillIds).toEqual(["dialogue-generation"]);
    expect(updated.toolSet).toEqual({ edit_examples: true });
    expect(updated.maxSteps).toBe(7);
    expect(await store.getById(created.id)).toEqual(updated);
  });

  test("update throws when the id does not exist", async () => {
    const store = await mkStore();
    await expect(store.update("cmod_missing", { maxSteps: 1 })).rejects.toThrow();
  });

  test("delete removes the module and is idempotent", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
    // Deleting again does not throw (idempotent).
    await store.delete(created.id);
  });

  test("legacy `edit_profile` toolSet flag is normalized to `write_profile` on read", async () => {
    // A module saved before the edit_profile→write_profile rename carries the
    // old flag in toolSetJson; parseToolSet aliases it on read (the registry
    // reads toolSet raw, so this read boundary is the single alias site) so the
    // tool stays enabled without a data migration.
    const store = await mkStore();
    const created = await store.create({ ...PAYLOAD, toolSet: { edit_profile: true } });
    expect(created.toolSet).toEqual({ write_profile: true });
    const fetched = await store.getById(created.id);
    expect(fetched?.toolSet).toEqual({ write_profile: true });
  });

  test("legacy lore-authoring modules gain the persisted-book edit/add tools on read", async () => {
    // These tools existed in the executor but were absent from the module
    // contract, so older modules could not explicitly enable them. Preserve an
    // explicit false once the toggles exist, but fill every formerly
    // unrepresentable capability for a module that already authors lore.
    const store = await mkStore();
    const created = await store.create({
      ...PAYLOAD,
      toolSet: {
        create_lorebook: true,
        create_lore_entry: true,
        edit_lorebook: false,
      },
    });
    expect(created.toolSet).toMatchObject({
      create_lorebook: true,
      create_lore_entry: true,
      edit_lorebook: false,
      edit_lore_entry: true,
      add_lore_entry: true,
    });
  });

  test("explicit false persisted-lore flags remain opt-outs", async () => {
    const store = await mkStore();
    const created = await store.create({
      ...PAYLOAD,
      toolSet: {
        create_lorebook: true,
        create_lore_entry: true,
        edit_lorebook: false,
        edit_lore_entry: false,
        add_lore_entry: false,
      },
    });
    expect(created.toolSet).toMatchObject({
      edit_lorebook: false,
      edit_lore_entry: false,
      add_lore_entry: false,
    });
  });

  test("getById returns null for a missing id", async () => {
    const store = await mkStore();
    expect(await store.getById("cmod_missing")).toBeNull();
  });
});

describe("CoauthorModuleStore — stored order (ML-5)", () => {
  test("create appends at the end; list returns creation order", async () => {
    const store = await mkStore();
    const a = await store.create({ ...PAYLOAD, name: "A" });
    const b = await store.create({ ...PAYLOAD, name: "B" });
    const c = await store.create({ ...PAYLOAD, name: "C" });
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    expect(c.sortOrder).toBe(2);
    expect((await store.list()).map((m) => m.name)).toEqual(["A", "B", "C"]);
  });

  test("reorder rewrites sort_order; list follows the stored order", async () => {
    const store = await mkStore();
    const a = await store.create({ ...PAYLOAD, name: "A" });
    const b = await store.create({ ...PAYLOAD, name: "B" });
    const c = await store.create({ ...PAYLOAD, name: "C" });
    const list = await store.reorder([
      { id: c.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
      { id: b.id, sortOrder: 2 },
    ]);
    expect(list.map((m) => m.name)).toEqual(["C", "A", "B"]);
    expect((await store.list()).map((m) => m.name)).toEqual(["C", "A", "B"]);
  });

  test("create after a reorder appends at the END (max+1, not old position)", async () => {
    const store = await mkStore();
    const a = await store.create({ ...PAYLOAD, name: "A" });
    const b = await store.create({ ...PAYLOAD, name: "B" });
    await store.reorder([
      { id: b.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
    ]);
    const c = await store.create({ ...PAYLOAD, name: "C" });
    expect(c.sortOrder).toBe(2);
    expect((await store.list()).map((m) => m.name)).toEqual(["B", "A", "C"]);
  });

  test("equal sort_order falls back to createdAt ASC, then id ASC (total order)", async () => {
    // Rows the order does not know (or rows tied by a bulk backfill) must not
    // shuffle nondeterministically: the store's list ordering stays total via
    // created_at → id fallbacks. Insert IDs out of alphabetical order ("C", "A", "B")
    // so id ASC differs from insertion/rowid order when sort_order and createdAt tie.
    const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
    const db = await createDb(join(dir, "test.db"));
    const ids = ["cmod_c", "cmod_a", "cmod_b"];
    let idIdx = 0;
    const outOfOrderIdGen: StoreIdGenerator = {
      next() {
        return ids[idIdx++]!;
      },
    };
    const store = new CoauthorModuleStore(db, { clock: testClock, idGenerator: outOfOrderIdGen });
    await store.create({ ...PAYLOAD, name: "C" });
    await store.create({ ...PAYLOAD, name: "A" });
    await store.create({ ...PAYLOAD, name: "B" });
    await db
      .update(coauthorModules)
      .set({ sortOrder: 0 })
      .run();
    const all = await store.list();
    expect(all.every((m) => m.sortOrder === 0)).toBe(true);
    expect(all.map((m) => m.id)).toEqual(["cmod_a", "cmod_b", "cmod_c"]); // same clock ⇒ id ASC
    expect(all.map((m) => m.name)).toEqual(["A", "B", "C"]);
  });

  test("createdAt breaks a sort_order tie before id is consulted", async () => {
    // Pit createdAt ASC strictly against BOTH insertion order and id ASC:
    // the later-timestamp row is inserted first with a smaller id, while the
    // earlier-timestamp row is inserted second with a larger id.
    const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
    const db = await createDb(join(dir, "test.db"));
    const times = ["2026-06-06T00:00:02.000Z", "2026-06-06T00:00:01.000Z"];
    let tIdx = 0;
    const reverseClock: StoreClock = {
      now() {
        return times[tIdx++]!;
      },
    };
    const ids = ["cmod_a", "cmod_z"];
    let idIdx = 0;
    const idGen: StoreIdGenerator = {
      next() {
        return ids[idIdx++]!;
      },
    };
    const store = new CoauthorModuleStore(db, { clock: reverseClock, idGenerator: idGen });
    await store.create({ ...PAYLOAD, name: "second-chronologically" });
    await store.create({ ...PAYLOAD, name: "first-chronologically" });
    await db
      .update(coauthorModules)
      .set({ sortOrder: 0 })
      .run();
    const all = await store.list();
    expect(all.map((m) => m.name)).toEqual(["first-chronologically", "second-chronologically"]);
    expect(all.map((m) => m.id)).toEqual(["cmod_z", "cmod_a"]);
  });
});
