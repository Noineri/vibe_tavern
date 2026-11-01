import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { FavoriteProviderModelRecord, ProviderProfileRecord } from "../../api/types.js";
import { NEW_PROFILE_CONTEXT_BUDGET } from "../../lib/new-profile-defaults.js";
import { getProviderModelSettingsAction } from "../../stores/api-actions/provider-actions.js";
import type { FormState } from "./ProviderModal.js";

/**
 * Per-model binding follow — re-hydrate the ProviderModal form for the
 * ACTIVE model. Extracted from ProviderModal.ts (file-size ratchet), the
 * hook call MUST stay ABOVE the modal's `if (!isOpen) return null;` — a hook
 * after a conditional return broke the closed→open transition (React #310,
 * 700c7e15; pinned by ProviderModal.follow.test.tsx).
 *
 * Owner ruling 2026-09-27: the editor FOLLOWS the profile's active model
 * (there is no manual binding dropdown anymore). A favorited model shows
 * and edits ITS overlay (fetched and merged over the PERSISTED base); a
 * non-favorite (or binding OFF) shows and edits the base. The base comes
 * from providerProfiles (always current — autoSaveField persists
 * identity/sampler on every change when NOT in overlay mode). In overlay
 * mode, sampler edits route to the overlay via the save routing, so
 * switching models reads the clean persisted base, not a stale form
 * snapshot.
 *
 * `followKey` guards the async gap: a faster model switch re-keys the follow
 * and a stale hydrate aborts instead of overwriting the fresh one.
 *
 * Returns `resetBindingFollow()` — call it wherever the form is REBUILT from
 * a profile (modal open, profile switch, create/duplicate): profileToForm
 * resets editingModelId to null, and a followKey stamped by a previous visit
 * must not suppress the re-hydrate (owner bug 2026-11-01: after close/reopen
 * the badge lied "model not in favorites" for a favorited model).
 */
