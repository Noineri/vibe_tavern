import { describe, expect, test } from "bun:test";
import {
  computeSceneSchemaHash,
  createDefaultSceneTrackerConfig,
  defaultObjectiveState,
  normalizeAutoSummaryConfig,
  normalizeInsightsConfig,
  normalizeObjectiveState,
} from "../src/index.js";

/**
 * The chat store reads its JSON columns only through these normalizers, so
 * they own every legacy/corrupt-row default the services used to re-derive.
 */

describe("normalizeAutoSummaryConfig", () => {
  test("a legacy or non-object value gets the full default config", () => {
    const expected = {
      enabled: false,
      everyN: 20,
      useChatModel: true,
      excludeSummarized: true,
      includePriorSummaries: true,
      maxPriorSummaries: 10,
    };
    expect(normalizeAutoSummaryConfig({})).toEqual(expected);
    expect(normalizeAutoSummaryConfig(null)).toEqual(expected);
    expect(normalizeAutoSummaryConfig([1, 2])).toEqual(expected);
  });

  test("only an explicit true enables, only an explicit false disables the default-on flags", () => {
    const config = normalizeAutoSummaryConfig({ enabled: "yes", useChatModel: 0, excludeSummarized: false, includePriorSummaries: false });
    expect(config.enabled).toBe(false);
    expect(config.useChatModel).toBe(true);
    expect(config.excludeSummarized).toBe(false);
    expect(config.includePriorSummaries).toBe(false);
  });

  test("floors and clamps the numeric fields", () => {
    expect(normalizeAutoSummaryConfig({ everyN: 7.9, maxPriorSummaries: 3.5 })).toMatchObject({ everyN: 7, maxPriorSummaries: 3 });
    expect(normalizeAutoSummaryConfig({ everyN: 0, maxPriorSummaries: 500 })).toMatchObject({ everyN: 1, maxPriorSummaries: 100 });
    expect(normalizeAutoSummaryConfig({ everyN: Number.NaN, maxPriorSummaries: -4 })).toMatchObject({ everyN: 20, maxPriorSummaries: 0 });
  });

  test("keeps a pinned provider and model only when they are strings", () => {
    expect(normalizeAutoSummaryConfig({ providerProfileId: "pp_1", model: "m" })).toMatchObject({ providerProfileId: "pp_1", model: "m" });
    const config = normalizeAutoSummaryConfig({ providerProfileId: 5, model: null });
    expect("providerProfileId" in config).toBe(false);
    expect("model" in config).toBe(false);
  });
});

describe("normalizeInsightsConfig", () => {
  test("a legacy value turns every feature off, inherits dice scripts and actors, and has no tracker", () => {
    const config = normalizeInsightsConfig({});
    expect(config).toEqual({
      objectiveEnabled: false,
      trackerEnabled: false,
      diceEnabled: false,
      diceMode: "normal",
      diceScriptIds: null,
      diceActorBindings: null,
    });
    expect("tracker" in config).toBe(false);
    expect(normalizeInsightsConfig("garbage")).toEqual(config);
  });

  test("keeps valid toggles and the immersive dice mode; unknown modes fall back to normal", () => {
    expect(normalizeInsightsConfig({ objectiveEnabled: true, trackerEnabled: true, diceEnabled: true, diceMode: "immersive" }))
      .toMatchObject({ objectiveEnabled: true, trackerEnabled: true, diceEnabled: true, diceMode: "immersive" });
    expect(normalizeInsightsConfig({ diceMode: "weird" }).diceMode).toBe("normal");
  });

  test("an array of dice script ids is the override set (non-strings dropped); anything else inherits", () => {
    expect(normalizeInsightsConfig({ diceScriptIds: ["s1", 2, "s2"] }).diceScriptIds).toEqual(["s1", "s2"]);
    expect(normalizeInsightsConfig({ diceScriptIds: [] }).diceScriptIds).toEqual([]);
    expect(normalizeInsightsConfig({ diceScriptIds: "s1" }).diceScriptIds).toBeNull();
  });

  test("dice actor bindings drop invalid actors and entries left empty, but keep an empty record as an override", () => {
    expect(normalizeInsightsConfig({
      diceActorBindings: { s1: ["persona", "npc"], s2: ["npc"], s3: "persona", s4: ["character"] },
    }).diceActorBindings).toEqual({ s1: ["persona"], s4: ["character"] });
    expect(normalizeInsightsConfig({ diceActorBindings: {} }).diceActorBindings).toEqual({});
    expect(normalizeInsightsConfig({ diceActorBindings: [["persona"]] }).diceActorBindings).toBeNull();
  });

  test("a stored tracker is normalized with a recomputed schema hash; a non-object tracker stays absent", () => {
    const schema = { mood: { $type: "string" as const } };
    const config = normalizeInsightsConfig({ tracker: { schema, contextWindow: "oops", schemaHash: "stale", revision: 3 } });
    expect(config.tracker).toMatchObject({
      schema,
      contextWindow: createDefaultSceneTrackerConfig().contextWindow,
      schemaHash: computeSceneSchemaHash(schema),
      revision: 3,
    });
    expect("tracker" in normalizeInsightsConfig({ tracker: "oops" })).toBe(false);
  });
});

describe("normalizeObjectiveState", () => {
  test("an empty or non-object value is the default state", () => {
    expect(normalizeObjectiveState({})).toEqual(defaultObjectiveState());
    expect(normalizeObjectiveState(42)).toEqual(defaultObjectiveState());
  });

  test("floors the numeric config to its minimums", () => {
    const state = normalizeObjectiveState({ contextWindow: 3.8, autoCheckFrequency: 2.5, autoCheckEventCount: 4.8, injectionDepth: 0 });
    expect(state).toMatchObject({ contextWindow: 3, autoCheckFrequency: 2, autoCheckEventCount: 4, injectionDepth: 1 });
  });

  test("keeps valid items with trimmed descriptions and at most one active", () => {
    const state = normalizeObjectiveState({
      tasks: [
        { id: "t1", description: "  first  ", status: "active" },
        { id: "t2", description: "second", status: "active" },
        { id: "t3", description: "invalid", status: "done" },
        { id: "t4", description: "   ", status: "pending" },
        { description: "no id", status: "pending" },
      ],
      shortTermGoals: [{ id: "s1", description: "goal", status: "pending" }, "junk"],
    });
    expect(state.tasks).toEqual([
      { id: "t1", description: "first", status: "active" },
      { id: "t2", description: "second", status: "pending" },
    ]);
    expect(state.shortTermGoals).toEqual([{ id: "s1", description: "goal", status: "pending" }]);
  });

  test("goals mode and the long-term goal survive only when valid", () => {
    expect(normalizeObjectiveState({ mode: "goals", longTermGoal: { description: " Free the city ", status: "active" } }))
      .toMatchObject({ mode: "goals", longTermGoal: { description: "Free the city", status: "active" } });
    expect(normalizeObjectiveState({ mode: "other", longTermGoal: { description: "x", status: "bogus" } }))
      .toMatchObject({ mode: "route", longTermGoal: null });
  });

  test("a legacy state without model selection uses the chat model; blank pins become null", () => {
    expect(normalizeObjectiveState({ objectiveDescription: "goal", tasks: [] }))
      .toMatchObject({ useChatModel: true, providerProfileId: null, model: null });
    expect(normalizeObjectiveState({ useChatModel: false, providerProfileId: "  ", model: "m" }))
      .toMatchObject({ useChatModel: false, providerProfileId: null, model: "m" });
  });
});
