import { describe, expect, it } from "bun:test";
import {
  resolveActivatedEntries,
  type ActivationInput,
  type LoreActivationState,
} from "../src/domain/prompt/lore-activation-engine.js";

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "timed_entry",
    title: "Timed entry",
    content: "Timed lore",
    keys: ["needle"],
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
    groupWeight: 100,
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

function resolveTimed(entry: ReturnType<typeof makeEntry>, currentTurn: number, activationState: LoreActivationState) {
  const input: ActivationInput = {
    lorebooks: [{
      id: "lorebook",
      scanDepth: 1,
      tokenBudget: 10_000,
      tokenBudgetPercent: null,
      recursiveScanning: false,
      maxRecursionSteps: 0,
      includeNames: false,
      minActivations: 0,
      minActivationsDepthMax: 0,
      entries: [entry],
    }],
    messages: [{ role: "user", content: "no matching key" }],
    macroMap: {},
    characterId: "character",
    characterName: "Character",
    activationState,
    currentTurn,
  };
  return resolveActivatedEntries(input);
}

function activatedAt(turn: number): LoreActivationState {
  return {
    timed_entry: { activatedAtTurn: turn, lastMatchedAtTurn: turn },
  };
}

describe("lore activation engine — timed-effect lifecycle (N6)", () => {
  it("keeps a live sticky window after the chat advances", () => {
    const result = resolveTimed(makeEntry({ stickyWindow: 2 }), 11, activatedAt(10));

    expect(result.activatedEntries.map(entry => entry.id)).toEqual(["timed_entry"]);
    expect(result.updatedState.timed_entry).toEqual({ activatedAtTurn: 10, lastMatchedAtTurn: 10 });
  });

  it("removes a sticky effect when a swipe re-resolves at its activation turn", () => {
    const result = resolveTimed(makeEntry({ stickyWindow: 2 }), 10, activatedAt(10));

    expect(result.activatedEntries).toEqual([]);
    expect(result.updatedState.timed_entry).toBeUndefined();
  });

  it("removes a sticky effect when message deletion shrinks below its activation turn", () => {
    const result = resolveTimed(makeEntry({ stickyWindow: 2 }), 9, activatedAt(10));

    expect(result.activatedEntries).toEqual([]);
    expect(result.updatedState.timed_entry).toBeUndefined();
  });

  it("keeps a cooldown effect after the chat advances but removes it on non-advance", () => {
    const entry = makeEntry({ cooldownWindow: 2 });

    const advanced = resolveTimed(entry, 11, activatedAt(10));
    expect(advanced.activatedEntries).toEqual([]);
    expect(advanced.updatedState.timed_entry).toEqual({ activatedAtTurn: 10, lastMatchedAtTurn: 10 });

    const swiped = resolveTimed(entry, 10, activatedAt(10));
    expect(swiped.activatedEntries).toEqual([]);
    expect(swiped.updatedState.timed_entry).toBeUndefined();

    const deleted = resolveTimed(entry, 9, activatedAt(10));
    expect(deleted.activatedEntries).toEqual([]);
    expect(deleted.updatedState.timed_entry).toBeUndefined();
  });
});
