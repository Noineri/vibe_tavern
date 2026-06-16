import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
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

async function mkStore(): Promise<LorebookStore> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
  const db = await createDb(join(dir, "test.db"));
  return new LorebookStore(db, {
    clock: testClock,
    idGenerator: testIdGen,
    content: null,
  });
}

describe("LorebookStore.listLorebooksByScope", () => {
  test("includes lorebooks linked to a persona via lorebook_links", async () => {
    const store = await mkStore();

    const linked = await store.createLorebook({
      name: "Persona-linked lorebook",
      scopeType: "global",
    });
    const unrelated = await store.createLorebook({
      name: "Unrelated lorebook",
      scopeType: "global",
    });

    await store.setLinks(linked.id, [
      { targetType: "persona", targetId: "persona_active" },
    ]);

    const activePersonaLorebooks = await store.listLorebooksByScope("persona", "persona_active");
    expect(activePersonaLorebooks.map((lb) => lb.id)).toContain(linked.id);
    expect(activePersonaLorebooks.map((lb) => lb.id)).not.toContain(unrelated.id);

    const otherPersonaLorebooks = await store.listLorebooksByScope("persona", "persona_other");
    expect(otherPersonaLorebooks.map((lb) => lb.id)).not.toContain(linked.id);
  });
});

describe("LorebookStore.updateLorebook", () => {
  test("persists name and description changes", async () => {
    const store = await mkStore();
    const created = await store.createLorebook({
      name: "Original name",
      description: "Original description",
      scopeType: "global",
    });

    await store.updateLorebook(created.id, {
      name: "Renamed",
      description: "New description",
    });

    const updated = await store.getLorebook(created.id);
    expect(updated?.name).toBe("Renamed");
    expect(updated?.description).toBe("New description");
  });

  test("does not drop other fields when only name changes", async () => {
    const store = await mkStore();
    const created = await store.createLorebook({
      name: "Original",
      description: "Keep me",
      scopeType: "global",
      scanDepth: 30,
    });

    await store.updateLorebook(created.id, { name: "Renamed" });

    const updated = await store.getLorebook(created.id);
    expect(updated?.name).toBe("Renamed");
    expect(updated?.description).toBe("Keep me");
    expect(updated?.scanDepth).toBe(30);
  });
});
