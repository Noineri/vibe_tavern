import { describe, expect, test } from "bun:test";
import { buildFavoriteModelSwitchPatch, computeOverlayPatch, computeSavePatch } from "./save-provider-patch.js";
import type { FormState } from "../components/modals/ProviderModal.js";

/** Minimal FormState factory — override only what matters for the test.
 *  Mirrors the field set the real `profileToForm` produces. */
function makeForm(over: Partial<FormState> = {}): FormState {
  return {
    id: "prov_1", name: "base", providerPreset: "openaiCompat",
    baseUrl: "http://localhost", apiKey: "sk-test", hasStoredApiKey: true,
    model: "gpt-4o", visionModel: "gpt-4o-mini",
    temperature: 0.8, topP: 0.95, minP: 0.05, topK: 40, topA: 0.1,
    typicalP: 1, tfsZ: 1, repeatLastN: 64, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, drySequenceBreakers: ["\n"],
    xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0,
    repetitionPenalty: 1, maxTokens: 4096, contextBudget: 16000,
    pinContextBudget: false, bindPerModel: false, editingModelId: null,
    stopSequences: ["<end>"], logitBias: [], seed: null,
    reasoningEffort: "auto", showReasoning: false, streamResponse: true, customSamplers: false,
    ...over,
  };
}

/**
 * Characterization test for the favorite-model-switch patch builder.
 *
 * This pins the contract for switching the active model from the chat-input
 * starred-models dropdown (`handleSelectFavoriteProviderModel`):
 *  - `defaultModel` is ALWAYS set to the new modelId.
 *  - `contextBudget` is overwritten from the favorite's cached `contextLength`
 *    ONLY when the profile has NOT pinned its budget AND the favorite has a
 *    positive contextLength.
 *
 * The pin rule mirrors the three ProviderModelSelector sites (which gate on
 * `&& !form.pinContextBudget`). Historically the chat-dropdown path did NOT
 * gate, so switching a starred model always reset the budget — the reported
 * "pinned context size resets on model switch" bug. These tests lock the fix.
 */
describe("buildFavoriteModelSwitchPatch", () => {
  test("unpinned + positive contextLength → overwrites contextBudget", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      favorite: { contextLength: 128000 },
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "gpt-4o", contextBudget: 128000 });
  });

  test("pinned + positive contextLength → preserves budget (no overwrite)", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      favorite: { contextLength: 128000 },
      pinContextBudget: true,
    });
    expect(patch).toEqual({ defaultModel: "gpt-4o" });
    expect(patch.contextBudget).toBeUndefined();
  });

  test("unpinned + zero contextLength → no overwrite (guard > 0)", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "claude-3",
      favorite: { contextLength: 0 },
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "claude-3" });
  });

  test("unpinned + null contextLength → no overwrite", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "claude-3",
      favorite: { contextLength: null },
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "claude-3" });
  });

  test("no matching favorite → no overwrite even when unpinned", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "unknown-model",
      favorite: undefined,
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "unknown-model" });
  });

  test("defaultModel is always set regardless of pin/budget state", () => {
    for (const pinContextBudget of [false, true]) {
      const patch = buildFavoriteModelSwitchPatch({
        modelId: "llama-3",
        favorite: { contextLength: 8000 },
        pinContextBudget,
      });
      expect(patch.defaultModel).toBe("llama-3");
    }
  });
});

// ===========================================================================
// Wave 4 — computeSavePatch: bindPerModel is in the base patch
// ===========================================================================

describe("computeSavePatch", () => {
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

  test("pinContextBudget still in the base patch (Wave 0 strip-gap regression)", () => {
    const form = makeForm({ pinContextBudget: true });
    const patch = computeSavePatch(form);
    expect(patch.pinContextBudget).toBe(true);
  });
});

// ===========================================================================
// Wave 4 — computeOverlayPatch: sampler/context only, NEVER identity
// ===========================================================================

describe("computeOverlayPatch", () => {
  test("includes sampler/context fields", () => {
    const form = makeForm({ temperature: 0.3, contextBudget: 8000, maxTokens: 8192 });
    const overlay = computeOverlayPatch(form);
    expect(overlay.temperature).toBe(0.3);
    expect(overlay.contextBudget).toBe(8000);
    expect(overlay.maxTokens).toBe(8192);
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
    expect(overlay).not.toHaveProperty("bindPerModel");
  });

  test("does NOT include customSamplers (profile-level toggle, not overlay)", () => {
    const form = makeForm({ customSamplers: true });
    const overlay = computeOverlayPatch(form);
    expect(overlay).not.toHaveProperty("customSamplers");
  });

  test("includes pinContextBudget (overlay can pin per-model)", () => {
    const form = makeForm({ pinContextBudget: true });
    const overlay = computeOverlayPatch(form);
    expect(overlay.pinContextBudget).toBe(true);
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
