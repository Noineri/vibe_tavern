/**
 * Pure hydration logic for provider profile → connection state.
 *
 * computeHydration:  profiles + current state → hydration plan  (no side effects)
 * applyHydration:    plan → patch store, persist vision model, probe  (all side effects)
 *
 * Separating these makes the data path trivially testable and debuggable:
 *   • If visionModel is wrong after hydration, check computeHydration output.
 *   • If the DB write fails, check applyHydration.
 */

import type { ConnectionState } from "../components/layout/app-shell-types.js";
import type { ProviderProfileRecord } from "../api/types.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { PROVIDER_TYPE } from "@vibe-tavern/domain";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HydrationPlan {
  /** The active profile that will be hydrated. null if none found. */
  profileId: string | null;

  /** Patch to apply to ConnectionState. null if no active profile. */
  connectionPatch: Partial<ConnectionState> | null;

  /** Cached models to load into connection (separate from main patch for clarity). */
  cachedModels: Array<{
    id: string;
    label: string;
    contextLength?: number;
    capabilities?: { thinking?: boolean; tools?: boolean; vision?: boolean };
  }> | null;

  /** Auto-detected vision model that should be persisted to DB. null = skip. */
  autoWriteVision: { profileId: string; modelId: string } | null;

  /** Whether a network probe should be fired for this profile. */
  shouldProbe: boolean;
}

// ─── Pure computation ─────────────────────────────────────────────────────────

/**
 * Given all provider profiles and the set of already-probed profile IDs,
 * compute what needs to happen.  Zero side effects.
 */
export function computeHydration(
  profiles: ProviderProfileRecord[],
  alreadyProbedIds: Set<string>,
): HydrationPlan {
  const activeProfile = profiles.find((p) => p.isActive) ?? null;

  if (!activeProfile) {
    return { profileId: null, connectionPatch: null, cachedModels: null, autoWriteVision: null, shouldProbe: false };
  }

  const connectionPatch: Partial<ConnectionState> = {
    providerLabel: activeProfile.name,
    baseUrl: normalizeOpenAiCompatibleBaseUrl(activeProfile.endpoint),
    apiKey: "",
    model: activeProfile.defaultModel ?? "",
    visionModel: activeProfile.visionModel ?? "",
    activeProviderProfileId: activeProfile.id,
    hasStoredApiKey: activeProfile.hasStoredApiKey,
    models: [],
    status: activeProfile.defaultModel ? "connected" : "idle",
    error: "",
    providerType: activeProfile.providerPreset || PROVIDER_TYPE.openaiCompat,
    providerPreset: "",
    temperature: activeProfile.temperature,
    topP: activeProfile.topP,
    minP: activeProfile.minP,
    topK: activeProfile.topK,
    topA: activeProfile.topA,
    frequencyPenalty: activeProfile.frequencyPenalty,
    presencePenalty: activeProfile.presencePenalty,
    repetitionPenalty: activeProfile.repetitionPenalty,
    maxTokens: activeProfile.maxTokens,
    stopSequences: activeProfile.stopSequences,
    seed: activeProfile.seed ?? null,
    reasoningEffort: activeProfile.reasoningEffort,
    showReasoning: activeProfile.showReasoning,
    streamResponse: activeProfile.streamResponse,
  };

  // Cached models
  const cached = activeProfile.cachedModels;
  const cachedModels = cached && cached.models.length > 0 ? cached.models : null;

  // Auto-detect vision model from capabilities
  let autoWriteVision: HydrationPlan["autoWriteVision"] = null;
  if (cachedModels && !activeProfile.visionModel) {
    const visionModels = cachedModels.filter((m) => m.capabilities?.vision);
    const nonAllVision = visionModels.length > 0 && visionModels.length < cachedModels.length;
    if (nonAllVision) {
      autoWriteVision = { profileId: activeProfile.id, modelId: visionModels[0]!.id };
    }
  }

  // Probe on first hydration only (skip if already probed or no model)
  const shouldProbe = !!activeProfile.defaultModel && !alreadyProbedIds.has(activeProfile.id);

  console.log("[Hydrate] computeHydration:", {
    profileId: activeProfile.id,
    name: activeProfile.name,
    defaultModel: activeProfile.defaultModel,
    visionModel_in: activeProfile.visionModel,
    visionModel_patch: connectionPatch.visionModel,
    autoWriteVision: autoWriteVision?.modelId ?? "(skip)",
    cachedModelsCount: cachedModels?.length ?? 0,
    shouldProbe,
  });

  return { profileId: activeProfile.id, connectionPatch, cachedModels, autoWriteVision, shouldProbe };
}
