import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import { CopilotProfileStore } from "../src/stores/copilot-profile-store.js";
import { copilotProfiles } from "../src/db-schema.js";
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

async function mkStore(): Promise<{ store: CopilotProfileStore; db: AppDb }> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
  const db = await createDb(join(dir, "test.db"));
  return { store: new CopilotProfileStore(db, { clock: testClock, idGenerator: testIdGen }), db };
}

// PM-8 (owner ruling 2026-10-12): the skill catalog is ungated — skillIds is
// retired from the store surface; the legacy `skill_ids_json` column stays in
// the schema (never migrated away) and is simply never read or written.
const PAYLOAD = {
  name: "Card games",
  basePrompt: "You are a card-game experience author.",
  toolSet: { edit_buffer: true, run_test: true },
};

describe("CopilotProfileStore (CP-3)", () => {
  test("create + getById round-trip preserves all fields (no skillIds — PM-8)", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    expect(created.id).toMatch(/^cprof_test_\d+$/);
    expect(created.name).toBe("Card games");
    expect(created.basePrompt).toBe("You are a card-game experience author.");
    expect(created).not.toHaveProperty("skillIds");
    expect(created.toolSet).toEqual({ edit_buffer: true, run_test: true });

    const fetched = await store.getById(created.id);
    expect(fetched).toEqual(created);
  });

  test("list returns all created profiles", async () => {
    const { store } = await mkStore();
    await store.create({ ...PAYLOAD, name: "A" });
    await store.create({ ...PAYLOAD, name: "B" });
    const all = await store.list();
    expect(all.length).toBe(2);
    expect(all.map((p) => p.name).sort()).toEqual(["A", "B"]);
  });

  test("update merges a partial (single field) and bumps updatedAt", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, { name: "Renamed only" });
    expect(updated.name).toBe("Renamed only");
    expect(created.basePrompt).toBe(PAYLOAD.basePrompt); // untouched
  });

  test("update with a full payload replaces every field", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, {
      name: "Renamed",
      basePrompt: "new prompt",
      toolSet: { run_simulate: true },
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.basePrompt).toBe("new prompt");
    expect(updated.toolSet).toEqual({ run_simulate: true });
  });

  test("a legacy skill_ids_json row is ignored gracefully (PM-8)", async () => {
    // Rows written before PM-8 carry real data in skill_ids_json. The store
    // never reads the column: such a row must still load fine (its legacy
    // payload ignored), and an update must not clobber it either.
    const { store, db } = await mkStore();
    const created = await store.create(PAYLOAD);
    await db
      .update(copilotProfiles)
      .set({ skillIdsJson: '["legacy-skill"]' })
      .where(eq(copilotProfiles.id, created.id))
      .run();

    const fetched = await store.getById(created.id);
    expect(fetched?.name).toBe("Card games");
    expect(fetched).not.toHaveProperty("skillIds");

    const updated = await store.update(created.id, { name: "Still legacy" });
    expect(updated?.name).toBe("Still legacy");
    const raw = await db
      .select({ skillIdsJson: copilotProfiles.skillIdsJson })
      .from(copilotProfiles)
      .where(eq(copilotProfiles.id, created.id))
      .get();
    expect(raw?.skillIdsJson).toBe('["legacy-skill"]'); // untouched by the store
  });

  test("update throws when the id does not exist", async () => {
    const { store } = await mkStore();
    await expect(store.update("cprof_missing", { name: "X" })).rejects.toThrow();
  });

  test("delete removes the profile and is idempotent", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
    // Deleting again does not throw (idempotent).
    await store.delete(created.id);
  });

  test("getById returns null for a missing id", async () => {
    const { store } = await mkStore();
    expect(await store.getById("cprof_missing")).toBeNull();
  });
});
