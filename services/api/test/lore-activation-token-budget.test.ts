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
 * Consumption order is `priority` descending: higher priority survives.
 *
 * N5 (ST parity, resweep step 3): overflow is `>=` — an entry landing
 * exactly on the budget IS an overflow (world-info.js:4942) — and the first
 * overflow latches per book: later non-ignoreBudget entries are dropped
 * without a fit check (no best-effort fill; world-info.js:4902-4947).
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
    minChatMessages: 0,
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
    // 3 entries × 100 tokens = 300 > budget 250 → one must drop. a (100) and
    // b (200 cumulative) fit; c would reach exactly 300 — an exact landing is
    // an overflow (ST `>=`), so lowest priority (c) drops.
    const entries = [
      makeEntry("a", "x".repeat(400), 30),
      makeEntry("b", "x".repeat(400), 20),
      makeEntry("c", "x".repeat(400), 10), // lowest priority
    ];
    const result = resolveActivatedEntries(makeInput(entries, { tokenBudget: 250 }));
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
    // maxContextTokens = 10000, pct = 4 → cap = 400 tokens.
    // 4 entries × 100 tokens: a+b+c = 300 fits; d would land exactly on 400 —
    // exact landing is an overflow (ST `>=`), so lowest priority (d) drops.
    const entries = [
      makeEntry("a", "x".repeat(400), 40),
      makeEntry("b", "x".repeat(400), 30),
      makeEntry("c", "x".repeat(400), 20),
      makeEntry("d", "x".repeat(400), 10), // lowest priority
    ];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 4 }, { maxContextTokens: 10000 }),
    );
    const ids = result.activatedEntries.map(e => e.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).not.toContain("d");
  });

  it("falls back to fixed budget when maxContextTokens is absent", () => {
    // Percent set but no maxContextTokens → falls back to fixed tokenBudget.
    // tokenBudget = 150, percent = 5, no maxContextTokens → uses 150.
    // 1 entry × 100 tokens = 100 < 150 → kept.
    const entries = [makeEntry("a", "x".repeat(400), 10)];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudget: 150, tokenBudgetPercent: 5 }),
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

describe("token budget — N5: percent-mode absolute cap (ST world_info_budget_cap)", () => {
  it("cap clamps the percent budget DOWN", () => {
    // pct 5 of 10000 = 500; cap 250 → effective 250. Without the cap a+b+c
    // (300) would fit; with it c overflows.
    const entries = [
      makeEntry("a", "x".repeat(400), 30),
      makeEntry("b", "x".repeat(400), 20),
      makeEntry("c", "x".repeat(400), 10),
    ];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 5, tokenBudgetCap: 250 }, { maxContextTokens: 10000 }),
    );
    const ids = result.activatedEntries.map(e => e.id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("cap larger than the percent budget never raises it", () => {
    // pct 1 of 10000 = 100; cap 5000 → effective stays 100 → the 200-token
    // entry overflows.
    const entries = [makeEntry("a", "x".repeat(800), 10)];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 1, tokenBudgetCap: 5000 }, { maxContextTokens: 10000 }),
    );
    expect(result.activatedEntries.map(e => e.id)).toEqual([]);
  });

  it("cap 0 means no cap (ST default)", () => {
    // pct 5 of 10000 = 500; cap 0 → uncapped: all 3 × 100 fit (300 < 500).
    const entries = [
      makeEntry("a", "x".repeat(400), 30),
      makeEntry("b", "x".repeat(400), 20),
      makeEntry("c", "x".repeat(400), 10),
    ];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 5, tokenBudgetCap: 0 }, { maxContextTokens: 10000 }),
    );
    expect(result.activatedEntries.map(e => e.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("cap does not apply in fixed mode", () => {
    // Fixed budget 100, cap 50. If the cap were (wrongly) applied, the
    // effective budget would be 50 and the 60-token entry would drop; fixed
    // mode is already absolute, so 60 < 100 → kept.
    const entries = [makeEntry("a", "x".repeat(240), 10)]; // 60 tokens
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudget: 100, tokenBudgetPercent: null, tokenBudgetCap: 50 }),
    );
    expect(result.activatedEntries.map(e => e.id)).toEqual(["a"]);
  });

  it("percent budget has a floor of 1 (ST `|| 1`)", () => {
    // pct 0 of any context → round(0) = 0 → floored to 1: any non-empty
    // entry overflows instantly; ignoreBudget still passes.
    const entries = [
      makeEntry("a", "x".repeat(400), 20),
      makeEntry("b", "x".repeat(400), 10, { ignoreBudget: true }),
    ];
    const result = resolveActivatedEntries(
      makeInput(entries, { tokenBudgetPercent: 0 }, { maxContextTokens: 10000 }),
    );
    expect(result.activatedEntries.map(e => e.id)).toEqual(["b"]);
  });
});

