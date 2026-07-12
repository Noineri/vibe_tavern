import { describe, expect, test } from "bun:test";
import { exportLorebookToSt, importStLorebookJson } from "../src/lorebooks/st-lorebook.js";

// Pull the param types off the function signature — the read-contract interfaces
// are internal, so the tests stay decoupled from their names.
type ExportLorebook = Parameters<typeof exportLorebookToSt>[0];
type ExportEntry = Parameters<typeof exportLorebookToSt>[1][number];

function baseLorebook(overrides: Partial<ExportLorebook> = {}): ExportLorebook {
  return {
    name: "LB",
    description: "",
    scanDepth: 10,
    tokenBudget: 1000,
    tokenBudgetPercent: null,
    recursiveScanning: false,
    maxRecursionSteps: 5,
    extensions: {},
    ...overrides,
  };
}

function baseEntry(overrides: Partial<ExportEntry> = {}): ExportEntry {
  return {
    keys: [],
    secondaryKeys: [],
    title: "T",
    content: "C",
    constant: false,
    logic: "and_any",
    priority: 100,
    position: "after_char",
    depth: 4,
    enabled: true,
    stickyWindow: 0,
    cooldownWindow: 0,
    delayWindow: 0,
    probability: 100,
    role: "system",
    groupName: "",
    groupWeight: 100,
    scanDepthOverride: null,
    caseSensitive: false,
    matchWholeWords: false,
    characterFilter: [],
    characterFilterExclude: false,
    automationId: "",
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    metadata: {},
    ...overrides,
  };
}

describe("exportLorebookToSt (SillyTavern serializer)", () => {
  test("emits the SillyTavern `group` JSON key from `groupName` (format contract)", () => {
    // The ST card format uses `group` as its key name — an EXTERNAL contract
    // that must not be renamed when the internal field (`groupName`) is used.
    const exported = exportLorebookToSt(
      baseLorebook(),
      [baseEntry({ title: "Grouped entry", content: "weather rain", keys: ["rain"], groupName: "weather" })],
    );

    const firstEntry = (exported.entries as Record<string, { group?: string }>)["0"];
    expect(firstEntry.group).toBe("weather");
  });

  test("maps entry + lorebook fields to SillyTavern JSON keys", () => {
    const exported = exportLorebookToSt(
      baseLorebook({
        name: "Export LB", description: "desc", scanDepth: 33, tokenBudget: 500,
        recursiveScanning: true, maxRecursionSteps: 9,
      }),
      [baseEntry({
        title: "T", content: "C", keys: ["k"], secondaryKeys: ["s"], logic: "not_all",
        position: "at_depth", depth: 6, priority: 22, stickyWindow: 2, cooldownWindow: 4,
        delayWindow: 1, constant: true, probability: 50, enabled: false, role: "assistant",
        groupName: "g", groupWeight: 3, scanDepthOverride: 8, caseSensitive: true,
        matchWholeWords: true, excludeRecursion: true, preventRecursion: true,
        delayUntilRecursion: true,
        characterFilter: [{ name: "Alice" }], characterFilterExclude: true,
        automationId: "a1", metadata: { m: 1 },
      })],
    );

    // Lorebook-level keys
    expect(exported.name).toBe("Export LB");
    expect(exported.description).toBe("desc");
    expect(exported.scan_depth).toBe(33);
    expect(exported.token_budget).toBe(500);
    expect(exported.recursive_scanning).toBe(true);
    expect((exported.extensions as { max_recursion_steps?: number }).max_recursion_steps).toBe(9);

    const e = (exported.entries as Record<string, Record<string, unknown>>)["0"];
    // Entry-level keys + non-trivial transforms
    expect(e.key).toEqual(["k"]);
    expect(e.keysecondary).toEqual(["s"]);
    expect(e.comment).toBe("T");
    expect(e.content).toBe("C");
    expect(e.constant).toBe(true);
    expect(e.selective).toBe(true); // secondaryKeys.length > 0
    expect(e.selectiveLogic).toBe(1); // not_all → 1
    expect(e.order).toBe(22); // priority → order
    expect(e.position).toBe(4); // at_depth → 4
    expect(e.depth).toBe(6);
    expect(e.disable).toBe(true); // !enabled
    expect(e.sticky).toBe(2);
    expect(e.cooldown).toBe(4);
    expect(e.delay).toBe(1);
    expect(e.probability).toBe(50);
    expect(e.role).toBe("assistant");
    expect(e.group).toBe("g");
    expect(e.groupWeight).toBe(3);
    expect(e.scanDepth).toBe(8);
    expect(e.caseSensitive).toBe(true);
    expect(e.matchWholeWords).toBe(true);
    expect(e.character_filter).toEqual(["Alice"]); // name only, id stripped
    expect(e.character_filter_exclude).toBe(true);
    expect(e.automationId).toBe("a1");
    expect(e.excludeRecursion).toBe(true);
    expect(e.preventRecursion).toBe(true);
    expect(e.delayUntilRecursion).toBe(true);
    expect(e.metadata).toEqual({ m: 1 });
  });

  test("maps all 8 lorebook positions to SillyTavern numeric positions", () => {
    const positions: ReadonlyArray<readonly [string, number]> = [
      ["before_char", 0], ["after_char", 1], ["top_an", 2], ["bottom_an", 3],
      ["at_depth", 4], ["before_examples", 5], ["after_examples", 6], ["outlet", 7],
    ];
    const entries = positions.map(([pos]) => baseEntry({ position: pos, keys: [pos] }));

    const exported = exportLorebookToSt(baseLorebook(), entries);
    const stEntries = exported.entries as Record<string, Record<string, unknown>>;
    for (let i = 0; i < positions.length; i++) {
      expect(stEntries[String(i)].position).toBe(positions[i][1]);
    }
  });

  test("position table is bidirectional: import(st=N) → export → st=N (no import/export drift)", () => {
    // The whole point of colocating import + export on one shared
    // LORE_ENTRY_POSITION_TABLE: a position round-trips through both directions
    // unchanged. Previously the two maps lived in separate packages with no
    // compile link, so a 9th position could drift silently.
    for (let n = 0; n <= 7; n++) {
      const imported = importStLorebookJson({
        entries: { "0": { uid: 0, key: ["k"], content: "c", position: n } },
      });
      const exported = exportLorebookToSt(baseLorebook(), [baseEntry({ position: imported.entries[0].position })]);
      const stPosition = (exported.entries as Record<string, Record<string, unknown>>)["0"].position;
      expect(stPosition).toBe(n);
    }
  });
});
