import { describe, it, expect } from "bun:test";
import {
  importJanitorLorebookJson,
  isJanitorLorebookArray,
} from "../src/lorebooks/janitor-lorebook.js";

// A realistic Janitor AI entry (trimmed content), based on the
// "Legendary Heroes" lorebook export. Captures every Janitor-specific key.
function janitorEntry(overrides: Record<string, unknown> = {}) {
  return {
    activationMode: "standard",
    activationScript: "",
    case_sensitive: false,
    category: "general",
    comment: "",
    constant: false,
    content: "<Valerius>\nLord Valerius. SSR summon, race [higher vampire].\n</Valerius>",
    depth: 3,
    enabled: true,
    extensions: {},
    groupWeight: 100,
    id: "4acde6c6-f890-493f-ba49-ea098231771a",
    inclusionGroupRaw: "",
    insertion_order: 100,
    key: ["Valerius", "Lord Valerius"],
    keyMatchPriority: false,
    keysecondary: [],
    keysecondaryRaw: "",
    keysRaw: "Valerius, Lord Valerius",
    matchWholeWords: true,
    minMessages: 3,
    name: "Valerius",
    prioritizeInclusion: false,
    priority: 1,
    probability: 100,
    selectiveLogic: 0,
    tags: [],
    keywordsRaw: "Valerius, Lord Valerius",
    ...overrides,
  };
}

