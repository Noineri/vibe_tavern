import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Regex key channel — authored flags verbatim (ST parity, N3).
 *
 * ST world-info.js 337-342: "If the needle is a regex, we do regex pattern
 * matching and override all the other options" — a `/pattern/flags` key is
 * compiled with EXACTLY the authored flags (`parseRegexFromString`,
 * world-info.js 2846: `new RegExp(pattern, flags)`) and the entry's
 * caseSensitive / matchWholeWords settings do not touch it. In particular a
 * flagless regex is case-SENSITIVE even when the entry resolves
 * case-insensitive — VT used to inject `i` as the flagless fallback
 * (engine matchKeys, resweep finding N3).
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

describe("lore activation engine — regex keys run with authored flags (N3)", () => {
  it("a flagless regex is case-SENSITIVE even when the entry resolves case-insensitive", () => {
    const entry = makeEntry("re_bare", { keys: ["/dragon/"] });
    // Entry null + no book default → case-insensitive resolution, but the
    // regex channel ignores it: authored flags ("") mean fully case-sensitive.
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "Dragons roar overhead" })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "the dragon sleeps" })))).toEqual(["re_bare"]);
  });

  it("an authored i flag applies verbatim — the entry setting cannot strip it either", () => {
    const entry = makeEntry("re_i", { keys: ["/dragon/i"] });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "DRAGONS roar overhead" })))).toEqual(["re_i"]);
    // caseSensitive=true on the entry (and book) does NOT remove the authored i.
    const strict = makeEntry("re_i_strict", { keys: ["/dragon/i"], caseSensitive: true });
    expect(
      activatedIds(resolveActivatedEntries(makeInput([strict], { book: { caseSensitive: true }, text: "DRAGONS roar" }))),
    ).toEqual(["re_i_strict"]);
  });

  it("regex keys override matchWholeWords — no word boundary is enforced", () => {
    const entry = makeEntry("re_ww", { keys: ["/dragons?/"] });
    const book = { matchWholeWords: true };
    // "dragon" inside "dragonsnight" has no word boundary; a plain key under
    // whole-words would miss, the regex channel matches (ST overrides all
    // other options).
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { book, text: "a dragonsnight feast" })))).toEqual(["re_ww"]);
  });

  it("character classes work and inherit the authored case sensitivity", () => {
    const entry = makeEntry("re_class", { keys: ["/drag[ou]n/"] });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "a Dragon passes" })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "a dragun passes" })))).toEqual(["re_class"]);
  });

  it("the regex channel serves secondary keys with the same authored-flags rule", () => {
    const entry = makeEntry("re_secondary", { keys: ["primary"], secondaryKeys: ["/lair/i"], logic: "and_any" });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "primary and the LAIR beyond" })))).toEqual(["re_secondary"]);
    const strictSec = makeEntry("re_sec_bare", { keys: ["primary"], secondaryKeys: ["/lair/"], logic: "and_any" });
    expect(activatedIds(resolveActivatedEntries(makeInput([strictSec], { text: "primary and the LAIR beyond" })))).toEqual([]);
  });

  it("an authored g flag does not poison repeated resolutions (fresh compile per scan)", () => {
    const entry = makeEntry("re_g", { keys: ["/dragon/g"] });
    const input = makeInput([entry], { text: "the dragon sleeps" });
    expect(activatedIds(resolveActivatedEntries(input))).toEqual(["re_g"]);
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "the dragon wakes" })))).toEqual(["re_g"]);
  });

  it("an invalid authored regex is skipped silently — no crash, no activation", () => {
    const entry = makeEntry("re_invalid", { keys: ["/(/i"] });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "anything ( anything" })))).toEqual([]);
  });

  it("a key that is not in /pattern/flags format is a PLAIN key, not a regex", () => {
    // No closing delimiter → plain literal; it matches its literal text.
    const entry = makeEntry("re_not_regex", { keys: ["/only-start"] });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry], { text: "we saw /only-start here" })))).toEqual(["re_not_regex"]);
    // A bare unescaped-dot plain key still behaves literally (regex metachars escaped).
    const dotted = makeEntry("re_dotted", { keys: ["a.b"] });
    expect(activatedIds(resolveActivatedEntries(makeInput([dotted], { text: "axb in the text" })))).toEqual([]);
    expect(activatedIds(resolveActivatedEntries(makeInput([dotted], { text: "a.b in the text" })))).toEqual(["re_dotted"]);
  });
});
