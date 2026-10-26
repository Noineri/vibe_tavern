/**
 * Hydrates the Provider modal's editable form from a stored profile. Pure.
 * Extracted from `ProviderModal.tsx` (arch-gate baseline: extract, never trim);
 * a new profile's context budget starts at {@link NEW_PROFILE_CONTEXT_BUDGET}.
 */
import { GENERATION_MODE, PROVIDER_PROFILE_GENERATION_DEFAULTS as D } from "@vibe-tavern/domain";
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
    typicalP: p.typicalP ?? D.typicalP,
    tfsZ: p.tfsZ ?? D.tfsZ,
    adaptiveTarget: p.adaptiveTarget ?? D.adaptiveTarget,
    adaptiveDecay: p.adaptiveDecay ?? D.adaptiveDecay,
    dynatempRange: p.dynatempRange ?? D.dynatempRange,
    dynatempExponent: p.dynatempExponent ?? D.dynatempExponent,
    topNSigma: p.topNSigma ?? D.topNSigma,
    smoothingFactor: p.smoothingFactor ?? D.smoothingFactor,
    repeatLastN: p.repeatLastN ?? D.repeatLastN,
    dryPenaltyLastN: p.dryPenaltyLastN ?? D.dryPenaltyLastN,
    mirostat: p.mirostat ?? D.mirostat,
    mirostatTau: p.mirostatTau ?? D.mirostatTau,
    mirostatEta: p.mirostatEta ?? D.mirostatEta,
    dryMultiplier: p.dryMultiplier ?? D.dryMultiplier,
    dryBase: p.dryBase ?? D.dryBase,
    dryAllowedLength: p.dryAllowedLength ?? D.dryAllowedLength,
    drySequenceBreakers: p.drySequenceBreakers ?? [...D.drySequenceBreakers],
    xtcThreshold: p.xtcThreshold ?? D.xtcThreshold,
    xtcProbability: p.xtcProbability ?? D.xtcProbability,
    frequencyPenalty: p.frequencyPenalty,
    presencePenalty: p.presencePenalty,
    repetitionPenalty: p.repetitionPenalty,
    ...NOVELAI_SAMPLER_FORM_DEFAULTS, // NAI-1a convoy: wire fields arrive in NAI-1b
    maxTokens: p.maxTokens, contextBudget: p.contextBudget ?? NEW_PROFILE_CONTEXT_BUDGET, pinContextBudget: p.pinContextBudget ?? D.pinContextBudget,
    tokenPadding: p.tokenPadding ?? 0,
    generationMode: p.generationMode ?? GENERATION_MODE.chat,
    bindPerModel: p.bindPerModel ?? false,
    modelFreeOnly: p.modelFreeOnly ?? false,
    modelGroupByOwner: p.modelGroupByOwner ?? false,
    editingModelId: null,
    stopSequences: p.stopSequences,
    bannedStrings: p.bannedStrings ?? [...D.bannedStrings],
    logitBias: p.logitBias ?? [...D.logitBias],
    seed: p.seed ?? D.seed, showReasoning: p.showReasoning,
    reasoningEffort: p.reasoningEffort,
    streamResponse: p.streamResponse,
    customSamplers: p.customSamplers ?? D.customSamplers,
    proxyMode: p.proxyMode ?? "inherit",
    proxyId: p.proxyId ?? null,
    samplerSetId: p.samplerSetId ?? D.samplerSetId,
    generationFormat: p.generationFormat ?? null,
  };
}
