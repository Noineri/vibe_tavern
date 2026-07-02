import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
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
  toolSet: { edit_profile: true, edit_personality: true },
  maxSteps: 4,
};

describe("CoauthorModuleStore (CS-24)", () => {
  test("create + getById round-trip preserves all fields", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    expect(created.id).toMatch(/^cmod_test_\d+$/);
    expect(created.name).toBe("My Module");
    expect(created.basePrompt).toBe("You are a co-author. ...");
    expect(created.openingMessage).toBe("Hi, I'll help with {{char}}.");
    expect(created.skillIds).toEqual(["general-writing"]);
    expect(created.toolSet).toEqual({ edit_profile: true, edit_personality: true });
    expect(created.maxSteps).toBe(4);

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
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, { maxSteps: 9 });
    expect(updated.maxSteps).toBe(9);
    expect(updated.name).toBe("My Module"); // untouched
    expect(updated.basePrompt).toBe(PAYLOAD.basePrompt); // untouched
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
    expect(updated.skillIds).toEqual(["dialogue-generation"]);
    expect(updated.toolSet).toEqual({ edit_examples: true });
    expect(updated.maxSteps).toBe(7);
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

  test("getById returns null for a missing id", async () => {
    const store = await mkStore();
    expect(await store.getById("cmod_missing")).toBeNull();
  });
});
