import { describe, expect, test } from "bun:test";
import { buildFavoriteModelSwitchPatch, computeBindingIdentityPatch, computeOverlayPatch, computeSavePatch, connectionToSavePatch } from "./save-provider-patch.js";
import type { FormState } from "../components/modals/ProviderModal.js";

/** Minimal FormState factory — override only what matters for the test.
 *  Mirrors the field set the real `profileToForm` produces. */
function makeForm(over: Partial<FormState> = {}): FormState {
  return {
    id: "prov_1", name: "base", providerPreset: "openaiCompat",
    baseUrl: "http://localhost", apiKey: "sk-test", hasStoredApiKey: true,
    model: "gpt-4o", visionModel: "gpt-4o-mini",
    temperature: 0.8, topP: 0.95, minP: 0.05, topK: 40, topA: 0.1,
    typicalP: 1, tfsZ: 1, adaptiveTarget: -1, adaptiveDecay: 0.9, dynatempRange: 0, dynatempExponent: 1, topNSigma: 0, smoothingFactor: 0, repeatLastN: 64, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: -1, drySequenceBreakers: ["\n"], bannedStrings: [" finger"],
    xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0,
    repetitionPenalty: 1, unifiedLinear: 1, unifiedQuad: 0, unifiedConf: 0, repetitionPenaltySlope: 0, phraseRepPen: "off", thinkingMode: "auto",
    maxTokens: 4096, contextBudget: 16000,
    pinContextBudget: false, tokenPadding: 0, bindPerModel: false,
    generationMode: "chat",
    modelFreeOnly: false, modelGroupByOwner: false,
    editingModelId: null,
    stopSequences: ["<end>"], logitBias: [], seed: null,
    reasoningEffort: "auto", showReasoning: false, streamResponse: true, customSamplers: false,
    proxyMode: "inherit", proxyId: null,
    samplerSetId: null,
    generationFormat: null,
    ...over,
  };
}

/**
 * Characterization test for the favorite-model-switch patch builder.
 *
 * Pins the contract for switching the active model from the chat-input
 * starred-models dropdown (`handleSelectFavoriteProviderModel`,
 * RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT step 1):
 *  - `defaultModel` is ALWAYS set to the new modelId.
 *  - `overlayOwned` (per-model binding ON + a saved overlay for the chosen
 *    model): model-only patch — the overlay owns that model's generation
 *    values, so the profile base is left untouched.
 *  - otherwise the context budget follows the ONE shared auto-fill rule
 *    (lib/context-autofill.ts, the same derivation the ProviderModelSelector
 *    sites use): a pinned budget is never written; a known LIVE context
 *    length is written; an unknown one keeps the profile's already-set
 *    budget and fills the RP unknown-context fallback (16 000) only when no
 *    budget is set at all (report step 3).
 */
describe("buildFavoriteModelSwitchPatch", () => {
  test("overlayOwned → model-only patch (the overlay is the source, base untouched)", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      contextLength: 128000,
      currentBudget: 32_000,
      pinContextBudget: false,
      overlayOwned: true,
    });
    expect(patch).toEqual({ defaultModel: "gpt-4o" });
  });

  test("overlayOwned wins over the auto-fill rule even when the budget is unpinned", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      contextLength: 200000,
      currentBudget: 32_000,
      pinContextBudget: false,
      overlayOwned: true,
    });
    expect(patch.contextBudget).toBeUndefined();
  });

  test("unpinned + known live contextLength → writes it, over the current budget", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      contextLength: 128000,
      currentBudget: 16_000,
      pinContextBudget: false,
      overlayOwned: false,
    });
    expect(patch).toEqual({ defaultModel: "gpt-4o", contextBudget: 128000 });
  });

  test("unpinned + unknown live contextLength + budget already on the profile → untouched (model-only, report step 3)", () => {
    for (const contextLength of [null, undefined]) {
      const patch = buildFavoriteModelSwitchPatch({
        modelId: "claude-3",
        contextLength,
        currentBudget: 32_000,
        pinContextBudget: false,
        overlayOwned: false,
      });
      expect(patch).toEqual({ defaultModel: "claude-3" });
      expect(patch.contextBudget).toBeUndefined();
    }
  });

  test("unpinned + unknown live contextLength + NO budget on the profile → RP fallback (16 000)", () => {
    for (const contextLength of [null, undefined]) {
      const patch = buildFavoriteModelSwitchPatch({
        modelId: "claude-3",
        contextLength,
        currentBudget: null,
        pinContextBudget: false,
        overlayOwned: false,
      });
      expect(patch).toEqual({ defaultModel: "claude-3", contextBudget: 16000 });
    }
  });

  test("pinned + known contextLength → preserves budget (no overwrite)", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      contextLength: 128000,
      currentBudget: 32_000,
      pinContextBudget: true,
      overlayOwned: false,
    });
    expect(patch).toEqual({ defaultModel: "gpt-4o" });
    expect(patch.contextBudget).toBeUndefined();
  });

  test("defaultModel is always set regardless of pin/overlay state", () => {
    for (const overlayOwned of [false, true]) {
      for (const pinContextBudget of [false, true]) {
        const patch = buildFavoriteModelSwitchPatch({
          modelId: "llama-3",
          contextLength: 8000,
          currentBudget: 32_000,
          pinContextBudget,
          overlayOwned,
        });
        expect(patch.defaultModel).toBe("llama-3");
      }
    }
  });
});

