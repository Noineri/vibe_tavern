/**
 * The first-run wizard's provider form seed: `existingProfile?.x ?? <default>`
 * for every field, so a profile that already exists wins and a brand-new one
 * starts from the app-wide defaults. Every generation field the domain
 * constant carries reads {@link PROVIDER_PROFILE_GENERATION_DEFAULTS} (one
 * source — PD-3); the context budget starts at {@link NEW_PROFILE_CONTEXT_BUDGET}.
 * Identity, proxy, `generationMode`, `bindPerModel` and the NovelAI sampler
 * fields are not generation defaults and keep their own values here.
 * Extracted from `SetupWizard.tsx` (arch-gate baseline: extract, never trim).
 */
import { PROVIDER_PROFILE_GENERATION_DEFAULTS as D } from "@vibe-tavern/domain";
import type { ProviderProfileRecord } from "../../api/types.js";
import { NEW_PROFILE_CONTEXT_BUDGET } from "../../lib/new-profile-defaults.js";
import { NOVELAI_SAMPLER_FORM_DEFAULTS } from "../../lib/provider-sampler-values.js";
import type { FormState } from "../modals/ProviderModal.js";

export function buildWizardFormSeed(existingProfile: ProviderProfileRecord | null): FormState {
  return {
    id: existingProfile?.id ?? "",
    name: existingProfile?.name ?? "Default",
    providerPreset: existingProfile?.providerPreset ?? "",
    baseUrl: existingProfile?.endpoint ?? "",
    apiKey: "",
    hasStoredApiKey: !!existingProfile,
    model: existingProfile?.defaultModel ?? "",
    visionModel: existingProfile?.visionModel ?? "",
    temperature: existingProfile?.temperature ?? D.temperature,
    topP: existingProfile?.topP ?? D.topP,
    minP: existingProfile?.minP ?? D.minP,
    topK: existingProfile?.topK ?? D.topK,
    topA: existingProfile?.topA ?? D.topA,
    typicalP: existingProfile?.typicalP ?? D.typicalP,
    tfsZ: existingProfile?.tfsZ ?? D.tfsZ,
    adaptiveTarget: existingProfile?.adaptiveTarget ?? D.adaptiveTarget,
    adaptiveDecay: existingProfile?.adaptiveDecay ?? D.adaptiveDecay,
    dynatempRange: existingProfile?.dynatempRange ?? D.dynatempRange,
    dynatempExponent: existingProfile?.dynatempExponent ?? D.dynatempExponent,
    topNSigma: existingProfile?.topNSigma ?? D.topNSigma,
    smoothingFactor: existingProfile?.smoothingFactor ?? D.smoothingFactor,
    repeatLastN: existingProfile?.repeatLastN ?? D.repeatLastN,
    mirostat: existingProfile?.mirostat ?? D.mirostat,
    mirostatTau: existingProfile?.mirostatTau ?? D.mirostatTau,
    mirostatEta: existingProfile?.mirostatEta ?? D.mirostatEta,
    dryMultiplier: existingProfile?.dryMultiplier ?? D.dryMultiplier,
    dryBase: existingProfile?.dryBase ?? D.dryBase,
    dryAllowedLength: existingProfile?.dryAllowedLength ?? D.dryAllowedLength,
    drySequenceBreakers: existingProfile?.drySequenceBreakers ?? [...D.drySequenceBreakers],
    dryPenaltyLastN: existingProfile?.dryPenaltyLastN ?? D.dryPenaltyLastN,
    xtcThreshold: existingProfile?.xtcThreshold ?? D.xtcThreshold,
    xtcProbability: existingProfile?.xtcProbability ?? D.xtcProbability,
    frequencyPenalty: existingProfile?.frequencyPenalty ?? D.frequencyPenalty,
    presencePenalty: existingProfile?.presencePenalty ?? D.presencePenalty,
    repetitionPenalty: existingProfile?.repetitionPenalty ?? D.repetitionPenalty,
    ...NOVELAI_SAMPLER_FORM_DEFAULTS, // NAI-1a convoy: wire fields arrive in NAI-1b
    maxTokens: existingProfile?.maxTokens ?? D.maxTokens,
    contextBudget: existingProfile?.contextBudget ?? NEW_PROFILE_CONTEXT_BUDGET,
    pinContextBudget: existingProfile?.pinContextBudget ?? D.pinContextBudget,
    tokenPadding: existingProfile?.tokenPadding ?? 0,
    generationMode: existingProfile?.generationMode ?? "chat",
    bindPerModel: existingProfile?.bindPerModel ?? false,
    modelFreeOnly: existingProfile?.modelFreeOnly ?? false,
    modelGroupByOwner: existingProfile?.modelGroupByOwner ?? false,
    editingModelId: null,
    stopSequences: existingProfile?.stopSequences ?? [...D.stopSequences],
    bannedStrings: existingProfile?.bannedStrings ?? [...D.bannedStrings],
    logitBias: existingProfile?.logitBias ?? [...D.logitBias],
    seed: existingProfile?.seed ?? D.seed,
    reasoningEffort: existingProfile?.reasoningEffort ?? D.reasoningEffort,
    showReasoning: existingProfile?.showReasoning ?? D.showReasoning,
    streamResponse: existingProfile?.streamResponse ?? D.streamResponse,
    customSamplers: existingProfile?.customSamplers ?? D.customSamplers,
    proxyMode: existingProfile?.proxyMode ?? "inherit",
    proxyId: existingProfile?.proxyId ?? null,
    samplerSetId: existingProfile?.samplerSetId ?? D.samplerSetId,
    generationFormat: existingProfile?.generationFormat ?? null,
  };
}
