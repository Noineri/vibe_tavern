import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Tri-state caseSensitive / matchWholeWords (ST parity, D2).
 *
 * ST stores per-entry `caseSensitive` / `matchWholeWords` as null (inherit
 * the GLOBAL client setting, world-info.js:269/347) or an explicit boolean.
 * VT has no global client setting — the inherit target is the BOOK-level
 * default (`lorebooks.caseSensitive` / `.matchWholeWords`), exactly like
 * useGroupScoring (LG-2/LG-4). Effective flag: entry ?? book ?? false.
 *
 * See LOREBOOK_ST_PARITY_RESWEEP_2026-09 (D2); the importer previously
 * hardcoded false/false, permanently pinning imported entries against the
 * book default.
 */

function makeEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    content: `content of ${id}`,
    keys: [] as string[],
    secondaryKeys: [] as string[],
    logic: "and_any",
    position: "before_char",
    depth: 0,
    priority: 100,
    stickyWindow: 0,
    cooldownWindow: 0,
    minChatMessages: 0,
    constant: false,
    probability: 100,
    ignoreBudget: false,
    role: "system",
    groupName: "",
    groupWeight: 0,
    prioritizeInclusion: false,
    useGroupScoring: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    recursionLevel: 0,
    scanDepthOverride: null,
    caseSensitive: null,
    matchWholeWords: null,
    characterFilter: [] as Array<{ id: string | null; name: string }>,
    characterFilterExclude: false,
    matchSources: [] as string[],
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

function makeInput(
  entries: ReturnType<typeof makeEntry>[],
  opts: {
    book?: Record<string, unknown>;
    text?: string;
  } & Partial<ActivationInput> = {},
): ActivationInput {
  return {
    lorebooks: [
      {
        id: "lb_test",
        scanDepth: 1,
        tokenBudget: 100_000,
        tokenBudgetPercent: null,
        recursiveScanning: false,
        maxRecursionSteps: 0,
        includeNames: false,
        minActivations: 0,
        minActivationsDepthMax: 0,
        entries,
        ...opts.book,
      },
    ],
    messages: opts.text === undefined ? [] : [{ role: "user", content: opts.text }],
    macroMap: {},
    characterId: "c_test",
    characterName: "Test",
    activationState: {},
    currentTurn: 1,
    ...opts,
  };
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
  return result.activatedEntries.map((e) => e.id);
}

describe("lore activation engine — tri-state caseSensitive / matchWholeWords (D2)", () => {
  it("null inherits the book caseSensitive=true — keys stop matching across letter case", () => {
    const entry = makeEntry("cs_inherit", { keys: ["rose"] });
    const book = { caseSensitive: true };
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "a Rose blooms" })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "a rose blooms" })))).toEqual(["cs_inherit"]);
  });

  it("null with no book default resolves false — case-insensitive (pinned default behavior)", () => {
    const entry = makeEntry("cs_default", { keys: ["rose"] });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "a Rose blooms" })))).toEqual(["cs_default"]);
  });

  it("an explicit per-entry flag overrides the book default in both directions", () => {
    // Entry true beats book false.
    const explicitOn = makeEntry("cs_on", { keys: ["rose"], caseSensitive: true });
    expect(activatedIds(resolveActivatedEntries(makeInput([explicitOn], { text: "a Rose blooms" })))).toEqual([]);
    // Entry false beats book true.
    const explicitOff = makeEntry("cs_off", { keys: ["rose"], caseSensitive: false });
    expect(
      activatedIds(resolveActivatedEntries(makeInput([explicitOff], { book: { caseSensitive: true }, text: "a Rose blooms" }))),
    ).toEqual(["cs_off"]);
  });

  it("null inherits the book matchWholeWords=true — substring hits stop matching", () => {
    const entry = makeEntry("ww_inherit", { keys: ["king"] });
    const book = { matchWholeWords: true };
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "he was liking it" })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "the king arrives" })))).toEqual(["ww_inherit"]);
  });

  it("null with no book default resolves false — substring matching (pinned default behavior)", () => {
    const entry = makeEntry("ww_default", { keys: ["king"] });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "he was liking it" })))).toEqual(["ww_default"]);
  });

  it("the two flags resolve independently — a case override does not drag the whole-words default", () => {
    // caseSensitive explicitly off, matchWholeWords null + book true.
    const entry = makeEntry("mixed", { keys: ["King"], caseSensitive: false });
    const book = { caseSensitive: true, matchWholeWords: true };
    // Case-insensitive so "King" matches "king", but whole-words blocks "liking".
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "he was liking it" })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "the king arrives" })))).toEqual(["mixed"]);
  });

  it("resolution applies to secondary keys as well as primary", () => {
    // and_any + secondary key, book caseSensitive=true: a cased miss on the
    // secondary key must not activate.
    const entry = makeEntry("sec_inherit", { keys: ["primary"], secondaryKeys: ["rose"], logic: "and_any" });
    const book = { caseSensitive: true };
    expect(
      activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "primary and a Rose blooms" }))),
    ).toEqual([]);
    expect(
      activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "primary and a rose blooms" }))),
    ).toEqual(["sec_inherit"]);
  });
});
