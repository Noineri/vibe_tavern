import { describe, expect, test } from "bun:test";
import { samplerPresetPayloadSchema } from "@vibe-tavern/api-contracts";
import { computeOverlayPatch } from "../hooks/save-provider-patch.js";
import { applySamplerPresetFields, filterOverlayByCapabilities, overlayDivergesFromSet, type FormUpdater } from "./sampler-clipboard.js";
import type { FormState } from "../components/modals/ProviderModal.js";
import type { ModelSettingsOverlay } from "@vibe-tavern/domain";

/** Minimal FormState factory — mirrors profileToForm's field set. */
function makeForm(over: Partial<FormState> = {}): FormState {
  return {
    id: "prov_1", name: "base", providerPreset: "openaiCompat",
    baseUrl: "http://localhost", apiKey: "sk-test", hasStoredApiKey: true,
    model: "gpt-4o", visionModel: "gpt-4o-mini",
    temperature: 0.8, topP: 0.95, minP: 0.05, topK: 40, topA: 0.1,
    typicalP: 1, tfsZ: 1, adaptiveTarget: -1, adaptiveDecay: 0.9, dynatempRange: 0, dynatempExponent: 1, topNSigma: 0, smoothingFactor: 0, repeatLastN: 64, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: -1, drySequenceBreakers: ["\n"], bannedStrings: [" finger"],
    xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0,
    repetitionPenalty: 1, maxTokens: 4096, contextBudget: 16000,
    pinContextBudget: false, tokenPadding: 0, bindPerModel: false,
    generationMode: "chat",
    modelFreeOnly: false, modelGroupByOwner: false,
    editingModelId: null,
    stopSequences: ["<end>"], logitBias: [], seed: null,
    reasoningEffort: "auto", showReasoning: false, streamResponse: true, customSamplers: false,
    ...over,
    proxyMode: over.proxyMode ?? "inherit",
    proxyId: over.proxyId ?? null,
    samplerSetId: null,
    generationFormat: null,
  };
}

/** Build an updateForm that records every call into a target form object. */
function recordingUpdater(form: FormState): { updater: FormUpdater; form: FormState } {
  const target = { ...form };
  const updater: FormUpdater = (k, v) => {
    (target as Record<string, unknown>)[k as string] = v;
  };
  return { updater, form: target };
}

