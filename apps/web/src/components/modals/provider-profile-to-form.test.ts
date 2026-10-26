/**
 * PD-3b pin — `profileToForm` falls back to the one domain source: a stored
 * profile whose optional sampler fields are all absent hydrates the form with
 * PROVIDER_PROFILE_GENERATION_DEFAULTS for those 25 fields (arrays as copies),
 * and a stored value always wins over the fallback.
 */
import { describe, expect, it } from "bun:test";

import { PROVIDER_PROFILE_GENERATION_DEFAULTS as D } from "@vibe-tavern/domain";
import type { ProviderProfileRecord } from "../../api/types.js";
import { profileToForm } from "./provider-profile-to-form.js";

const FALLBACK_FIELDS = [
  "typicalP", "tfsZ", "adaptiveTarget", "adaptiveDecay", "dynatempRange", "dynatempExponent",
  "topNSigma", "smoothingFactor", "repeatLastN", "dryPenaltyLastN", "mirostat", "mirostatTau",
  "mirostatEta", "dryMultiplier", "dryBase", "dryAllowedLength", "drySequenceBreakers",
  "xtcThreshold", "xtcProbability", "pinContextBudget", "bannedStrings", "logitBias", "seed",
  "customSamplers", "samplerSetId",
] as const;

/** A stored profile carrying only the required fields — every fallback field absent. */
function bareProfile(): ProviderProfileRecord {
  return {
    id: "p1", name: "Bare", providerPreset: "", endpoint: "http://localhost:1234/v1", hasStoredApiKey: false,
    temperature: 0.8, topP: 0.9, minP: 0.05, topK: 40, topA: 0,
    frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
    maxTokens: 1234, stopSequences: [], showReasoning: false, reasoningEffort: "auto", streamResponse: true,
  } as unknown as ProviderProfileRecord;
}

describe("profileToForm domain fallbacks (PD-3b)", () => {
  it("yields the domain constant's values for the 25 optional sampler fields when they are absent", () => {
    const form = profileToForm(bareProfile()) as unknown as Record<string, unknown>;
    expect(FALLBACK_FIELDS).toHaveLength(25);
    for (const field of FALLBACK_FIELDS) {
      expect([field, form[field]]).toEqual([field, D[field]]);
    }
  });

  it("hands out copies of the constant's arrays", () => {
    const form = profileToForm(bareProfile());
    expect(form.drySequenceBreakers).not.toBe(D.drySequenceBreakers);
    expect(form.bannedStrings).not.toBe(D.bannedStrings);
    expect(form.logitBias).not.toBe(D.logitBias);
  });

  it("keeps a stored value over the fallback", () => {
    const form = profileToForm({
      ...bareProfile(), typicalP: 0.5, mirostat: 2, seed: "42", customSamplers: true, samplerSetId: "set1", bannedStrings: ["x"],
    } as unknown as ProviderProfileRecord);
    expect(form.typicalP).toBe(0.5);
    expect(form.mirostat).toBe(2);
    expect(form.seed).toBe("42");
    expect(form.customSamplers).toBe(true);
    expect(form.samplerSetId).toBe("set1");
    expect(form.bannedStrings).toEqual(["x"]);
  });
});
