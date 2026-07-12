import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import type { CreateLoreEntryData, LoreEntry } from "../src/stores/lorebook-store.js";
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
});

// ─── Entry field-map characterization ──────────────────────────────────────────
// Safety net for the field-map consolidation: pins the ~33-field entry contract
// across all four mapping sites (createEntry `.values`, updateEntry patch,
// duplicateLorebook's LoreEntry→CreateLoreEntryData projection, mapEntryRow).
// The failure mode to prevent is the avatar `avatarFullExt` bug — a field
// silently dropped across one hand-maintained map. Every field below is set to
// a distinguishing non-default value so a drop/default is detectable.

const FULL_ENTRY: CreateLoreEntryData = {
  title: "Full Title",
  content: "Full content body",
  keys: ["alpha", "beta"],
  secondaryKeys: ["gamma"],
  logic: "not_all",
  position: "at_depth",
  depth: 9,
  priority: 42,
  stickyWindow: 3,
  cooldownWindow: 5,
  delayWindow: 2,
  constant: true,
  probability: 77,
  ignoreBudget: true,
  role: "assistant",
  groupName: "squad",
  groupWeight: 55,
  prioritizeInclusion: true,
  useGroupScoring: true,
  excludeRecursion: true,
  preventRecursion: true,
  delayUntilRecursion: true,
  recursionLevel: 4,
  scanDepthOverride: 9,
  caseSensitive: true,
  matchWholeWords: true,
  characterFilter: [{ id: null, name: "Alice" }, { id: "char_1", name: "Bob" }],
  characterFilterExclude: true,
  matchSources: ["title", "content"],
  enabled: false,
  sortOrder: 7,
  automationId: "auto-x",
  metadata: { custom: "val", nested: { n: 1 } },
};

/** Assert every field on `expected` (a CreateLoreEntryData subset) matches `entry`. */
function expectEntryFields(entry: LoreEntry, expected: CreateLoreEntryData): void {
  for (const key of Object.keys(expected) as Array<keyof CreateLoreEntryData>) {
    expect(entry[key]).toEqual(expected[key]);
  }
}

describe("LorebookStore entry field round-trip (characterization)", () => {
  test("createEntry → getEntry round-trips every field with distinguishing values", async () => {
    const store = await mkStore();
    const lb = await store.createLorebook({ name: "LB", scopeType: "global" });

    const created = await store.createEntry(lb.id, FULL_ENTRY);
    const read = await store.getEntry(created.id);

    expect(read).not.toBeNull();
    // `at_depth` is a canonical lorebook position: mapEntryRow's
    // normalizeImportedEntryPosition passes it through unchanged, so the
    // read-back equals the written value (chosen deliberately so this test
    // pins the raw field map, not the normalization post-process).
    expectEntryFields(read!, FULL_ENTRY);
  });

  test("createEntry applies documented defaults when fields are omitted", async () => {
    const store = await mkStore();
    const lb = await store.createLorebook({ name: "LB", scopeType: "global" });

    const created = await store.createEntry(lb.id, {
      title: "T",
      content: "C",
      keys: ["k"],
    });
    const read = await store.getEntry(created.id)!;

    // String/array defaults
    expect(read.title).toBe("T");
    expect(read.content).toBe("C");
    expect(read.secondaryKeys).toEqual([]);
    expect(read.role).toBe("system");
    expect(read.groupName).toBe("");
    expect(read.automationId).toBe("");
    expect(read.matchSources).toEqual([]);
    expect(read.characterFilter).toEqual([]);
    expect(read.metadata).toEqual({});
    // Numeric defaults
    expect(read.depth).toBe(4);
    expect(read.priority).toBe(100);
    expect(read.stickyWindow).toBe(0);
    expect(read.cooldownWindow).toBe(0);
    expect(read.delayWindow).toBe(0);
    expect(read.probability).toBe(100);
    expect(read.groupWeight).toBe(100);
    expect(read.recursionLevel).toBe(0);
    expect(read.sortOrder).toBe(0);
    // Boolean defaults (stored as 0/1)
    expect(read.constant).toBe(false);
    expect(read.ignoreBudget).toBe(false);
    expect(read.prioritizeInclusion).toBe(false);
    expect(read.useGroupScoring).toBe(false);
    expect(read.excludeRecursion).toBe(false);
    expect(read.preventRecursion).toBe(false);
    expect(read.delayUntilRecursion).toBe(false);
    expect(read.caseSensitive).toBe(false);
    expect(read.matchWholeWords).toBe(false);
    expect(read.characterFilterExclude).toBe(false);
    expect(read.enabled).toBe(true);
    // Nullable
    expect(read.scanDepthOverride).toBeNull();
    // logic default 'and_any'
    expect(read.logic).toBe("and_any");
    // position: createEntry writes 'in_prompt' when omitted; mapEntryRow's
    // normalizeImportedEntryPosition maps canonical prompt-layer positions to
    // lorebook-UI positions ('in_prompt' → 'after_char'). So the read-back
    // default is 'after_char'. Pinned so the field-map refactor keeps the
    // normalization as a mapEntryRow post-process.
    expect(read.position).toBe("after_char");
  });

  test("duplicateLorebook preserves every entry field (LoreEntry→CreateLoreEntryData projection)", async () => {
    // This is the avatar-bug parallel: if the projection drops a field,
    // duplicate silently loses it. Pins the 3rd mapping site.
    const store = await mkStore();
    const lb = await store.createLorebook({ name: "Original", scopeType: "global" });
    await store.createEntry(lb.id, FULL_ENTRY);

    const { lorebook: dup } = await store.duplicateLorebook(lb.id, { name: "Copy" });
    const dupEntries = await store.listEntries(dup.id);

    expect(dupEntries).toHaveLength(1);
    expectEntryFields(dupEntries[0], FULL_ENTRY);
  });

  test("updateEntry patches every field individually", async () => {
    // Pins the updateEntry map site — the existing update tests only cover
    // the LOREBOOK (not entry) update path.
    const store = await mkStore();
    const lb = await store.createLorebook({ name: "LB", scopeType: "global" });
    const created = await store.createEntry(lb.id, { title: "seed", content: "x", keys: ["k"] });

    await store.updateEntry(created.id, FULL_ENTRY);
    const read = await store.getEntry(created.id)!;

    expectEntryFields(read, FULL_ENTRY);
  });
});
