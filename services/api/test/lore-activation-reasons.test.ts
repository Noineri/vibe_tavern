import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Activation-reason tests for the live lore activation engine.
 *
 * Each activation path (constant / sticky / delay-fulfilled / @@activate
 * decorator / key match) must tag the resulting entry with a structured
 * `reason: LoreActivationReason` so the prompt trace can surface *why* an
 * entry activated (reports/lorebook-trace-conditions.md). These tests
 * characterize every reason kind + the recursion variant of key_match.
 *
 * Scope: ACTIVATED entries only. Skip reasons (cooldown, no-key-match, ...) are
 * deliberately not persisted (per noineri 2026-06-21) and thus not asserted.
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
    delayWindow: 0,
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
  inputOverrides: Partial<ActivationInput> = {},
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
      },
    ],
    messages: [],
    macroMap: {},
    characterId: "c_test",
    characterName: "Test",
    activationState: {},
    currentTurn: 1,
    ...inputOverrides,
  };
}

function activated(result: ReturnType<typeof resolveActivatedEntries>, id: string) {
  return result.activatedEntries.find((e) => e.id === id);
}

describe("lore activation engine — reason tagging on activated entries", () => {
  it("tags a constant entry with reason { kind: 'constant' }", () => {
    const result = resolveActivatedEntries(
      makeInput([makeEntry("e_const", { constant: true })]),
    );
    const entry = activated(result, "e_const");
    expect(entry).toBeDefined();
    expect(entry!.reason).toEqual({ kind: "constant" });
  });

  it("tags a sticky entry with reason { kind: 'sticky', turnsSinceActivation, window }", () => {
    const result = resolveActivatedEntries(
      makeInput([makeEntry("e_sticky", { stickyWindow: 5 })], {
        // Pretend it activated 2 turns ago and sticky window is 5 → still sticky.
        activationState: { e_sticky: { activatedAtTurn: 1, lastMatchedAtTurn: 1 } },
        currentTurn: 3,
      }),
    );
    const entry = activated(result, "e_sticky");
    expect(entry).toBeDefined();
    expect(entry!.reason).toEqual({ kind: "sticky", turnsSinceActivation: 2, window: 5 });
  });

  it("tags a key-matched entry with reason { kind: 'key_match', matchedKeys, matchCount, scanState: 'normal' }", () => {
    const result = resolveActivatedEntries(
      makeInput(
        [makeEntry("e_keys", { keys: ["alice", "rabbit"] })],
        {
          messages: [{ role: "user", content: "alice fell down the rabbit hole" }],
          currentTurn: 1,
        },
      ),
    );
    const entry = activated(result, "e_keys");
    expect(entry).toBeDefined();
    expect(entry!.reason).toEqual({
      kind: "key_match",
      matchedKeys: expect.arrayContaining(["alice", "rabbit"]),
      matchCount: 2,
      scanState: "normal",
    });
    expect(entry!.reason.kind).toBe("key_match");
    if (entry!.reason.kind === "key_match") {
      expect(entry!.reason.matchedKeys.sort()).toEqual(["alice", "rabbit"]);
    }
  });

  it("tags a @@activate decorator entry with reason { kind: 'decorator' } even without a key match", () => {
    const result = resolveActivatedEntries(
      makeInput([makeEntry("e_dec", { content: "@@activate\nforced content" })]),
    );
    const entry = activated(result, "e_dec");
    expect(entry).toBeDefined();
    expect(entry!.reason).toEqual({ kind: "decorator" });
  });

  it("tags a delay-fulfilled entry with reason { kind: 'delay_fulfilled' }", () => {
    // delayWindow=2; pendingDelayUntilTurn=1; currentTurn=5 → pending reached.
    const result = resolveActivatedEntries(
      makeInput(
        [makeEntry("e_delay", { delayWindow: 2, keys: ["trigger"] })],
        {
          activationState: { e_delay: { pendingDelayUntilTurn: 1 } },
          messages: [{ role: "user", content: "trigger fired" }],
          currentTurn: 5,
        },
      ),
    );
    const entry = activated(result, "e_delay");
    expect(entry).toBeDefined();
    expect(entry!.reason).toEqual({ kind: "delay_fulfilled" });
  });

  it("tags a recursion-pass key match with scanState: 'recursion'", () => {
    // e_anchor matches on the base scan; e_deep only matches text that e_anchor
    // injects, so e_deep activates during the recursion pass.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("e_anchor", { keys: ["opengate"], content: "the deep vault is now open" }),
          makeEntry("e_deep", { keys: ["deep vault"] }),
        ],
        {
          lorebooks: [
            {
              id: "lb_test",
              scanDepth: 1,
              tokenBudget: 100_000,
              tokenBudgetPercent: null,
              recursiveScanning: true,
              maxRecursionSteps: 3,
              includeNames: false,
              minActivations: 0,
              minActivationsDepthMax: 0,
              entries: [
                makeEntry("e_anchor", { keys: ["opengate"], content: "the deep vault is now open" }),
                makeEntry("e_deep", { keys: ["deep vault"] }),
              ],
            },
          ],
          messages: [{ role: "user", content: "opengate" }],
          currentTurn: 1,
        },
      ),
    );
    const deep = activated(result, "e_deep");
    expect(deep).toBeDefined();
    expect(deep!.reason.kind).toBe("key_match");
    if (deep!.reason.kind === "key_match") {
      expect(deep!.reason.scanState).toBe("recursion");
    }
  });

  it("does NOT add reason to entries that fail to activate", () => {
    const result = resolveActivatedEntries(
      makeInput([
        makeEntry("e_const", { constant: true }),
        makeEntry("e_silent", { keys: ["never-mentioned"] }), // no match → not activated
      ]),
    );
    expect(activated(result, "e_const")).toBeDefined();
    expect(activated(result, "e_silent")).toBeUndefined();
    // Only the activated one carries a reason.
    expect(result.activatedEntries.every((e) => "reason" in e)).toBe(true);
  });
});
