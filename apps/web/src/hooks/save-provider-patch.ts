/**
 * Pure save-patch computation for provider profile form → API PATCH payload.
 *
 * computeSavePatch:  FormState → patch object for updateProviderProfileAction  (no side effects)
 *
 * This is the WRITE counterpart to computeHydration (the READ path).
 * Every mutable field in FormState maps 1:1 to a field in the patch.
 * If a field appears in FormState but NOT in the patch, it will silently be dropped on save.
 *
 * Usage:
 *   const patch = computeSavePatch(form);
 *   await updateProviderProfileAction(form.id, patch);
 */

import type { ConnectionState } from "../components/layout/app-shell-types.js";
import type { FormState } from "../components/modals/ProviderModal.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { PROVIDER_TYPE, type ModelSettingsOverlay } from "@vibe-tavern/domain";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Fields that go into updateProviderProfileAction / saveProviderProfileAction. */
export interface ProviderSavePatch {
  name: string;
  providerPreset: string;
  endpoint: string;
  apiKey: string | undefined;
  defaultModel: string | null;
  visionModel: string | null;
  contextBudget: number | null;
  pinContextBudget: boolean;
  bindPerModel: boolean;
  temperature: number;
  topP: number;
  minP: number;
  topK: number;
  topA: number;
  typicalP: number;
  tfsZ: number;
  repeatLastN: number;
  mirostat: number;
  mirostatTau: number;
  mirostatEta: number;
  dryMultiplier: number;
  dryBase: number;
  dryAllowedLength: number;
  drySequenceBreakers: string[];
  xtcThreshold: number;
  xtcProbability: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  maxTokens: number;
  stopSequences: string[];
  logitBias: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed: string | null;
  reasoningEffort: string;
  showReasoning: boolean;
  streamResponse: boolean;
  customSamplers: boolean;
}

// ─── Pure computation ─────────────────────────────────────────────────────────

/**
 * Convert a FormState into the exact patch object sent to the API.
 * Zero side effects.  All fields explicit — if FormState gains a new field,
 * TypeScript will error here until it's mapped.
 */
export function computeSavePatch(form: FormState): ProviderSavePatch {
  const apiKeyInput = form.apiKey.trim();

  const patch: ProviderSavePatch = {
    name: form.name.trim(),
    providerPreset: form.providerPreset,
    endpoint: form.baseUrl.trim(),
    apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
    defaultModel: form.model.trim() || null,
    visionModel: form.visionModel.trim() || null,
    contextBudget: form.contextBudget || null,
    pinContextBudget: form.pinContextBudget,
    bindPerModel: form.bindPerModel,
    temperature: form.temperature,
    topP: form.topP,
    minP: form.minP,
    topK: form.topK,
    topA: form.topA,
    typicalP: form.typicalP,
    tfsZ: form.tfsZ,
    repeatLastN: form.repeatLastN,
    mirostat: form.mirostat,
    mirostatTau: form.mirostatTau,
    mirostatEta: form.mirostatEta,
    dryMultiplier: form.dryMultiplier,
    dryBase: form.dryBase,
    dryAllowedLength: form.dryAllowedLength,
    drySequenceBreakers: form.drySequenceBreakers,
    xtcThreshold: form.xtcThreshold,
    xtcProbability: form.xtcProbability,
    frequencyPenalty: form.frequencyPenalty,
    presencePenalty: form.presencePenalty,
    repetitionPenalty: form.repetitionPenalty,
    maxTokens: form.maxTokens,
    stopSequences: form.stopSequences,
    logitBias: form.logitBias,
    seed: form.seed,
    reasoningEffort: form.reasoningEffort,
    showReasoning: form.showReasoning,
    streamResponse: form.streamResponse,
    customSamplers: form.customSamplers,
  };

  console.log("[Save] computeSavePatch:", {
    id: form.id,
    defaultModel: patch.defaultModel,
    visionModel: patch.visionModel,
    fields: Object.keys(patch).join(","),
  });

  return patch;
}

/**
 * Validate a save patch by checking required fields.
 * Returns null if valid, or an error message string.
 */
export function validateSavePatch(patch: ProviderSavePatch): string | null {
  if (!patch.name) return "Name is required";
  if (!patch.endpoint) return "Endpoint is required";
  return null;
}

/**
 * Build the per-model overlay payload from a form in overlay-edit mode.
 *
 * Emits a {@link ModelSettingsOverlay}: the sampler/context field set that a
 * bound model may override. IDENTITY FIELDS (name, endpoint, apiKey,
 * defaultModel, visionModel, providerPreset) are NEVER included — a model's
 * overlay cannot rename or rebind the profile. The backend's
 * `modelSettingsOverlaySchema` (Wave 2) also strips any identity fields that
 * sneak through, but keeping them out at the source makes the intent explicit
 * and keeps the payload small.
 *
 * Every field below maps 1:1 to the overlay's optional fields. An absent field
 * on the overlay means "inherit the profile base" at generation time (see
 * `resolveEffectiveSettings`). We always emit every field the form owns — the
 * merge is field-wise, so this is a full snapshot of the bound model's sampler
 * config, not a delta.
 *
 * Pure — no side effects. Caller persists via
 * `upsertProviderModelSettingsAction(profileId, modelId, computeOverlayPatch(form))`.
 */