describe("token budget — N5: stop-after-first-overflow latch", () => {
  it("no best-effort fill: a later SMALLER entry is not squeezed into the leftover", () => {
    // Budget 250: a (200) fits; b (100) overflows → latch; c is only 10
    // tokens and 200+10=210 < 250 would fit the leftover — but the latch
    // drops it (ST world-info.js:4902 — no fill after overflow).
    const entries = [
      makeEntry("a", "x".repeat(800), 30), // 200 tokens
      makeEntry("b", "x".repeat(400), 20), // 100 tokens → overflow
      makeEntry("c", "x".repeat(40), 10),  // 10 tokens → would fit, latch drops
    ];
    const result = resolveActivatedEntries(makeInput(entries, { tokenBudget: 250 }));
    expect(result.activatedEntries.map(e => e.id)).toEqual(["a"]);
  });

  it("ignoreBudget entries still pass after the latch", () => {
    // Same shape, plus d ignoreBudget with the LOWEST priority — it must
    // survive the latched book (ST keeps skipping until ignore entries end).
    const entries = [
      makeEntry("a", "x".repeat(800), 40), // 200 tokens, fits
      makeEntry("b", "x".repeat(400), 30), // overflow → latch
      makeEntry("c", "x".repeat(40), 20),  // latch drop
      makeEntry("d", "x".repeat(400), 10, { ignoreBudget: true }),
    ];
    const result = resolveActivatedEntries(makeInput(entries, { tokenBudget: 250 }));
    expect(result.activatedEntries.map(e => e.id).sort()).toEqual(["a", "d"]);
  });

  it("an entry landing exactly on the budget is an overflow (ST `>=`)", () => {
    // Budget 200, first entry exactly 200 tokens: cumulative 200 >= 200 →
    // overflow + latch. ST drops the exact-fit entry (world-info.js:4942).
    const entries = [
      makeEntry("a", "x".repeat(800), 30), // exactly 200 tokens
      makeEntry("b", "x".repeat(40), 20),  // tiny, proves the latch too
    ];
    const result = resolveActivatedEntries(makeInput(entries, { tokenBudget: 200 }));
    expect(result.activatedEntries.map(e => e.id)).toEqual([]);
  });

  it("the latch is per book — one book's overflow does not affect another", () => {
    // Book A budget 250: its a (200) fits, b overflows → A latched. Book B
    // (budget 250) has its own consumption: its entry must not be touched.
    const mk = (id: string, content: string, priority: number) => makeEntry(id, content, priority);
    const input: ActivationInput = {
      lorebooks: [
        {
          id: "lb_a",
          scanDepth: 1,
          tokenBudget: 250,
          tokenBudgetPercent: null,
          recursiveScanning: false,
          maxRecursionSteps: 0,
          includeNames: false,
          minActivations: 0,
          minActivationsDepthMax: 0,
          entries: [
            mk("a1", "x".repeat(800), 30), // 200 tokens, fits
            mk("a2", "x".repeat(400), 20), // overflow → latch book A
            mk("a3", "x".repeat(40), 10),  // latch drop
          ],
        },
        {
          id: "lb_b",
          scanDepth: 1,
          tokenBudget: 250,
          tokenBudgetPercent: null,
          recursiveScanning: false,
          maxRecursionSteps: 0,
          includeNames: false,
          minActivations: 0,
          minActivationsDepthMax: 0,
          entries: [
            mk("b1", "x".repeat(400), 30), // 100 tokens, fits
            mk("b2", "x".repeat(400), 20), // 200 < 250, fits
          ],
        },
      ],
      messages: [],
      macroMap: {},
      characterId: "c_test",
      characterName: "Test",
      activationState: {},
      currentTurn: 1,
      estimateTokenCount: (text: string) => Math.ceil(text.length / 4),
    };
    const result = resolveActivatedEntries(input);
    expect(result.activatedEntries.map(e => e.id).sort()).toEqual(["a1", "b1", "b2"]);
  });
});

describe("P21: overflowed books are reported (overflowAlert channel)", () => {
  // The engine reports; it never alerts. Per-book dropped counts = entries
  // removed by the N5 latch (first-overflow drop + every later latch drop).
  const base = (over: Record<string, unknown> = {}): ActivationInput => ({
    lorebooks: [
      {
        id: "lb_a",
        scanDepth: 1,
        tokenBudget: 250,
        tokenBudgetPercent: null,
        recursiveScanning: false,
        maxRecursionSteps: 0,
        includeNames: false,
        minActivations: 0,
        minActivationsDepthMax: 0,
        entries: [
          makeEntry("a1", "x".repeat(800), 30), // fits (200 ≤ budget)
          makeEntry("a2", "x".repeat(400), 20), // first overflow → dropped
          makeEntry("a3", "x".repeat(40), 10),  // latch drop
        ],
        ...over,
      },
    ],
    messages: [],
    macroMap: {},
    characterId: "c_test",
    characterName: "Test",
    activationState: {},
    currentTurn: 1,
    estimateTokenCount: (text: string) => Math.ceil(text.length / 4),
  });

  it("reports the overflowed book with its dropped count; absent for books that fit", () => {
    const result = resolveActivatedEntries(base());
    expect(result.overflowedBooks).toEqual([{ lorebookId: "lb_a", dropped: 2 }]);
  });

  it("no overflow → empty report", () => {
    const input = base();
    input.lorebooks[0]!.tokenBudget = 100_000;
    const result = resolveActivatedEntries(input);
    expect(result.overflowedBooks).toEqual([]);
  });

  it("a book whose overflow drops are all compensated by ignoreBudget entries is not reported", () => {
    // ignoreBudget entries bypass the budget entirely — they never drop and
    // never latch. A book with only ignoreBudget survivors overflows nothing.
    const input = base();
    input.lorebooks[0]!.entries = [
      makeEntry("a1", "x".repeat(400), 30, { ignoreBudget: true }),
      makeEntry("a2", "x".repeat(400), 20, { ignoreBudget: true }),
    ];
    const result = resolveActivatedEntries(input);
    expect(result.overflowedBooks).toEqual([]);
    expect(result.activatedEntries.map(e => e.id)).toEqual(["a1", "a2"]);
  });
});
