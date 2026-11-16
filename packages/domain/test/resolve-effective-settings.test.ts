import { describe, expect, test } from "bun:test";
import { COAUTHOR_TRANSPORT } from "../src/coauthor-transport-capabilities.js";
import {
  GENERATION_MODE,
  PROVIDER_PROFILE_GENERATION_DEFAULTS,
  PROXY_MODE,
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
      ...PROVIDER_PROFILE_GENERATION_DEFAULTS,
      id: "profile_1",
      name: "base",
      providerPreset: "openaiCompat",
      coauthorTransport: COAUTHOR_TRANSPORT.chatCompletions,
      generationMode: GENERATION_MODE.chat,
      endpoint: "https://api.test/v1",
      apiKey: "key",
      defaultModel: "gpt-4o",
      contextBudget: 16000,
      pinContextBudget: false,
      tokenPadding: 0,
      bindPerModel: false,
      modelFreeOnly: false,
      modelGroupByOwner: false,
      stopSequences: ["<end>"],
      logitBias: [{ tokenId: 1, bias: 2 }],
      proxyMode: PROXY_MODE.inherit,
      proxyId: null,
      isActive: true,
      visionModel: null,
      generationFormat: null,
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

  test("identity fields keep base values under the ModelSettingsOverlay type invariant", () => {
    const base = makeBase({ name: "base", endpoint: "https://a", defaultModel: "gpt-4o" });
    // Untrusted wire inputs are stripped at the api-contracts boundary
    // (modelSettingsOverlaySchema, tested in provider-schema.test.ts);
    // resolveEffectiveSettings itself assumes a valid ModelSettingsOverlay
    // that omits identity keys (id/name/endpoint/defaultModel).
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
    const rawOverlay: ModelSettingsOverlay = { temperature: 0.7, topP: undefined };
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
