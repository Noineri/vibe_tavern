import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Whole-word dialect = ST's `(?:^|\W)(key)(?:$|\W)` (resweep N4, P5).
 *
 * ST world-info.js 345-366: with whole words ON, a SINGLE-word key is matched
 * with punctuation-inclusive boundaries `(?:^|\W)(key)(?:$|\W)` (no flags —
 * case handling comes from #transformString; VT's i flag is the equivalent
 * surface), and a MULTI-word key degrades to a plain substring
 * (`haystack.includes(key)`). JS `\W` is ASCII-defined, so Cyrillic letters
 * ARE `\W`: a Russian key matches across spaces/punctuation AND over-matches
 * inside longer word forms («мегадракон») — exactly ST, which makes the
 * toggle close to a substring match for Russian. Owner ruling 2026-09-29
 * (P5): imported books must behave 1:1, the Russian case-forms adaptation is
 * a separate opt-in feature (resweep step 26), NOT a change to this dialect.
 *
 * Local harness fork of the sibling lore-activation suites' makeEntry /
 * makeInput (tri-state-matching carries the canonical copy).
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

/** Entry with matchWholeWords=true, everything else at default. */
function wholeWordEntry(id: string, keys: string[], overrides: Record<string, unknown> = {}) {
  return makeEntry(id, { keys, matchWholeWords: true, ...overrides });
}

describe("lore activation engine — whole-word dialect (N4, P5)", () => {
  it("a Cyrillic single-word key matches under whole words (\\b never fired for Cyrillic)", () => {
    const entry = wholeWordEntry("ru_word", ["дракон"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "Там был дракон." })))).toEqual(["ru_word"]);
  });

  it("a Cyrillic key over-matches inside longer word forms — exactly ST, by ruling", () => {
    // JS \\W is ASCII: Cyrillic letters count as \\W, so the boundary before
    // «дракон» in «мегадракон» is satisfied. ST behaves identically; the
    // fix for the over-match is the opt-in case-forms flag (step 26), never
    // a dialect change.
    const entry = wholeWordEntry("ru_over", ["дракон"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "Там был мегадракон." })))).toEqual(["ru_over"]);
  });

  it("a key with leading/trailing punctuation matches (\\b could not sit next to punctuation)", () => {
    const trailing = wholeWordEntry("punct_trail", ["dragon!"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([trailing], { text: "roared dragon!" })))).toEqual(["punct_trail"]);
    const leading = wholeWordEntry("punct_lead", ["«шёпот»"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([leading], { text: "он сказал «шёпот» и замолчал" })))).toEqual(["punct_lead"]);
  });

  it("punctuation adjacent to a plain word key still matches (both dialects agree)", () => {
    const entry = wholeWordEntry("adjacent", ["king"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "the king, he waits (king)" })))).toEqual(["adjacent"]);
  });

  it("a Latin single-word key stays bounded — no match inside a longer word", () => {
    const entry = wholeWordEntry("lat_bound", ["king"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "he was liking it" })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "the king arrives" })))).toEqual(["lat_bound"]);
  });

  it("a multi-word key is a plain substring under whole words — plural/inflected endings match", () => {
    const entry = wholeWordEntry("multi_lat", ["black dragon"]);
    // "dragons" — \b phrase matching would fail, ST's includes() matches.
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "the black dragons fly north" })))).toEqual(["multi_lat"]);
    // Case-insensitive resolution still applies (default false).
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "a BLACK DRAGON circles" })))).toEqual(["multi_lat"]);
  });

  it("a multi-word Cyrillic key is a plain substring — inflected tail matches", () => {
    const entry = wholeWordEntry("multi_ru", ["красный дракон"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "красный драконом овладела ярость" })))).toEqual(["multi_ru"]);
  });

  it("caseSensitive=true keeps a Cyrillic key case-sensitive under whole words", () => {
    const entry = wholeWordEntry("ru_case", ["Дракон"], { caseSensitive: true });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "Там был дракон." })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "Там был Дракон." })))).toEqual(["ru_case"]);
  });

  it("whole words OFF is the unchanged substring path", () => {
    const entry = makeEntry("ww_off", { keys: ["king"], matchWholeWords: false });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "he was liking it" })))).toEqual(["ww_off"]);
  });

  it("the dialect serves secondary keys identically", () => {
    const entry = wholeWordEntry("sec_ww", ["primary"], { secondaryKeys: ["дракон"], logic: "and_any" });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "primary and был дракон" })))).toEqual(["sec_ww"]);
  });
});