describe("sampler clipboard round-trip", () => {
  test("serialize → JSON → parse → apply reproduces the original sampler fields", () => {
    const original = makeForm({
      temperature: 0.42, topP: 0.88, topK: 55, minP: 0.07,
      maxTokens: 8192, contextBudget: 32000, pinContextBudget: true,
      stopSequences: ["\\n\\nUser:", "STOP"], seed: "12345",
      repetitionPenalty: 1.2, frequencyPenalty: 0.3,
      reasoningEffort: "high", showReasoning: true,
    });

    // ── Copy direction: form → payload → JSON ──
    const payload = computeOverlayPatch(original);
    const json = JSON.stringify(payload);

    // ── Paste direction: JSON → parse → apply ──
    const parsed = samplerPresetPayloadSchema.safeParse(JSON.parse(json));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { updater, form: target } = recordingUpdater(makeForm());
    applySamplerPresetFields(parsed.data as Partial<ModelSettingsOverlay>, updater);

    // Sampler/context fields reproduce the original.
    expect(target.temperature).toBe(0.42);
    expect(target.topP).toBe(0.88);
    expect(target.topK).toBe(55);
    expect(target.minP).toBe(0.07);
    expect(target.maxTokens).toBe(8192);
    expect(target.contextBudget).toBe(32000);
    expect(target.pinContextBudget).toBe(true);
    expect(target.stopSequences).toEqual(["\\n\\nUser:", "STOP"]);
    expect(target.seed).toBe("12345");
    expect(target.repetitionPenalty).toBe(1.2);
    expect(target.frequencyPenalty).toBe(0.3);
    expect(target.reasoningEffort).toBe("high");
    expect(target.showReasoning).toBe(true);
  });

  test("adaptive-p fields round-trip through the clipboard (copy → schema → apply)", () => {
    const original = makeForm({ adaptiveTarget: 0.55, adaptiveDecay: 0.75 });
    const payload = computeOverlayPatch(original);
    const parsed = samplerPresetPayloadSchema.safeParse(JSON.parse(JSON.stringify(payload)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { updater, form: target } = recordingUpdater(makeForm());
    applySamplerPresetFields(parsed.data as Partial<ModelSettingsOverlay>, updater);
    expect(target.adaptiveTarget).toBe(0.55);
    expect(target.adaptiveDecay).toBe(0.75);
  });

  test("llama-server numeric tail fields round-trip through the clipboard (B2)", () => {
    const original = makeForm({ dynatempRange: 1.5, dynatempExponent: 0.8, topNSigma: 0.95, smoothingFactor: 0.7, dryPenaltyLastN: 512 });
    const payload = computeOverlayPatch(original);
    const parsed = samplerPresetPayloadSchema.safeParse(JSON.parse(JSON.stringify(payload)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { updater, form: target } = recordingUpdater(makeForm());
    applySamplerPresetFields(parsed.data as Partial<ModelSettingsOverlay>, updater);
    expect(target.dynatempRange).toBe(1.5);
    expect(target.dynatempExponent).toBe(0.8);
    expect(target.topNSigma).toBe(0.95);
    expect(target.smoothingFactor).toBe(0.7);
    expect(target.dryPenaltyLastN).toBe(512);
  });

  test("bannedStrings round-trip through the clipboard (B3, leading spaces kept)", () => {
    const original = makeForm({ bannedStrings: [" finger", " purr"] });
    const payload = computeOverlayPatch(original);
    const parsed = samplerPresetPayloadSchema.safeParse(JSON.parse(JSON.stringify(payload)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { updater, form: target } = recordingUpdater(makeForm());
    applySamplerPresetFields(parsed.data as Partial<ModelSettingsOverlay>, updater);
    expect(target.bannedStrings).toEqual([" finger", " purr"]);
  });

  test("malformed JSON is rejected before reaching the schema", () => {
    const bad = "{not valid json";
    expect(() => JSON.parse(bad)).toThrow(SyntaxError);
  });

  test("wrong-shape JSON (array instead of object) is rejected by the schema", () => {
    const parsed = samplerPresetPayloadSchema.safeParse([1, 2, 3]);
    expect(parsed.success).toBe(false);
  });

  test("field with wrong type (temperature as string) is rejected", () => {
    const parsed = samplerPresetPayloadSchema.safeParse({ temperature: "hot" });
    expect(parsed.success).toBe(false);
  });

  test("partial payload — only applies present fields, leaves others untouched", () => {
    const { updater, form: target } = recordingUpdater(makeForm({ temperature: 0.9, topP: 0.5 }));
    // Only temperature in the payload; topP stays at the form's 0.5.
    applySamplerPresetFields({ temperature: 0.1 }, updater);
    expect(target.temperature).toBe(0.1);
    expect(target.topP).toBe(0.5); // untouched
  });

  test("empty object payload — nothing changes", () => {
    const original = makeForm({ temperature: 0.7 });
    const { updater, form: target } = recordingUpdater(original);
    applySamplerPresetFields({}, updater);
    expect(target.temperature).toBe(0.7);
  });

  test("identity fields in a payload are ignored by apply (they're not in the field list)", () => {
    // A malicious or stale clipboard blob might include name/endpoint.
    // The schema strips them (identity fields not in modelSettingsOverlaySchema),
    // but even if they slip through, applySamplerPresetFields doesn't touch them.
    const { updater, form: target } = recordingUpdater(makeForm({ name: "my-profile" }));
    applySamplerPresetFields(
      { temperature: 0.5, name: "hacked" } as unknown as Partial<ModelSettingsOverlay>,
      updater,
    );
    expect(target.temperature).toBe(0.5);
    expect(target.name).toBe("my-profile"); // unchanged — name is not in the apply list
  });

  test("null-valued optional fields (seed, contextBudget) are applied, not skipped", () => {
    const original = makeForm({ seed: "abc", contextBudget: 8000 });
    const { updater, form: target } = recordingUpdater(original);
    // Explicit null = "unset" signal from the preset.
    applySamplerPresetFields({ seed: null, contextBudget: null }, updater);
    expect(target.seed).toBeNull();
    expect(target.contextBudget).toBe(0); // form's contextBudget is number; null→0 fallback
  });
});

// ── Sampler-set engine semantics (LOCAL_SUPPORT_PLAN LS-5e/f) ─────────────────
// The clipboard trio IS the set engine: these tests pin the two helpers the
// set row added on top of the copy/paste boundary — per-protocol capability
// filtering ON APPLY (unsupported values never enter the form) and the dirty-
// dot divergence check (applied baseline vs the current extract).

describe("filterOverlayByCapabilities (LS-5f apply filtering)", () => {
  test("drops sampler fields the protocol does not support, keeps the rest", async () => {
    const { resolveSamplerCapabilities } = await import("@vibe-tavern/domain");
    const openaiCaps = resolveSamplerCapabilities("openai", "openai_compat");
    // The openai_compat surface has no DRY / mirostat / adaptive-p / dynatemp.
    const filtered = filterOverlayByCapabilities(
      {
        temperature: 0.9,
        topP: 0.8,
        dryMultiplier: 0.8,
        drySequenceBreakers: ["\\n"],
        mirostat: 2,
        adaptiveTarget: 0.5,
        dynatempRange: 1.5,
      },
      (field) => openaiCaps[field],
    );
    expect(filtered.temperature).toBe(0.9);
    expect(filtered.topP).toBe(0.8);
    expect(filtered.dryMultiplier).toBeUndefined();
    expect(filtered.drySequenceBreakers).toBeUndefined();
    expect(filtered.mirostat).toBeUndefined();
    expect(filtered.adaptiveTarget).toBeUndefined();
    expect(filtered.dynatempRange).toBeUndefined();
  });

  test("passes through non-capability overlay keys untouched (contextBudget, maxTokens, pinContextBudget)", async () => {
    // A supports() that rejects EVERYTHING still must not swallow the keys
    // that render on every protocol (anything in SamplerFieldId — including
    // seed and stopSequences — is capability-gated; these are not).
    const filtered = filterOverlayByCapabilities(
      { contextBudget: 32000, maxTokens: 8192, pinContextBudget: true, seed: "123", temperature: 0.5 },
      () => false,
    );
    expect(filtered.contextBudget).toBe(32000);
    expect(filtered.maxTokens).toBe(8192);
    expect(filtered.pinContextBudget).toBe(true);
    expect(filtered.seed).toBeUndefined();
    expect(filtered.temperature).toBeUndefined();
  });

  test("an all-capable protocol passes the payload through unchanged", async () => {
    const payload = { temperature: 1.31, topK: 49, drySequenceBreakers: ["\\n"], bannedStrings: [" finger"] };
    const filtered = filterOverlayByCapabilities(payload, () => true);
    expect(filtered).toEqual(payload);
  });
});

describe("overlayDivergesFromSet (LS-5 dirty dot)", () => {
  test("equal values → not dirty; any diverged baseline field → dirty", () => {
    const baseline = { temperature: 1.31, topK: 49 };
    expect(overlayDivergesFromSet(baseline, { temperature: 1.31, topK: 49 })).toBe(false);
    expect(overlayDivergesFromSet(baseline, { temperature: 0.9, topK: 49 })).toBe(true);
    expect(overlayDivergesFromSet(baseline, { temperature: 1.31, topK: 55 })).toBe(true);
  });

  test("fields the set never carried do not count as divergence", () => {
    // The user tweaked a knob the set doesn't store — the dot must NOT light.
    expect(overlayDivergesFromSet({ temperature: 1.31 }, { temperature: 1.31, topK: 49, topP: 0.3 })).toBe(false);
  });

  test("undefined baseline field vs a defined current value counts as divergence (revert case)", () => {
    // 💾 stores the full overlay extract; a baseline field that is undefined
    // while the form carries a value means the user changed it away from the
    // (capability-filtered) set value.
    expect(overlayDivergesFromSet({ topK: undefined }, { topK: 40 })).toBe(true);
  });

  test("array fields compare element-wise, order-sensitive (drySequenceBreakers)", () => {
    expect(overlayDivergesFromSet({ drySequenceBreakers: ["\\n", ":"] }, { drySequenceBreakers: ["\\n", ":"] })).toBe(false);
    expect(overlayDivergesFromSet({ drySequenceBreakers: ["\\n", ":"] }, { drySequenceBreakers: [":", "\\n"] })).toBe(true);
  });

  test("the panel round-trip: apply → diverge → re-apply clears the dot", async () => {
    const { samplerPresetPayloadSchema } = await import("@vibe-tavern/api-contracts");
    const payload = { temperature: 1.31, topP: 0.14, topK: 49 };
    const parsed = samplerPresetPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { updater, form: target } = recordingUpdater(makeForm());
    // Apply (copy-on-select).
    applySamplerPresetFields(parsed.data as Partial<ModelSettingsOverlay>, updater);
    expect(overlayDivergesFromSet(parsed.data as Partial<ModelSettingsOverlay>, target as unknown as ModelSettingsOverlay)).toBe(false);

    // The user nudges a knob → dirty.
    target.temperature = 0.5;
    expect(overlayDivergesFromSet(parsed.data as Partial<ModelSettingsOverlay>, target as unknown as ModelSettingsOverlay)).toBe(true);

    // Re-select / 🔄 (re-apply) → the dot clears.
    target.temperature = 1.31;
    expect(overlayDivergesFromSet(parsed.data as Partial<ModelSettingsOverlay>, target as unknown as ModelSettingsOverlay)).toBe(false);
  });
});
