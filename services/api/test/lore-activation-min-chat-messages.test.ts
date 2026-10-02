import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Absolute chat-length gate — `minChatMessages` (ST `delay` parity).
 *
 * ST computes `isDelay` from chat.length via #checkDelayEffect
 * (world-info.js ~663-676) and `continue`s on it BEFORE the cooldown,
 * delay-until-recursion, decorator, constant and sticky gates (~4735-4790):
 * an entry below its threshold is fully suppressed — constants, live sticky
 * windows and @@activate decorators included. The gate is stateless: it
 * re-evaluates every scan, so a chat that shrinks below N re-suppresses the
 * entry. 0 = off.
 *
 * Replaces the removed VT-only `delayWindow` mechanic (match-armed pending
 * state, constants exempt). See LOREBOOK_ST_PARITY_RESWEEP_2026-09 (A, N12;
 * owner ruling 2026-09-24) — the old mechanic's tests were deleted with it;
 * these pin the ST behavior that replaces them.
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

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
  return result.activatedEntries.map((e) => e.id);
}

describe("lore activation engine — minChatMessages absolute gate (ST `delay`)", () => {
  it("suppresses a CONSTANT entry below the threshold and activates it from message N (the owner's scenario)", () => {
    const entry = makeEntry("late_constant", { constant: true, minChatMessages: 30 });
    // 29 messages → suppressed (ST: chat.length < delay).
    const t29 = resolveActivatedEntries(makeInput([entry], { currentTurn: 29 }));
    expect(activatedIds(t29)).toEqual([]);
    // 30 messages → active, as a constant.
    const t30 = resolveActivatedEntries(makeInput([entry], { currentTurn: 30 }));
    expect(activatedIds(t30)).toEqual(["late_constant"]);
    expect(t30.activatedEntries[0].reason.kind).toBe("constant");
  });

  it("the gate is stateless — a chat that shrinks below N re-suppresses the entry", () => {
    const entry = makeEntry("shrink", { constant: true, minChatMessages: 30 });
    const t30 = resolveActivatedEntries(makeInput([entry], { currentTurn: 30 }));
    expect(activatedIds(t30)).toEqual(["shrink"]);
    // Deleting messages below 30: the next scan sees a shorter chat and the
    // gate re-fires (no persisted "already activated" exemption).
    const t25 = resolveActivatedEntries(
      makeInput([entry], { currentTurn: 25, activationState: t30.updatedState }),
    );
    expect(activatedIds(t25)).toEqual([]);
  });

  it("suppresses a live sticky window below the threshold without touching its anchors", () => {
    const entry = makeEntry("sticky_gated", { stickyWindow: 5, minChatMessages: 11 });
    const state = { sticky_gated: { activatedAtTurn: 8, lastMatchedAtTurn: 8 } };
    // Sticky is alive at turn 10 (10-8 < 5), but the gate fires first.
    const t10 = resolveActivatedEntries(makeInput([entry], { currentTurn: 10, activationState: state }));
    expect(activatedIds(t10)).toEqual([]);
    // The suppression must not consume/rewrite the sticky anchors.
    expect(t10.updatedState.sticky_gated).toEqual(state.sticky_gated);
    // At threshold the same sticky window activates normally.
    const t11 = resolveActivatedEntries(makeInput([entry], { currentTurn: 11, activationState: state }));
    expect(activatedIds(t11)).toEqual(["sticky_gated"]);
    expect(t11.activatedEntries[0].reason.kind).toBe("sticky");
  });

  it("suppresses a key-matched entry below the threshold and writes no activation state", () => {
    const entry = makeEntry("keyed_gated", { keys: ["dragon"], minChatMessages: 2 });
    const input = makeInput([entry], {
      messages: [{ role: "user", content: "a dragon appears" }],
      currentTurn: 1,
    });
    const result = resolveActivatedEntries(input);
    expect(activatedIds(result)).toEqual([]);
    // Never a candidate → no state write (unlike the old delayWindow pending arm).
    expect(result.updatedState.keyed_gated).toBeUndefined();
    const t2 = resolveActivatedEntries(makeInput([entry], {
      messages: [{ role: "user", content: "a dragon appears" }, { role: "assistant", content: "the dragon roars" }],
      currentTurn: 2,
    }));
    expect(activatedIds(t2)).toEqual(["keyed_gated"]);
    expect(t2.activatedEntries[0].reason.kind).toBe("key_match");
  });

  it("suppresses an @@activate decorator entry below the threshold (ST: isDelay precedes decorators)", () => {
    const entry = makeEntry("dec_gated", { content: "@@activate\nforced", minChatMessages: 5 });
    const below = resolveActivatedEntries(makeInput([entry], { currentTurn: 4 }));
    expect(activatedIds(below)).toEqual([]);
    const at = resolveActivatedEntries(makeInput([entry], { currentTurn: 5 }));
    expect(activatedIds(at)).toEqual(["dec_gated"]);
    expect(at.activatedEntries[0].reason.kind).toBe("decorator");
  });

  it("minChatMessages 0 = off — activates from the very first message", () => {
    const entry = makeEntry("ungated", { constant: true, minChatMessages: 0 });
    const t0 = resolveActivatedEntries(makeInput([entry], { currentTurn: 0 }));
    expect(activatedIds(t0)).toEqual(["ungated"]);
  });
});
