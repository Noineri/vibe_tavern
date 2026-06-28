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

describe("LorebookStore.listLorebooksLinkedToTarget", () => {
  test("returns only M:N-linked lorebooks for the target (links-only, excludes FK-owned)", async () => {
    const store = await mkStore();

    // A global lorebook linked to persona_active via lorebook_links.
    const linkedGlobal = await store.createLorebook({
      name: "Linked global lorebook",
      scopeType: "global",
    });
    // An unrelated global lorebook with no links — must not appear.
    const unrelated = await store.createLorebook({
      name: "Unrelated global lorebook",
      scopeType: "global",
    });
    // A lorebook linked to a different persona — must not appear.
    const linkedOther = await store.createLorebook({
      name: "Linked to other persona",
      scopeType: "global",
    });
    await store.setLinks(linkedGlobal.id, [
      { targetType: "persona", targetId: "persona_active" },
    ]);
    await store.setLinks(linkedOther.id, [
      { targetType: "persona", targetId: "persona_other" },
    ]);

    const result = await store.listLorebooksLinkedToTarget("persona", "persona_active");
    const ids = result.map((lb) => lb.id);
    expect(ids).toContain(linkedGlobal.id);
    expect(ids).not.toContain(unrelated.id);
    expect(ids).not.toContain(linkedOther.id);
  });

  test("returns empty array for a target with no links", async () => {
    const store = await mkStore();
    const result = await store.listLorebooksLinkedToTarget("character", "character_orphan");
    expect(result).toEqual([]);
  });

  test("distinguishes character links from persona links for the same lorebook", async () => {
    const store = await mkStore();
    const lb = await store.createLorebook({ name: "Dual-linked", scopeType: "global" });
    await store.setLinks(lb.id, [
      { targetType: "character", targetId: "char_x" },
      { targetType: "persona", targetId: "persona_y" },
    ]);

    const forChar = await store.listLorebooksLinkedToTarget("character", "char_x");
    expect(forChar.map((l) => l.id)).toContain(lb.id);
    const forPersona = await store.listLorebooksLinkedToTarget("persona", "persona_y");
    expect(forPersona.map((l) => l.id)).toContain(lb.id);
    // Cross-type leakage check: persona target must not pick up the character link.
    const forPersonaWrongChar = await store.listLorebooksLinkedToTarget("persona", "char_x");
    expect(forPersonaWrongChar.map((l) => l.id)).not.toContain(lb.id);
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

describe("LorebookStore entry group field naming", () => {
  // Characterization test for the `group` vs `groupName` field-naming bug.
  // The DB column is `group_name` (camelCase `groupName`), the Zod contract
  // and the frontend `LoreEntryRecord` type both use `groupName`, but the
  // store return type + mapEntryRow historically aliased it to `group`. The
  // GET /entries route returned the store object as-is, so the frontend
  // reading `entry.groupName` got `undefined` — the group silently vanished
  // on every reload. This test pins the canonical name `groupName` on the
  // store output so the API boundary matches the contract.
  test("listEntries returns the group under `groupName`, not the `group` alias", async () => {
    const store = await mkStore();
    const lb = await store.createLorebook({ name: "LB", scopeType: "global" });

    await store.createEntry(lb.id, {
      title: "Grouped entry",
      content: "weather rain",
      keys: ["rain"],
      groupName: "weather",
    });

    const entries = await store.listEntries(lb.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].groupName).toBe("weather");
    // The legacy `group` alias must NOT be present on the store output —
    // callers (frontend, Zod contract) read `groupName` exclusively.
    expect("group" in entries[0]).toBe(false);
  });

  test("exportToStFormat emits the SillyTavern `group` JSON key (format contract)", async () => {
    // The ST JSON card format uses `group` as its key name — this is an
    // EXTERNAL serialization contract and must not be renamed when the
    // internal field is fixed. Export maps our `groupName` value onto the
    // ST `group` key.
    const store = await mkStore();
    const lb = await store.createLorebook({ name: "LB", scopeType: "global" });

    await store.createEntry(lb.id, {
      title: "Grouped entry",
      content: "weather rain",
      keys: ["rain"],
      groupName: "weather",
    });

    const exported = await store.exportToStFormat(lb.id);
    const entries = exported.entries as Record<string, { group?: string }>;
    const firstEntry = entries["0"];
    expect(firstEntry.group).toBe("weather");
  });
});
