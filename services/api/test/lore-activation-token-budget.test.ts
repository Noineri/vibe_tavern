import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Characterization tests for the token-budget subsystem of the LIVE activation
 * engine (`lorebook.tokenBudget` + `lorebook.tokenBudgetPercent`).
 *
 * Two modes (see lorebook-st-parity-audit.md §1.4):
 *   - Fixed: `tokenBudgetPercent == null` → cap = `tokenBudget`
 *   - Percent: `tokenBudgetPercent != null` → cap = round(maxContextTokens * pct/100)
 *
 * `ignoreBudget` bypasses the budget entirely.
 * Overflow resolution is by `priority` descending: higher priority survives.
 */

function makeEntry(id: string, content: string, priority: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    content,
    keys: [] as string[],
    secondaryKeys: [] as string[],
    logic: "and_any",
    position: "before_char",
    depth: 0,
    priority,
    stickyWindow: 0,
    cooldownWindow: 0,
    delayWindow: 0,
    constant: true,
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
    caseSensitive: false,
    matchWholeWords: false,
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
  lorebookOverrides: Record<string, unknown> = {},
  inputOverrides: Record<string, unknown> = {},
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
        ...lorebookOverrides,
      },
    ],
    messages: [],
    macroMap: {},
    characterId: "c_test",
    characterName: "Test",
    activationState: {},
    currentTurn: 1,
    // Each char ≈ 0.25 tokens (ceil(chars/4)), so a 400-char entry ≈ 100 tokens.
    estimateTokenCount: (text: string) => Math.ceil(text.length / 4),
    ...inputOverrides,
  };
}

describe("token budget — fixed mode", () => {
  it("admits entries that fit the fixed budget", () => {
    // 3 entries × 100 tokens = 300 ≤ budget 1000 → all kept.
    const entries = [
      makeEntry("a", "x".repeat(400), 30),
      makeEntry("b", "x".repeat(400), 20),
      makeEntry("c", "x".repeat(400), 10),
    ];
    const result = resolveActivatedEntries(makeInput(entries, { tokenBudget: 1000 }));
    expect(result.activatedEntries.map(e => e.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("drops lowest-priority entries first when fixed budget overflows", () => {
    // 3 entries × 100 tokens = 300 > budget 200 → one must drop. Lowest priority (c) drops.
    const entries = [
      makeEntry("a", "x".repeat(400), 30),
      makeEntry("b", "x".repeat(400), 20),
      makeEntry("c", "x".repeat(400), 10), // lowest priority
    ];
    const result = resolveActivatedEntries(makeInput(entries, { tokenBudget: 200 }));
    const ids = result.activatedEntries.map(e => e.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("c");
  });

  it("ignoreBudget entries bypass the cap entirely", () => {
    // Budget 50, but entry a is ignoreBudget → stays despite overflow.
    const entries = [
      makeEntry("a", "x".repeat(400), 10, { ignoreBudget: true }),  // 100 tokens, ignoreBudget
      makeEntry("b", "x".repeat(400), 20, { ignoreBudget: false }), // 100 tokens, would overflow
    ];
    const result = resolveActivatedEntries(makeInput(entries, { tokenBudget: 50 }));
    const ids = result.activatedEntries.map(e => e.id);
    expect(ids).toContain("a"); // ignoreBudget → kept
    expect(ids).not.toContain("b"); // dropped by budget
  });
});

describe("token budget — percent-of-context mode", () => {
  it("computes cap as round(maxContextTokens × pct / 100)", () => {
    // maxContextTokens = 10000, pct = 5 → cap = 500 tokens.
    // 4 entries × 100 tokens = 400 ≤ 500 → all kept.
    const entries = [
      makeEntry("a", "x".repeat(400), 40),
      makeEntry("b", "x".repeat(400), 30),
      makeEntry("c", "x".repeat(400), 20),
      makeEntry("d", "x".repeat(400), 10),
    ];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 5 }, { maxContextTokens: 10000 }),
    );
    expect(result.activatedEntries.map(e => e.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("percent mode trims by priority when overflow", () => {
    // maxContextTokens = 10000, pct = 3 → cap = 300 tokens.
    // 4 entries × 100 tokens = 400 > 300 → lowest priority (d) drops.
    const entries = [
      makeEntry("a", "x".repeat(400), 40),
      makeEntry("b", "x".repeat(400), 30),
      makeEntry("c", "x".repeat(400), 20),
      makeEntry("d", "x".repeat(400), 10), // lowest priority
    ];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 3 }, { maxContextTokens: 10000 }),
    );
    const ids = result.activatedEntries.map(e => e.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).not.toContain("d");
  });

  it("falls back to fixed budget when maxContextTokens is absent", () => {
    // Percent set but no maxContextTokens → falls back to fixed tokenBudget.
    // tokenBudget = 100, percent = 5, no maxContextTokens → uses 100.
    // 1 entry × 100 tokens = 100 ≤ 100 → kept.
    const entries = [makeEntry("a", "x".repeat(400), 10)];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudget: 100, tokenBudgetPercent: 5 }),
    );
    expect(result.activatedEntries.map(e => e.id)).toEqual(["a"]);
  });

  it("percent mode respects ignoreBudget too", () => {
    // Cap = round(10000 × 1 / 100) = 100 tokens. Entry a is ignoreBudget
    // (200 tokens, bypasses cap); entry b is 200 tokens and would overflow.
    const entries = [
      makeEntry("a", "x".repeat(800), 10, { ignoreBudget: true }),  // 200 tokens
      makeEntry("b", "x".repeat(800), 20, { ignoreBudget: false }), // 200 tokens, overflows cap of 100
    ];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 1 }, { maxContextTokens: 10000 }), // cap = 100
    );
    const ids = result.activatedEntries.map(e => e.id);
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
  });
});
