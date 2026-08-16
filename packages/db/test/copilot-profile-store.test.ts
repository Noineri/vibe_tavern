import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { CopilotProfileStore } from "../src/stores/copilot-profile-store.js";
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

async function mkStore(): Promise<CopilotProfileStore> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
  const db = await createDb(join(dir, "test.db"));
  return new CopilotProfileStore(db, { clock: testClock, idGenerator: testIdGen });
}

const PAYLOAD = {
  name: "Card games",
  basePrompt: "You are a card-game experience author.",
  skillIds: ["experience-authoring"],
  toolSet: { edit_buffer: true, run_test: true },
  maxSteps: 20,
};

describe("CopilotProfileStore (CP-3)", () => {
  test("create + getById round-trip preserves all fields", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    expect(created.id).toMatch(/^cprof_test_\d+$/);
    expect(created.name).toBe("Card games");
    expect(created.basePrompt).toBe("You are a card-game experience author.");
    expect(created.skillIds).toEqual(["experience-authoring"]);
    expect(created.toolSet).toEqual({ edit_buffer: true, run_test: true });
    expect(created.maxSteps).toBe(20);

    const fetched = await store.getById(created.id);
    expect(fetched).toEqual(created);
  });

  test("list returns all created profiles", async () => {
    const store = await mkStore();
    await store.create({ ...PAYLOAD, name: "A" });
    await store.create({ ...PAYLOAD, name: "B" });
    const all = await store.list();
    expect(all.length).toBe(2);
    expect(all.map((p) => p.name).sort()).toEqual(["A", "B"]);
  });

  test("update merges a partial (single field) and bumps updatedAt", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, { maxSteps: 9 });
    expect(updated.maxSteps).toBe(9);
    expect(updated.name).toBe("Card games"); // untouched
    expect(updated.basePrompt).toBe(PAYLOAD.basePrompt); // untouched
  });

  test("update with a full payload replaces every field", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, {
      name: "Renamed",
      basePrompt: "new prompt",
      skillIds: ["another-skill"],
      toolSet: { run_simulate: true },
      maxSteps: 7,
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.basePrompt).toBe("new prompt");
    expect(updated.skillIds).toEqual(["another-skill"]);
    expect(updated.toolSet).toEqual({ run_simulate: true });
    expect(updated.maxSteps).toBe(7);
  });

  test("update throws when the id does not exist", async () => {
    const store = await mkStore();
    await expect(store.update("cprof_missing", { maxSteps: 1 })).rejects.toThrow();
  });

  test("delete removes the profile and is idempotent", async () => {
    const store = await mkStore();
    const created = await store.create(PAYLOAD);
    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
    // Deleting again does not throw (idempotent).
    await store.delete(created.id);
  });

  test("getById returns null for a missing id", async () => {
    const store = await mkStore();
    expect(await store.getById("cprof_missing")).toBeNull();
  });
});