// ===========================================================================
// Wave 4 — computeSavePatch: bindPerModel is in the base patch
// ===========================================================================

describe("computeSavePatch", () => {
  test("carries adaptive-p fields into the save patch (B1: llama.cpp/KoboldCPP)", () => {
    const form = makeForm({ adaptiveTarget: 0.55, adaptiveDecay: 0.75 });
    const patch = computeSavePatch(form);
    expect(patch.adaptiveTarget).toBe(0.55);
    expect(patch.adaptiveDecay).toBe(0.75);
  });

  test("carries the llama-server numeric tail into the save patch (B2)", () => {
    const form = makeForm({ dynatempRange: 1.5, dynatempExponent: 0.8, topNSigma: 0.95, smoothingFactor: 0.7, dryPenaltyLastN: 512 });
    const patch = computeSavePatch(form);
    expect(patch.dynatempRange).toBe(1.5);
    expect(patch.dynatempExponent).toBe(0.8);
    expect(patch.topNSigma).toBe(0.95);
    expect(patch.smoothingFactor).toBe(0.7);
    expect(patch.dryPenaltyLastN).toBe(512);
  });

  test("includes bindPerModel in the base patch (Wave 1 column)", () => {
    const form = makeForm({ bindPerModel: true });
    const patch = computeSavePatch(form);
    expect(patch.bindPerModel).toBe(true);
  });

  test("bindPerModel defaults to false when form says false", () => {
    const form = makeForm({ bindPerModel: false });
    const patch = computeSavePatch(form);
    expect(patch.bindPerModel).toBe(false);
  });

  test("carries tokenPadding into the base patch (LS-1d — profile-level knob)", () => {
    const form = makeForm({ tokenPadding: 250 });
    const patch = computeSavePatch(form);
    expect(patch.tokenPadding).toBe(250);
  });

  test("carries generationMode into the base patch (LS-2a — profile-level, the silent flip)", () => {
    expect(computeSavePatch(makeForm()).generationMode).toBe("chat");
    expect(computeSavePatch(makeForm({ generationMode: "completion" })).generationMode).toBe("completion");
  });

  test("pinContextBudget still in the base patch (Wave 0 strip-gap regression)", () => {
    const form = makeForm({ pinContextBudget: true });
    const patch = computeSavePatch(form);
    expect(patch.pinContextBudget).toBe(true);
  });

  test("preserves an explicit named proxy policy and clears stale IDs for inherit/direct", () => {
    expect(computeSavePatch(makeForm({ proxyMode: "proxy", proxyId: "proxy_1" }))).toMatchObject({ proxyMode: "proxy", proxyId: "proxy_1" });
    expect(computeSavePatch(makeForm({ proxyMode: "direct", proxyId: "proxy_1" }))).toMatchObject({ proxyMode: "direct", proxyId: null });
    expect(computeSavePatch(makeForm({ proxyMode: "inherit", proxyId: "proxy_1" }))).toMatchObject({ proxyMode: "inherit", proxyId: null });
  });
});

describe("connectionToSavePatch", () => {
  test("does not reset an existing profile's proxy policy through the legacy connection save path", () => {
    const connection = {
      providerLabel: "Primary",
      providerType: "openai_compat",
      baseUrl: "https://provider.example/v1",
      apiKey: "",
      model: "model",
      visionModel: "",
      activeProviderProfileId: "provider_1",
      hasStoredApiKey: true,
      status: "connected",
      error: "",
      models: [],
      providerPreset: "openai",
      temperature: 1,
      topP: 1,
      minP: 0,
      topK: 0,
      topA: 0,
      repetitionPenalty: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 2048,
      stopSequences: [],
      seed: null,
      reasoningEffort: "auto",
      showReasoning: false,
      streamResponse: true,
      customSamplers: false,
    } satisfies Parameters<typeof connectionToSavePatch>[0];

    const patch = connectionToSavePatch(connection);
    expect("proxyMode" in patch).toBe(false);
    expect("proxyId" in patch).toBe(false);
  });
});

// ===========================================================================
// Wave 4 — computeOverlayPatch: sampler/context only, NEVER identity
// ===========================================================================

