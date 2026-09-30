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
    tokenBudgetCap: 0,
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
    minChatMessages: 0,
    probability: 100,
    ignoreBudget: false,
    role: "system",
    groupName: "",
    groupWeight: 100,
    prioritizeInclusion: false,
    useGroupScoring: null,
    scanDepthOverride: null,
    caseSensitive: false,
    matchWholeWords: false,
    characterFilter: [],
    characterFilterExclude: false,
    matchSources: [],
    automationId: "",
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    recursionLevel: 0,
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
        minChatMessages: 1, constant: true, probability: 50, enabled: false, role: "assistant",
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
    expect(e.role).toBe(2);
    expect(e.group).toBe("g");
    expect(e.groupWeight).toBe(3);
    expect(e.scanDepth).toBe(8);
    expect(e.caseSensitive).toBe(true);
    expect(e.matchWholeWords).toBe(true);
    expect(e.characterFilter).toEqual({ isExclude: true, names: ["Alice"], tags: [] });
    expect(e.automationId).toBe("a1");
    expect(e.excludeRecursion).toBe(true);
    expect(e.preventRecursion).toBe(true);
    expect(e.delayUntilRecursion).toBe(true);
    expect(e.metadata).toBeUndefined();
  });

  test("emits token_budget_cap (N5) — 0 default and an explicit cap both round the book's budget model", () => {
    const noCap = exportLorebookToSt(baseLorebook(), [baseEntry({ title: "A", keys: ["a"] })]);
    expect(noCap.token_budget_cap).toBe(0);
    const capped = exportLorebookToSt(
      baseLorebook({ tokenBudgetPercent: 5, tokenBudgetCap: 250 }),
      [baseEntry({ title: "A", keys: ["a"] })],
    );
    expect(capped.token_budget_percent).toBe(5);
    expect(capped.token_budget_cap).toBe(250);
  });

  test("round-trips case forms as a compiled ST regex while retaining the plain key", () => {
    const exported = exportLorebookToSt(
      baseLorebook(),
      [baseEntry({ keys: ["дракон"], metadata: { caseFormsKeys: ["дракон"] } })],
    );
    const exportedKey = (exported.entries as Record<string, { key: string[] }>)["0"].key[0];
    expect(exportedKey).toMatch(/^\/\(\?<!\\p\{L\}\).*\/iu$/);

    const reimported = importStLorebookJson(exported);
    expect(reimported.entries[0].keys).toEqual(["дракон"]);
    expect(reimported.entries[0].metadata.caseFormsKeys).toEqual(["дракон"]);
  });

  test("round-trips caseSensitive / matchWholeWords tri-state — null exports as null, never false (D2)", () => {
    // ST's template defines these as nullable booleans (world-info.js:4035-4036), so null must remain inherit on re-import.
    const exported = exportLorebookToSt(
      baseLorebook(),
      [
        baseEntry({ title: "Inherit", keys: ["a"], caseSensitive: null, matchWholeWords: null }),
        baseEntry({ title: "Off", keys: ["b"], caseSensitive: false, matchWholeWords: false }),
        baseEntry({ title: "On", keys: ["c"], caseSensitive: true, matchWholeWords: true }),
      ],
    );
    const entries = exported.entries as Record<string, Record<string, unknown>>;
    expect(entries["0"].caseSensitive).toBeNull();
    expect(entries["0"].matchWholeWords).toBeNull();
    expect(entries["1"].caseSensitive).toBe(false);
    expect(entries["1"].matchWholeWords).toBe(false);
    expect(entries["2"].caseSensitive).toBe(true);
    expect(entries["2"].matchWholeWords).toBe(true);

    const reimported = importStLorebookJson(exported);
    expect(reimported.entries.map((entry) => [entry.caseSensitive, entry.matchWholeWords])).toEqual([
      [null, null],
      [false, false],
      [true, true],
    ]);
  });

  test("emits ST-native step-22 fields and re-imports their values", () => {
    // ST's entry template defines the native field names and shapes (world-info.js:4003-4044); export must serialize that surface, not VT aliases.
    const exported = exportLorebookToSt(
      baseLorebook(),
      [baseEntry({
        keys: ["primary"],
        secondaryKeys: ["secondary"],
        logic: "not_any",
        position: "outlet",
        minChatMessages: 7,
        probability: 100,
        ignoreBudget: true,
        role: "assistant",
        groupName: "included",
        groupWeight: 25,
        prioritizeInclusion: true,
        useGroupScoring: true,
        caseSensitive: null,
        matchWholeWords: null,
        characterFilter: [{ name: "Alice" }, { name: "ghost.png" }],
        characterFilterExclude: true,
        matchSources: [
          "persona_desc",
          "character_desc",
          "character_personality",
          "character_note",
          "scenario",
          "creator_notes",
        ],
        delayUntilRecursion: true,
        recursionLevel: 3,
        metadata: {
          stUid: 42,
          stUseProbability: false,
          stAddMemo: true,
          stOutletName: "memory",
          stCharacterFilterNames: ["alice.png", "ghost.png"],
          stCharacterFilterTags: ["tag-id"],
        },
      })],
    );

    const stEntry = (exported.entries as Record<string, Record<string, unknown>>)["0"];
    expect(stEntry.uid).toBe(42);
    expect(stEntry.role).toBe(2);
    expect(stEntry.characterFilter).toEqual({ isExclude: true, names: ["alice.png", "ghost.png"], tags: ["tag-id"] });
    expect(stEntry.ignoreBudget).toBe(true);
    expect(stEntry.groupOverride).toBe(true);
    expect(stEntry.useGroupScoring).toBe(true);
    expect(stEntry.useProbability).toBe(false);
    expect(stEntry.addMemo).toBe(true);
    expect(stEntry.outletName).toBe("memory");
    expect(stEntry.delay).toBe(7);
    expect(stEntry.delayUntilRecursion).toBe(3);
    expect(stEntry.selective).toBe(true);
    expect(stEntry.selectiveLogic).toBe(2);
    expect(stEntry.matchPersonaDescription).toBe(true);
    expect(stEntry.matchCharacterDescription).toBe(true);
    expect(stEntry.matchCharacterPersonality).toBe(true);
    expect(stEntry.matchCharacterDepthPrompt).toBe(true);
    expect(stEntry.matchScenario).toBe(true);
    expect(stEntry.matchCreatorNotes).toBe(true);
    expect(stEntry.metadata).toBeUndefined();
    expect(stEntry.character_filter).toBeUndefined();

    const reimported = importStLorebookJson(exported);
    const entry = reimported.entries[0];
    expect(entry.role).toBe("assistant");
    expect(entry.characterFilter).toEqual([{ id: null, name: "alice.png" }, { id: null, name: "ghost.png" }]);
    expect(entry.characterFilterExclude).toBe(true);
    expect(entry.matchSources).toEqual([
      "persona_desc",
      "character_desc",
      "character_personality",
      "character_note",
      "scenario",
      "creator_notes",
    ]);
    expect(entry.ignoreBudget).toBe(true);
    expect(entry.prioritizeInclusion).toBe(true);
    expect(entry.useGroupScoring).toBe(true);
    expect(entry.probability).toBe(100);
    expect(entry.minChatMessages).toBe(7);
    expect(entry.delayUntilRecursion).toBe(true);
    expect(entry.recursionLevel).toBe(3);
    expect(entry.logic).toBe("not_any");
    expect(entry.metadata.stUid).toBe(42);
    expect(entry.metadata.stUseProbability).toBe(false);
    expect(entry.metadata.stAddMemo).toBe(true);
    expect(entry.metadata.stOutletName).toBe("memory");
    expect(reimported.warnings).toEqual(["Lore entry 42 has character-filter tags that Vibe Tavern cannot import."]);

    const resolved = importStLorebookJson(exported, {
      characterFilterAvatarResolver: (avatarFilename) => avatarFilename === "alice.png"
        ? { id: "character-1", name: "Alice" }
        : null,
    });
    const resolvedReexport = exportLorebookToSt(baseLorebook(), resolved.entries);
    const resolvedStEntry = (resolvedReexport.entries as Record<string, Record<string, unknown>>)["0"];
    // ST filters use avatar filenames, while VT resolves them to display names; metadata preserves the ST source filename.
    expect(resolvedStEntry.characterFilter).toEqual({ isExclude: true, names: ["alice.png", "ghost.png"], tags: ["tag-id"] });
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
