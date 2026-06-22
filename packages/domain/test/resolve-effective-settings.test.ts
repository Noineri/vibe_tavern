import { describe, expect, test } from "bun:test";
import {
  resolveEffectiveSettings,
  type ModelSettingsOverlay,
  type StoredProviderProfileRecord,
} from "../src/provider-profile.js";

/**
 * Characterization tests for the per-model overlay resolver — the single
 * function the generation boundary calls to derive effective sampler/context
 * settings from a profile base + a per-model overlay.
 */
describe("resolveEffectiveSettings", () => {
  function makeBase(over: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
    return {
      id: "profile_1",
      name: "base",
      providerPreset: "openaiCompat",
      endpoint: "https://api.test/v1",
      apiKey: "key",
      defaultModel: "gpt-4o",
      contextBudget: 16000,
      pinContextBudget: false,
      bindPerModel: false,
      maxTokens: 2000,
      temperature: 1,
      topP: 1,
      topK: 0,
      minP: 0,
      topA: 0,
      typicalP: 1,
      tfsZ: 1,
      repeatLastN: 0,
      mirostat: 0,
      mirostatTau: 5,
      mirostatEta: 0.1,
      dryMultiplier: 0,
      dryBase: 1.75,
      dryAllowedLength: 2,
      drySequenceBreakers: [],
      xtcThreshold: 0.1,
      xtcProbability: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      repetitionPenalty: 1,
      stopSequences: ["<end>"],
      logitBias: [{ tokenId: 1, bias: 2 }],
      seed: null,
      reasoningEffort: "auto",
      showReasoning: false,
      streamResponse: true,
      customSamplers: false,
      isActive: true,
      visionModel: null,
      createdAt: "0",
      updatedAt: "0",
      ...over,
    };
  }

  test("null overlay returns base unchanged (same reference)", () => {
    const base = makeBase();
    expect(resolveEffectiveSettings(base, null)).toBe(base);
  });

  test("undefined overlay returns base unchanged (same reference)", () => {
    const base = makeBase();
    expect(resolveEffectiveSettings(base, undefined)).toBe(base);
  });

  test("present overlay fields override base; absent fields inherit", () => {
    const base = makeBase({ temperature: 1, contextBudget: 16000, topP: 0.9 });
    const overlay: ModelSettingsOverlay = { temperature: 0.3, contextBudget: 8000 };
    const effective = resolveEffectiveSettings(base, overlay);
    expect(effective.temperature).toBe(0.3); // overridden
    expect(effective.contextBudget).toBe(8000); // overridden
    expect(effective.topP).toBe(0.9); // inherited (absent from overlay)
  });

  test("empty overlay object returns a shallow clone of base", () => {
    const base = makeBase();
    const effective = resolveEffectiveSettings(base, {});
    expect(effective).not.toBe(base); // new object
    expect(effective).toEqual(base); // same values
  });

  test("arrays are replaced wholesale, not deep-merged", () => {
    const base = makeBase({
      stopSequences: ["<end>", "<stop>"],
      logitBias: [{ tokenId: 1, bias: 2 }],
    });
    const overlay: ModelSettingsOverlay = { stopSequences: ["\\n\\nUser:"] };
    const effective = resolveEffectiveSettings(base, overlay);
    expect(effective.stopSequences).toEqual(["\\n\\nUser:"]); // fully replaced
    expect(effective.logitBias).toEqual([{ tokenId: 1, bias: 2 }]); // inherited
  });

  test("identity fields are NEVER overridden (overlay cannot rename/rebind profile)", () => {
    const base = makeBase({ name: "base", endpoint: "https://a", defaultModel: "gpt-4o" });
    // ModelSettingsOverlay doesn't even allow these keys, but assert the result keeps base identity.
    const overlay: ModelSettingsOverlay = { temperature: 0.5 };
    const effective = resolveEffectiveSettings(base, overlay);
    expect(effective.name).toBe("base");
    expect(effective.endpoint).toBe("https://a");
    expect(effective.defaultModel).toBe("gpt-4o");
    expect(effective.id).toBe("profile_1");
  });

  test("simulated JSON round-trip: explicit-undefined keys are dropped before merge", () => {
    // A real overlay arrives via JSON.parse(settingsJson). JSON.stringify drops
    // undefined keys, so the parsed object never carries them. Simulate that
    // round-trip to lock the contract that "absent = inherit".
    const base = makeBase({ temperature: 1, topP: 0.9 });
    const rawOverlay = { temperature: 0.7, topP: undefined } as unknown as ModelSettingsOverlay;
    const roundTripped = JSON.parse(JSON.stringify(rawOverlay)) as ModelSettingsOverlay;
    const effective = resolveEffectiveSettings(base, roundTripped);
    expect(effective.temperature).toBe(0.7); // set
    expect(effective.topP).toBe(0.9); // inherited (undefined dropped by JSON)
  });

  test("pinContextBudget is overridable per model (per V7 decision)", () => {
    const base = makeBase({ pinContextBudget: false, contextBudget: 16000 });
    const overlay: ModelSettingsOverlay = { pinContextBudget: true, contextBudget: 8000 };
    const effective = resolveEffectiveSettings(base, overlay);
    expect(effective.pinContextBudget).toBe(true);
    expect(effective.contextBudget).toBe(8000);
  });
});