describe("computeOverlayPatch", () => {
  test("includes sampler/context fields", () => {
    const form = makeForm({ temperature: 0.3, contextBudget: 8000, maxTokens: 8192, adaptiveTarget: 0.6, adaptiveDecay: 0.8, dynatempRange: 1.5, dryPenaltyLastN: 512 });
    const overlay = computeOverlayPatch(form);
    expect(overlay.temperature).toBe(0.3);
    expect(overlay.contextBudget).toBe(8000);
    expect(overlay.maxTokens).toBe(8192);
    expect(overlay.adaptiveTarget).toBe(0.6);
    expect(overlay.adaptiveDecay).toBe(0.8);
    expect(overlay.dynatempRange).toBe(1.5);
    expect(overlay.dryPenaltyLastN).toBe(512);
  });

  test("NEVER includes identity fields (name/endpoint/apiKey/defaultModel/visionModel)", () => {
    const form = makeForm();
    const overlay = computeOverlayPatch(form);
    // ModelSettingsOverlay is Partial<Pick<StoredProviderProfileRecord, ...>>;
    // identity fields are not in the Pick. Assert they're absent as a safety
    // net — the backend schema strips them too, but keeping them out at the
    // source makes intent explicit.
    expect(overlay).not.toHaveProperty("name");
    expect(overlay).not.toHaveProperty("endpoint");
    expect(overlay).not.toHaveProperty("apiKey");
    expect(overlay).not.toHaveProperty("defaultModel");
    expect(overlay).not.toHaveProperty("visionModel");
    expect(overlay).not.toHaveProperty("providerPreset");
    // tokenPadding (LS-1d) is profile-level — the chat-template overhead it
    // compensates for is a property of the connection, not the model — so it
    // must NEVER route into a per-model overlay.
    expect(overlay).not.toHaveProperty("tokenPadding");
    // generationMode (LS-2a) is likewise profile-level — the connection's
    // mode, not a bound model's.
    expect(overlay).not.toHaveProperty("generationMode");
    expect(overlay).not.toHaveProperty("bindPerModel");
  });

  test("includes customSamplers (per-model toggle for advanced samplers)", () => {
    const form = makeForm({ customSamplers: true });
    const overlay = computeOverlayPatch(form);
    expect(overlay.customSamplers).toBe(true);
  });

  test("includes pinContextBudget (overlay can pin per-model)", () => {
    const form = makeForm({ pinContextBudget: true });
    const overlay = computeOverlayPatch(form);
    expect(overlay.pinContextBudget).toBe(true);
  });

  test("carries the per-model sampler-set pointer (IG-CF15 LLM twin — the set is THIS model's provenance)", () => {
    const form = makeForm({ samplerSetId: "sset_a" });
    const overlay = computeOverlayPatch(form);
    expect(overlay.samplerSetId).toBe("sset_a");
    // No set picked for this model → explicit null ("no set"), not base inheritance.
    const bare = computeOverlayPatch(makeForm({ samplerSetId: null }));
    expect(bare.samplerSetId).toBeNull();
  });

  test("contextBudget null when form has 0/empty budget", () => {
    const form = makeForm({ contextBudget: 0 });
    const overlay = computeOverlayPatch(form);
    expect(overlay.contextBudget).toBeNull();
  });

  test("array fields (stopSequences, logitBias, drySequenceBreakers) are snapshotted", () => {
    const form = makeForm({ stopSequences: ["\\n\nUser:"], drySequenceBreakers: ["\n"] });
    const overlay = computeOverlayPatch(form);
    expect(overlay.stopSequences).toEqual(["\\n\nUser:"]);
    expect(overlay.drySequenceBreakers).toEqual(["\n"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Overlay-mode base routing: computeBindingIdentityPatch — the base half of the
// split (what an overlay save still writes to the profile row).
// ────────────────────────────────────────────────────────────────────────

describe("computeBindingIdentityPatch", () => {
  test("overlay-mode base write keeps identity + proxy + format, drops sampler fields AND the set pointer", () => {
    const basePatch = computeSavePatch(makeForm({
      temperature: 0.9,
      contextBudget: 12000,
      samplerSetId: "sset_b",
    }));
    const identity = computeBindingIdentityPatch(basePatch);
    // Identity survives on the base.
    expect(identity.name).toBe(basePatch.name);
    expect(identity.defaultModel).toBe(basePatch.defaultModel);
    expect(identity.bindPerModel).toBe(basePatch.bindPerModel);
    // The sampler payload and the set POINTER never touch the base in overlay
    // mode (owner ruling 2026-09-27: the set is per-model; the base pointer is
    // the binding-off fallback and stays put).
    expect(identity).not.toHaveProperty("temperature");
    expect(identity).not.toHaveProperty("contextBudget");
    expect(identity).not.toHaveProperty("samplerSetId");
    // Profile-level chrome that must survive overlay saves still rides along.
    expect(identity.generationFormat).toBe(basePatch.generationFormat);
  });
});