export function useProviderBindingFollow({
  form,
  providerProfiles,
  favoriteModelsByProfile,
  setForm,
  latestFormRef,
}: {
  form: FormState | null;
  providerProfiles: ProviderProfileRecord[];
  favoriteModelsByProfile: Record<string, FavoriteProviderModelRecord[]>;
  setForm: Dispatch<SetStateAction<FormState | null>>;
  latestFormRef: RefObject<FormState | null>;
}): () => void {
  const bindingFollowKeyRef = useRef<string>("");

  const resetBindingFollow = useCallback(() => {
    bindingFollowKeyRef.current = "";
  }, []);

  const hydrateForActiveModel = async (modelId: string | null, followKey: string) => {
    if (!form) return;
    const baseProfile = providerProfiles.find((p) => p.id === form.id);
    if (!baseProfile) return;
    let overlay = null;
    if (modelId != null) {
      try {
        overlay = await getProviderModelSettingsAction(form.id, modelId);
      } catch {
        // Network/API error — fall through with null overlay (base passthrough).
        overlay = null;
      }
    }
    // Manual field-wise merge: overlay value if present, else base profile value.
    // (Cannot use domain's resolveEffectiveSettings directly — web
    // ProviderProfileRecord omits apiKey for security, so it isn't structurally
    // assignable to StoredProviderProfileRecord.)
    const ov = overlay?.settings ?? null;
    // A faster model switch may have re-keyed the follow while the overlay
    // fetch was in flight — a stale hydrate must never overwrite the fresh one.
    if (bindingFollowKeyRef.current !== followKey) return;
    const pick = <K extends keyof typeof effectiveFields>(k: K): (typeof effectiveFields)[K] =>
      (ov && ov[k] != null ? ov[k] : effectiveFields[k]) as (typeof effectiveFields)[K];
    const effectiveFields = {
      temperature: baseProfile.temperature,
      topP: baseProfile.topP,
      minP: baseProfile.minP,
      topK: baseProfile.topK,
      topA: baseProfile.topA,
      typicalP: baseProfile.typicalP,
      tfsZ: baseProfile.tfsZ,
      adaptiveTarget: baseProfile.adaptiveTarget,
      adaptiveDecay: baseProfile.adaptiveDecay,
      dynatempRange: baseProfile.dynatempRange,
      dynatempExponent: baseProfile.dynatempExponent,
      topNSigma: baseProfile.topNSigma,
      smoothingFactor: baseProfile.smoothingFactor,
      repeatLastN: baseProfile.repeatLastN,
      dryPenaltyLastN: baseProfile.dryPenaltyLastN,
      mirostat: baseProfile.mirostat,
      mirostatTau: baseProfile.mirostatTau,
      mirostatEta: baseProfile.mirostatEta,
      dryMultiplier: baseProfile.dryMultiplier,
      dryBase: baseProfile.dryBase,
      dryAllowedLength: baseProfile.dryAllowedLength,
      drySequenceBreakers: baseProfile.drySequenceBreakers,
      xtcThreshold: baseProfile.xtcThreshold,
      xtcProbability: baseProfile.xtcProbability,
      frequencyPenalty: baseProfile.frequencyPenalty,
      presencePenalty: baseProfile.presencePenalty,
      repetitionPenalty: baseProfile.repetitionPenalty,
      maxTokens: baseProfile.maxTokens,
      contextBudget: baseProfile.contextBudget,
      pinContextBudget: baseProfile.pinContextBudget,
      stopSequences: baseProfile.stopSequences,
      bannedStrings: baseProfile.bannedStrings,
      logitBias: baseProfile.logitBias,
      seed: baseProfile.seed,
      reasoningEffort: baseProfile.reasoningEffort,
      showReasoning: baseProfile.showReasoning,
      streamResponse: baseProfile.streamResponse,
      customSamplers: baseProfile.customSamplers,
    };
    setForm((f) => {
      if (!f) return f;
      const next: FormState = {
        ...f,
        editingModelId: modelId,
        temperature: pick("temperature"),
        topP: pick("topP"),
        minP: pick("minP"),
        topK: pick("topK"),
        topA: pick("topA"),
        typicalP: pick("typicalP") ?? 1,
        tfsZ: pick("tfsZ") ?? 1,
        adaptiveTarget: pick("adaptiveTarget") ?? -1,
        adaptiveDecay: pick("adaptiveDecay") ?? 0.9,
        dynatempRange: pick("dynatempRange") ?? 0,
        dynatempExponent: pick("dynatempExponent") ?? 1,
        topNSigma: pick("topNSigma") ?? 0,
        smoothingFactor: pick("smoothingFactor") ?? 0,
        repeatLastN: pick("repeatLastN") ?? 0,
        dryPenaltyLastN: pick("dryPenaltyLastN") ?? -1,
        mirostat: pick("mirostat") ?? 0,
        mirostatTau: pick("mirostatTau") ?? 5,
        mirostatEta: pick("mirostatEta") ?? 0.1,
        dryMultiplier: pick("dryMultiplier") ?? 0,
        dryBase: pick("dryBase") ?? 1.75,
        dryAllowedLength: pick("dryAllowedLength") ?? 2,
        drySequenceBreakers: pick("drySequenceBreakers") ?? [],
        xtcThreshold: pick("xtcThreshold") ?? 0.1,
        xtcProbability: pick("xtcProbability") ?? 0,
        frequencyPenalty: pick("frequencyPenalty"),
        presencePenalty: pick("presencePenalty"),
        repetitionPenalty: pick("repetitionPenalty"),
        maxTokens: pick("maxTokens"),
        contextBudget: pick("contextBudget") ?? NEW_PROFILE_CONTEXT_BUDGET,
        pinContextBudget: pick("pinContextBudget") ?? false,
        // Token padding (LS-1d) is profile-level — never overridden by the
        // per-model overlay — so it reads straight from the base profile.
        tokenPadding: baseProfile.tokenPadding,
        stopSequences: pick("stopSequences"),
        bannedStrings: pick("bannedStrings") ?? [],
        logitBias: pick("logitBias") ?? [],
        seed: pick("seed") ?? null,
        reasoningEffort: pick("reasoningEffort"),
        showReasoning: pick("showReasoning"),
        streamResponse: pick("streamResponse"),
        customSamplers: pick("customSamplers"),
        // Per-model set pointer (IG-CF15 twin): the overlay's pointer when the
        // model carries one, else the base pointer (binding-off fallback).
        samplerSetId: (ov?.samplerSetId ?? baseProfile.samplerSetId) ?? null,
      };
      latestFormRef.current = next;
      return next;
    });
    // NOT setDirty: the hydrate mirrors PERSISTED state (the overlay or the
    // profile base) — it is not a user edit. Dirtying here made every model
    // switch and binding toggle flip raise the unsaved-changes guard while
    // the values themselves autosave (owner bug 2026-11-01).
  };

  // ── Follow-the-active-model (owner ruling 2026-09-27) ──
  // With binding ON the settings below the toggle always mirror the ACTIVE
  // model: favorited → its overlay, non-favorite → base. The follow runs on
  // open, on model switch, and on toggle flips — there is no manual binding
  // dropdown anymore.
  useEffect(() => {
    if (!form || !form.id) return;
    const favorites = favoriteModelsByProfile[form.id] ?? [];
    const activeModel = form.model.trim();
    const target = form.bindPerModel && activeModel !== "" && favorites.some((f) => f.modelId === activeModel)
      ? activeModel
      : null;
    const followKey = `${form.id}::${form.bindPerModel ? target : "off"}`;
    // The form's editingModelId is the source of truth for "already
    // mirroring target" — checked FIRST. The key-ref below only suppresses
    // duplicate in-flight hydrates (plus hydrate's own stale-fetch guard).
    // Checking the ref first let a REBUILT form (profileToForm resets
    // editingModelId to null) be skipped when the key matched a previous
    // visit — the reopened modal showed the base badge for a favorited
    // model (owner bug 2026-11-01).
    if (target === form.editingModelId) return;
    if (bindingFollowKeyRef.current === followKey) return;
    bindingFollowKeyRef.current = followKey;
    void hydrateForActiveModel(target, followKey);
  }, [form, favoriteModelsByProfile, hydrateForActiveModel]);

  return resetBindingFollow;
}
