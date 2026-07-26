import { describe, expect, test } from "bun:test";
import { samplerPresetPayloadSchema } from "@vibe-tavern/api-contracts";
import { computeOverlayPatch } from "../hooks/save-provider-patch.js";
import { applySamplerPresetFields, type FormUpdater } from "./sampler-clipboard.js";
import type { FormState } from "../components/modals/ProviderModal.js";
import type { ModelSettingsOverlay } from "@vibe-tavern/domain";

/** Minimal FormState factory — mirrors profileToForm's field set. */
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
