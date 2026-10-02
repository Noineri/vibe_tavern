import { describe, expect, test } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "ru_entry",
    title: "Russian key",
    content: "content",
    keys: ["дракон"],
    secondaryKeys: [],
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
    caseSensitive: null,
    matchWholeWords: null,
    caseFormsKeys: ["дракон"],
    characterFilter: [],
    characterFilterExclude: false,
    matchSources: [],
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

function resolve(text: string, entry = makeEntry()) {
  const input: ActivationInput = {
    lorebooks: [{
      id: "lb",
      scanDepth: 1,
      tokenBudget: 100_000,
      tokenBudgetPercent: null,
      recursiveScanning: false,
      maxRecursionSteps: 0,
      includeNames: false,
      minActivations: 0,
      minActivationsDepthMax: 0,
      entries: [entry],
    }],
    messages: [{ role: "user", content: text }],
    macroMap: {},
    characterId: "character",
    characterName: "Character",
    activationState: {},
    currentTurn: 1,
  };
  return resolveActivatedEntries(input).activatedEntries;
}

describe("lore activation engine — Russian case forms", () => {
  test("a flagged key activates on an inflected form and reports the visible plain key", () => {
    const activated = resolve("Он говорил с драконом.");
    expect(activated.map((entry) => entry.id)).toEqual(["ru_entry"]);
    expect(activated[0].matchedKeys).toEqual(["дракон"]);
  });

  test("Unicode letter boundaries reject the approved stem false positives", () => {
    expect(resolve("мегадракон")).toEqual([]);
    expect(resolve("скот", makeEntry({ keys: ["кот"], caseFormsKeys: ["кот"] }))).toEqual([]);
  });

  test("preserves OR-primary and secondary-key logic while compiling flagged keys", () => {
    expect(resolve("замком", makeEntry({ keys: ["дракон", "замок"], caseFormsKeys: ["дракон", "замок"] }))
      .map((entry) => entry.id)).toEqual(["ru_entry"]);
    expect(resolve("дракона котом", makeEntry({
      secondaryKeys: ["кот"],
      logic: "and_all",
      caseFormsKeys: ["дракон", "кот"],
    })).map((entry) => entry.id)).toEqual(["ru_entry"]);
  });
});
