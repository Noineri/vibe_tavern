/**
 * Hydrates the Provider modal's editable form from a stored profile. Pure.
 * Extracted from `ProviderModal.tsx` (arch-gate baseline: extract, never trim);
 * a new profile's context budget starts at {@link NEW_PROFILE_CONTEXT_BUDGET}.
 */
import { GENERATION_MODE } from "@vibe-tavern/domain";
import type { ProviderProfileRecord } from "../../api/types.js";
import { NEW_PROFILE_CONTEXT_BUDGET } from "../../lib/new-profile-defaults.js";
import { NOVELAI_SAMPLER_FORM_DEFAULTS } from "../../lib/provider-sampler-values.js";
import { PROVIDER_PRESETS } from "../../provider-presets.js";
import type { FormState } from "./ProviderModal.js";

export function profileToForm(p: ProviderProfileRecord): FormState {
  const preset = PROVIDER_PRESETS.find((f) => f.id === p.providerPreset)
    ?? PROVIDER_PRESETS.find((f) => f.type === p.providerPreset && f.baseUrl === p.endpoint);
  return {
    id: p.id, name: p.name, providerPreset: preset?.id ?? "",
    baseUrl: p.endpoint, apiKey: "", hasStoredApiKey: p.hasStoredApiKey,
    model: p.defaultModel ?? "", visionModel: p.visionModel ?? "", temperature: p.temperature, topP: p.topP,
    minP: p.minP, topK: p.topK, topA: p.topA,
    typicalP: p.typicalP ?? 1,
    tfsZ: p.tfsZ ?? 1,
    adaptiveTarget: p.adaptiveTarget ?? -1,
    adaptiveDecay: p.adaptiveDecay ?? 0.9,
    dynatempRange: p.dynatempRange ?? 0,
    dynatempExponent: p.dynatempExponent ?? 1,
    topNSigma: p.topNSigma ?? 0,
    smoothingFactor: p.smoothingFactor ?? 0,
    repeatLastN: p.repeatLastN ?? 0,
    dryPenaltyLastN: p.dryPenaltyLastN ?? -1,
    mirostat: p.mirostat ?? 0,
    mirostatTau: p.mirostatTau ?? 5,
    mirostatEta: p.mirostatEta ?? 0.1,
    dryMultiplier: p.dryMultiplier ?? 0,
    dryBase: p.dryBase ?? 1.75,
    dryAllowedLength: p.dryAllowedLength ?? 2,
    drySequenceBreakers: p.drySequenceBreakers ?? [],
    xtcThreshold: p.xtcThreshold ?? 0.1,
    xtcProbability: p.xtcProbability ?? 0,
    frequencyPenalty: p.frequencyPenalty,
    presencePenalty: p.presencePenalty,
    repetitionPenalty: p.repetitionPenalty,
    ...NOVELAI_SAMPLER_FORM_DEFAULTS, // NAI-1a convoy: wire fields arrive in NAI-1b
    maxTokens: p.maxTokens, contextBudget: p.contextBudget ?? NEW_PROFILE_CONTEXT_BUDGET, pinContextBudget: p.pinContextBudget ?? false,
    tokenPadding: p.tokenPadding ?? 0,
    generationMode: p.generationMode ?? GENERATION_MODE.chat,
    bindPerModel: p.bindPerModel ?? false,
    modelFreeOnly: p.modelFreeOnly ?? false,
    modelGroupByOwner: p.modelGroupByOwner ?? false,
    editingModelId: null,
    stopSequences: p.stopSequences,
    bannedStrings: p.bannedStrings ?? [],
    logitBias: p.logitBias ?? [],
    seed: p.seed ?? null, showReasoning: p.showReasoning,
    reasoningEffort: p.reasoningEffort,
    streamResponse: p.streamResponse,
    customSamplers: p.customSamplers ?? false,
    proxyMode: p.proxyMode ?? "inherit",
    proxyId: p.proxyId ?? null,
    samplerSetId: p.samplerSetId ?? null,
    generationFormat: p.generationFormat ?? null,
  };
}