describe("importJanitorLorebookJson", () => {
  it("imports a bare array of entries (the canonical Janitor shape)", () => {
    const result = importJanitorLorebookJson([janitorEntry(), janitorEntry({ id: "b", name: "Malthus" })], {
      fallbackName: "Legendary Heroes",
    });
    expect(result.format).toBe("janitor_lorebook_json");
    expect(result.lorebook.name).toBe("Legendary Heroes");
    expect(result.entries).toHaveLength(2);
    // Name comes from the entry, not from `comment`.
    expect(result.entries[0].title).toBe("Valerius");
    expect(result.entries[1].title).toBe("Malthus");
    // Determinism: same input → same lorebook ID.
    const again = importJanitorLorebookJson([janitorEntry(), janitorEntry({ id: "b", name: "Malthus" })], {
      fallbackName: "Legendary Heroes",
    });
    expect(again.lorebook.id).toBe(result.lorebook.id);
    expect(again.entries[0].id).toBe(result.entries[0].id);
  });

  it("accepts a JSON string input", () => {
    const json = JSON.stringify([janitorEntry()]);
    const result = importJanitorLorebookJson(json, { fallbackName: "From String" });
    expect(result.entries).toHaveLength(1);
    expect(result.lorebook.name).toBe("From String");
  });

  it("throws on a non-array input (ST shape should go through the ST importer)", () => {
    expect(() => importJanitorLorebookJson({ entries: [] })).toThrow(/top-level JSON array/);
  });

  it("maps Janitor field names to LoreEntry fields", () => {
    const result = importJanitorLorebookJson(
      [
        janitorEntry({
          case_sensitive: true,
          matchWholeWords: true,
          constant: true,
          probability: 75,
          groupWeight: 50,
          prioritizeInclusion: true,
          enabled: false,
          depth: 7,
        }),
      ],
      { fallbackName: "Mapping Test" },
    );
    const entry = result.entries[0];
    expect(entry.caseSensitive).toBe(true);
    expect(entry.matchWholeWords).toBe(true);
    expect(entry.constant).toBe(true);
    expect(entry.probability).toBe(75);
    expect(entry.groupWeight).toBe(50);
    expect(entry.prioritizeInclusion).toBe(true);
    expect(entry.enabled).toBe(false);
    expect(entry.depth).toBe(7);
    // Janitor-derived defaults that Janitor does not expose.
    expect(entry.role).toBe("system");
    expect(entry.position).toBe("in_prompt");
    expect(entry.ignoreBudget).toBe(false);
    expect(entry.stickyWindow).toBe(0);
    expect(entry.triggers).toEqual([]);
    expect(entry.matchSources).toEqual([]);
    expect(entry.characterFilter).toEqual([]);
    expect(entry.scanDepthOverride).toBeNull();
  });

  it("maps inclusionGroupRaw → groupName (Janitor's name for ST's group)", () => {
    const result = importJanitorLorebookJson(
      [janitorEntry({ inclusionGroupRaw: "weather, mood" })],
      { fallbackName: "Groups" },
    );
    expect(result.entries[0].groupName).toBe("weather, mood");
  });

  it("maps selectiveLogic 0-3 to LoreLogic (only when secondary keys exist)", () => {
    const cases: Array<[number, string]> = [
      [0, "and_any"],
      [1, "not_all"],
      [2, "not_any"],
      [3, "and_all"],
    ];
    for (const [logic, expected] of cases) {
      const result = importJanitorLorebookJson(
        [janitorEntry({ keysecondary: ["b"], selectiveLogic: logic })],
        { fallbackName: `Logic ${logic}` },
      );
      expect(result.entries[0].logic).toBe(expected);
    }
  });

  it("defaults logic to and_any when there are no secondary keys (ignores selectiveLogic)", () => {
    const result = importJanitorLorebookJson(
      [janitorEntry({ keysecondary: [], selectiveLogic: 3 })],
      { fallbackName: "No Sec" },
    );
    expect(result.entries[0].logic).toBe("and_any");
  });

  it("uses insertion_order for sortOrder and priority for priority", () => {
    const result = importJanitorLorebookJson(
      [janitorEntry({ insertion_order: 500, priority: 3 })],
      { fallbackName: "Order" },
    );
    expect(result.entries[0].sortOrder).toBe(500);
    expect(result.entries[0].priority).toBe(3);
  });

  it("falls back to insertion_order when priority is missing", () => {
    const { priority, ...withoutPriority } = janitorEntry({ insertion_order: 500 });
    void priority;
    const result = importJanitorLorebookJson([withoutPriority], { fallbackName: "FB" });
    expect(result.entries[0].priority).toBe(500);
  });

  it("warns on empty content and on keyless non-constant entries", () => {
    const result = importJanitorLorebookJson(
      [
        janitorEntry({ id: "empty", name: "Empty", content: "", key: [] }),
        janitorEntry({ id: "const-ok", name: "Const", content: "x", key: [], constant: true }),
      ],
      { fallbackName: "Warns" },
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/empty content/i),
        // "Empty" has no keys and is not constant → never-activates warning.
        expect.stringMatching(/never activate/i),
      ]),
    );
    // "Const" has no keys but IS constant → no warning for it.
    expect(result.warnings.some((w) => w.includes("Const"))).toBe(false);
  });

  it("stores Janitor-specific metadata for traceability", () => {
    const result = importJanitorLorebookJson(
      [janitorEntry({ category: "villain", tags: ["boss", "undead"], minMessages: 5 })],
      { fallbackName: "Meta" },
    );
    const meta = result.entries[0].metadata;
    expect(meta.source).toBe("janitor");
    expect(meta.janitorCategory).toBe("villain");
    expect(meta.janitorTags).toEqual(["boss", "undead"]);
    expect(meta.janitorMinMessages).toBe(5);
  });

  it("defaults lorebook name when no fallbackName is given", () => {
    const result = importJanitorLorebookJson([janitorEntry()]);
    expect(result.lorebook.name).toBe("Imported Lorebook");
  });

  it("falls back to `comment` then `Entry N` when name is empty", () => {
    const result = importJanitorLorebookJson(
      [
        janitorEntry({ id: "0", name: "", comment: "From Comment" }),
        janitorEntry({ id: "1", name: "", comment: "" }),
      ],
      { fallbackName: "Titles" },
    );
    expect(result.entries[0].title).toBe("From Comment");
    expect(result.entries[1].title).toBe("Entry 1");
  });
});

describe("isJanitorLorebookArray", () => {
  it("returns true for a bare array with a Janitor-looking entry", () => {
    expect(isJanitorLorebookArray([janitorEntry()])).toBe(true);
  });

  it("returns false for ST shape (object with entries)", () => {
    expect(isJanitorLorebookArray({ entries: [] })).toBe(false);
  });

  it("returns false for empty arrays and non-arrays", () => {
    expect(isJanitorLorebookArray([])).toBe(false);
    expect(isJanitorLorebookArray(null)).toBe(false);
    expect(isJanitorLorebookArray(["just a string"])).toBe(false);
  });

  it("returns false for an array of records lacking Janitor-specific keys", () => {
    // An array of generic objects with content but no Janitor signature →
    // do not false-positive; route to the ST importer instead.
    expect(isJanitorLorebookArray([{ content: "hello" }])).toBe(false);
  });
});