export function computeOverlayPatch(form: FormState): ModelSettingsOverlay {
  const overlay: ModelSettingsOverlay = {
    temperature: form.temperature,
    topP: form.topP,
    minP: form.minP,
    topK: form.topK,
    topA: form.topA,
    typicalP: form.typicalP,
    tfsZ: form.tfsZ,
    repeatLastN: form.repeatLastN,
    mirostat: form.mirostat,
    mirostatTau: form.mirostatTau,
    mirostatEta: form.mirostatEta,
    dryMultiplier: form.dryMultiplier,
    dryBase: form.dryBase,
    dryAllowedLength: form.dryAllowedLength,
    drySequenceBreakers: form.drySequenceBreakers,
    xtcThreshold: form.xtcThreshold,
    xtcProbability: form.xtcProbability,
    frequencyPenalty: form.frequencyPenalty,
    presencePenalty: form.presencePenalty,
    repetitionPenalty: form.repetitionPenalty,
    maxTokens: form.maxTokens,
    contextBudget: form.contextBudget || null,
    pinContextBudget: form.pinContextBudget,
    stopSequences: form.stopSequences,
    logitBias: form.logitBias,
    seed: form.seed,
    reasoningEffort: form.reasoningEffort,
    showReasoning: form.showReasoning,
    streamResponse: form.streamResponse,
  };
  return overlay;
}

/**
 * Convert a ConnectionState into the exact patch object sent to the API.
 * Used by handleConnect / handleSaveProviderProfile (legacy connection-based saves).
 *
 * Zero side effects. Every field from ConnectionState that maps to a profile field
 * is included — if one is missing, TypeScript will catch it.
 */
export function connectionToSavePatch(conn: ConnectionState): ProviderSavePatch {
  const apiKeyInput = conn.apiKey.trim();

  const patch: ProviderSavePatch = {
    name: conn.providerLabel.trim(),
    providerPreset: conn.providerType || PROVIDER_TYPE.openaiCompat,
    endpoint: normalizeOpenAiCompatibleBaseUrl(conn.baseUrl),
    apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
    defaultModel: conn.model.trim() || null,
    visionModel: conn.visionModel.trim() || null,
    contextBudget: conn.maxTokens || null,
    pinContextBudget: false,  // not in ConnectionState yet
    bindPerModel: false,  // not in ConnectionState yet
    temperature: conn.temperature,
    topP: conn.topP,
    minP: conn.minP,
    topK: conn.topK,
    topA: conn.topA ?? 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: conn.frequencyPenalty,
    presencePenalty: conn.presencePenalty,
    repetitionPenalty: conn.repetitionPenalty,
    maxTokens: conn.maxTokens,
    stopSequences: conn.stopSequences,
    logitBias: [],
    seed: conn.seed,
    reasoningEffort: conn.reasoningEffort,
    showReasoning: conn.showReasoning,
    streamResponse: conn.streamResponse,
    customSamplers: conn.customSamplers,
  };

  console.log("[Save] connectionToSavePatch:", {
    name: patch.name,
    defaultModel: patch.defaultModel,
    visionModel: patch.visionModel,
    fields: Object.keys(patch).join(","),
  });

  return patch;
}

/** Input for {@link buildFavoriteModelSwitchPatch}. */
export interface FavoriteModelSwitchInput {
  /** The model being selected as the profile's new `defaultModel`. */
  modelId: string;
  /** The matching favorite (carries the cached `contextLength`). `undefined` when the model is not favorited. */
  favorite: { contextLength: number | null } | undefined;
  /** Whether the profile has its context budget pinned. When `true`, `contextBudget` is never overwritten. */
  pinContextBudget: boolean;
}

/** Result of a favorite-model switch: always a new `defaultModel`, plus an
 *  optional `contextBudget` overwrite when the budget is not pinned. */
export interface FavoriteModelSwitchPatch {
  defaultModel: string;
  contextBudget?: number;
}

/**
 * Build the profile PATCH for switching the active model from the chat-input
 * starred-models dropdown. Pure — the caller performs the actual save.
 *
 * Always sets `defaultModel`. Overwrites `contextBudget` from the favorite's
 * cached `contextLength` ONLY when the profile has NOT pinned its context
 * budget. When pinned, the user's saved budget is preserved across model
 * switches — this is the pin-toggle contract (the three ProviderModelSelector
 * sites gate on the pin via `&& !form.pinContextBudget`; this is the same rule
 * for the chat-dropdown path, which historically did not gate and reset the
 * budget on every switch — the reported "pinned context size" bug).
 */
export function buildFavoriteModelSwitchPatch(input: FavoriteModelSwitchInput): FavoriteModelSwitchPatch {
  const patch: FavoriteModelSwitchPatch = { defaultModel: input.modelId };
  if (
    !input.pinContextBudget &&
    input.favorite?.contextLength != null &&
    input.favorite.contextLength > 0
  ) {
    patch.contextBudget = input.favorite.contextLength;
  }
  return patch;
}
