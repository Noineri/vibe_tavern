import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import type { CreateLoreEntryData, LoreEntry } from "../src/stores/lorebook-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { sql } from "drizzle-orm";

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

describe("LorebookStore.applyCoauthorLoreDraft (CTX-L2)", () => {
  /** Store with a real character 'char_1' so the characterId FK is satisfied. */
  async function mkStoreWithChar(): Promise<LorebookStore> {
    const dir = await mkdtemp(join(tmpdir(), "vt-lore-apply-test-"));
    const db = await createDb(join(dir, "test.db"));
    const store = new LorebookStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
    await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'C', '2026-01-01', '2026-01-01')`);
    return store;
  }

  /** A minimal character-scoped bundle: one book + one entry under it. */
  function sampleBundle() {
    return {
      lorebooks: [
        { id: "lorebook_draft1", name: "World Lore", description: "d", scopeType: "character" as const, enabled: true },
      ],
      entries: [
        { id: "lore_entry_draft1", lorebookId: "lorebook_draft1", title: "Castle", content: "Anvil keep.", keys: ["anvil"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
      ],
    };
  }

  test("before Apply the lorebook/entry tables are empty (Cancel leaves no rows)", async () => {
    const store = await mkStoreWithChar();
    expect(await store.listAllLorebooks()).toEqual([]);
    expect(await store.getLorebook("lorebook_draft1")).toBeNull();
    expect(await store.getEntry("lore_entry_draft1")).toBeNull();
  });

  test("Apply commits the accepted graph once with the preallocated ids", async () => {
    const store = await mkStoreWithChar();
    const res = await store.applyCoauthorLoreDraft("char_1", sampleBundle());
    expect(res).toEqual({ lorebookIds: ["lorebook_draft1"], entryIds: ["lore_entry_draft1"] });

    const lb = await store.getLorebook("lorebook_draft1");
    expect(lb).not.toBeNull();
    expect(lb!.name).toBe("World Lore");
    // Character-scoped draft book is written with characterId (activation engine FK ∪ junction).
    expect(lb!.characterId).toBe("char_1");

    const entry = await store.getEntry("lore_entry_draft1");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Castle");
    expect(entry!.content).toBe("Anvil keep.");
    expect(await store.listEntries("lorebook_draft1")).toHaveLength(1);
  });

  test("repeated Apply is idempotent — same ids upsert, no duplicate rows", async () => {
    const store = await mkStoreWithChar();
    await store.applyCoauthorLoreDraft("char_1", sampleBundle());
    // Apply the SAME bundle again (re-Apply scenario).
    await store.applyCoauthorLoreDraft("char_1", sampleBundle());

    expect(await store.listAllLorebooks()).toHaveLength(1);
    expect(await store.listEntries("lorebook_draft1")).toHaveLength(1);
    // An updated field on re-Apply is written (upsert), not a new row.
    const updated = {
      ...sampleBundle(),
      lorebooks: [{ id: "lorebook_draft1", name: "World Lore v2", description: "d", scopeType: "character" as const, enabled: true }],
    };
    await store.applyCoauthorLoreDraft("char_1", updated);
    const lb = await store.getLorebook("lorebook_draft1");
    expect(lb!.name).toBe("World Lore v2");
    expect(await store.listAllLorebooks()).toHaveLength(1);
  });

  test("dependency validation: an orphan entry rejects the WHOLE bundle atomically (no partial write)", async () => {
    const store = await mkStoreWithChar();
    const bad = {
      lorebooks: [
        // A valid book alongside the orphan entry — it must NOT be persisted
        // either; the bundle is rejected as a whole, not partially applied.
        { id: "lb_valid", name: "Valid", description: "", scopeType: "character" as const, enabled: true },
      ],
      entries: [
        { id: "lore_entry_orphan", lorebookId: "ghost_book", title: "x", content: "y", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
      ],
    };
    await expect(store.applyCoauthorLoreDraft("char_1", bad)).rejects.toThrow(/unknown parent lorebook 'ghost_book'/);
    // Nothing was written — not even the valid book (atomic rejection).
    expect(await store.listAllLorebooks()).toEqual([]);
    expect(await store.getLorebook("lb_valid")).toBeNull();
    expect(await store.getEntry("lore_entry_orphan")).toBeNull();
  });

  test("multiple books + entries apply in one transaction and compose", async () => {
    const store = await mkStoreWithChar();
    const bundle = {
      lorebooks: [
        { id: "lb_a", name: "A", description: "", scopeType: "character" as const, enabled: true },
        { id: "lb_b", name: "B", description: "", scopeType: "character" as const, enabled: true },
      ],
      entries: [
        { id: "le_a1", lorebookId: "lb_a", title: "a1", content: "c", keys: ["k"], secondaryKeys: [], constant: true, position: "before_char", depth: 4, enabled: true },
        { id: "le_b1", lorebookId: "lb_b", title: "b1", content: "c", keys: [], secondaryKeys: [], constant: false, position: "at_depth", depth: 2, enabled: true },
      ],
    };
    await store.applyCoauthorLoreDraft("char_1", bundle);
    expect(await store.listAllLorebooks()).toHaveLength(2);
    expect(await store.listEntries("lb_a")).toHaveLength(1);
    expect(await store.listEntries("lb_b")).toHaveLength(1);
    expect((await store.getEntry("le_a1"))!.constant).toBe(true);
    expect((await store.getEntry("le_b1"))!.depth).toBe(2);
  });

  test("CE-A1: activation params (scanDepth/tokenBudget/recursiveScanning) are honored, not hardcoded", async () => {
    const store = await mkStoreWithChar();
    const bundle = {
      lorebooks: [
        { id: "lb_params", name: "Tuned", description: "", scopeType: "character" as const, enabled: true, scanDepth: 25, tokenBudget: 2048, recursiveScanning: true },
      ],
      entries: [],
    };
    await store.applyCoauthorLoreDraft("char_1", bundle);
    const lb = await store.getLorebook("lb_params");
    expect(lb!.scanDepth).toBe(25);
    expect(lb!.tokenBudget).toBe(2048);
    expect(lb!.recursiveScanning).toBe(true);
  });

  test("CE-A1: activation params fall back to LOREBOOK_DEFAULTS when the bundle omits them", async () => {
    const store = await mkStoreWithChar();
    await store.applyCoauthorLoreDraft("char_1", sampleBundle());
    const lb = await store.getLorebook("lorebook_draft1");
    expect(lb!.scanDepth).toBe(10);
    expect(lb!.tokenBudget).toBe(1000);
    expect(lb!.recursiveScanning).toBe(false);
  });

  test("CE-A1: a character-scoped lorebook is bound to its character via lorebook_links (no manual binding)", async () => {
    const store = await mkStoreWithChar();
    await store.applyCoauthorLoreDraft("char_1", sampleBundle());
    const links = await store.getLinks("lorebook_draft1");
    expect(links).toContainEqual({ lorebookId: "lorebook_draft1", targetType: "character", targetId: "char_1" });
    // Idempotent: re-Apply does not duplicate the link (composite PK).
    await store.applyCoauthorLoreDraft("char_1", sampleBundle());
    expect(await store.getLinks("lorebook_draft1")).toHaveLength(1);
  });

  test("CE-A1: a non-character-scoped lorebook does NOT get a character link", async () => {
    const store = await mkStoreWithChar();
    const bundle = {
      lorebooks: [
        { id: "lb_global", name: "Global", description: "", scopeType: "global" as const, enabled: true },
      ],
      entries: [],
    };
    await store.applyCoauthorLoreDraft("char_1", bundle);
    expect(await store.getLinks("lb_global")).toEqual([]);
  });

  test("CE-B2: an entry may reference a persisted parent lorebook NOT in the bundle (edit/add to an existing book)", async () => {
    const store = await mkStoreWithChar();
    // A pre-existing lorebook (created outside this draft) — the bundle will
    // reference it by id WITHOUT including the lorebook node.
    const persisted = await store.createLorebook({ name: "Existing Book", scopeType: "global" });
    const bundle = {
      lorebooks: [],
      entries: [
        { id: "le_added", lorebookId: persisted.id, title: "New entry", content: "c", keys: ["k"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
      ],
    };
    const res = await store.applyCoauthorLoreDraft("char_1", bundle);
    expect(res.entryIds).toEqual(["le_added"]);
    const entry = await store.getEntry("le_added");
    expect(entry).not.toBeNull();
    expect(entry!.lorebookId).toBe(persisted.id);
    expect(await store.listEntries(persisted.id)).toHaveLength(1);
  });

  test("CE-B2: an entry referencing a parent that is neither in the bundle nor in the DB is still rejected", async () => {
    const store = await mkStoreWithChar();
    const bad = {
      lorebooks: [],
      entries: [
        { id: "le_x", lorebookId: "totally_ghost", title: "t", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
      ],
    };
    await expect(store.applyCoauthorLoreDraft("char_1", bad)).rejects.toThrow(/unknown parent lorebook 'totally_ghost'/);
    expect(await store.getEntry("le_x")).toBeNull();
  });

  test("CE-B2: logic survives a re-Apply via the conflict-patch (was INSERT-only)", async () => {
    const store = await mkStoreWithChar();
    const bundle = (logic: string, editing = false) => ({
      lorebooks: [
        { id: "lb_logic", name: "L", description: "", scopeType: "character" as const, enabled: true, ...(editing ? { mode: "edit" as const } : {}) },
      ],
      entries: [
        { id: "le_logic", lorebookId: "lb_logic", title: "t", content: "c", keys: ["k"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, logic, enabled: true, ...(editing ? { mode: "edit" as const } : {}) },
      ],
    });
    // First Apply INSERTs with logic "and_all".
    await store.applyCoauthorLoreDraft("char_1", bundle("and_all"));
    expect((await store.getEntry("le_logic"))!.logic).toBe("and_all");
    // Re-Apply with a changed logic hits the conflict path — logic is now in
    // the patch set, so the change is written (pre-CE-B2 it was dropped).
    await store.applyCoauthorLoreDraft("char_1", bundle("not_any", true));
    expect((await store.getEntry("le_logic"))!.logic).toBe("not_any");
    // mode:"edit" is review metadata; the existing PK upsert updates the same
    // rows rather than inserting duplicates.
    expect(await store.listAllLorebooks()).toHaveLength(1);
    expect(await store.listEntries("lb_logic")).toHaveLength(1);
  });
});
