import { useMemo } from "react";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import {
  listTtsDraftModels,
  listTtsDraftVoices,
  type TtsBackendCapabilities,
  type TtsDraftVoicesResponse,
  type TtsModelListEntry,
  type TtsVoiceRecord,
} from "../../../../api/tts-api.js";
import { useStoredFirstListing } from "../../../../hooks/use-stored-first-listing.js";
import { ttsFetchedModelSpec, ttsListingConfig } from "./tts-backend-ui.js";
import { formDraftConfig } from "./tts-form-helpers.js";
import type { TtsProfileForm } from "./use-tts-profiles.js";

export interface TtsEditorListings {
  voices: TtsVoiceRecord[] | null;
  voicesLoading: boolean;
  voicesError: string | null;
  /** Clone capability rides the voices envelope (clone field design
   *  2026-08-31): null voices (empty library) may still carry
   *  supportsCloning. Null until the first answer, and again after a
   *  profile switch. */
  cloneCaps: TtsBackendCapabilities | null;
  /** Live relisting of the voices (the refresh button, the post-clone
   *  refresh): replaces the server's stored copy. */
  refreshVoices: () => void;
  models: TtsModelListEntry[] | null;
  modelsLoading: boolean;
  modelsError: string | null;
  /** Live relisting of the models (the picker's refresh button). */
  refreshModels: () => void;
}

/**
 * Voice and model lists of the TTS profile editor (step 11c, owner
 * 2026-10-15: "the first time you pick the model, after that it must not be
 * requested again for things to work"). The mechanism — stored list on open,
 * live only on refresh, request numbering, quiet open failure, keep-the-list
 * re-runs — lives in `useStoredFirstListing`; this hook supplies the TTS
 * specifics:
 *
 * - Both lists run only while `enabled` (the saved profile's VIEW mode, the
 *   only place the pickers render); edit mode lists nothing, however fast the
 *   endpoint or key is typed.
 * - The models gate is the variant spec's own `mode: "fetch"` model field
 *   (`ttsFetchedModelSpec`), so Inworld and MiniMax list like Gemini and the
 *   OpenAI-compatible rows.
 * - Each list re-runs only when a listing input changes (`ttsListingConfig`):
 *   tuning, voice, narrator and playback edits touch neither list; a model
 *   pick touches the voices only (rosters can be model-scoped, D22).
 * - A saved profile opens stored-first (`profileId` + `source: "stored"`); a
 *   draft (no id) lists live, as before.
 *
 * The form's typed key rides INSIDE the transient draft config (TE2-16:
 * formDraftConfig) — the stored bag never carries it. Call this ABOVE the
 * editor's `if (!tts.form) return null` (hook order).
 */
export function useTtsEditorListings({
  form,
  enabled,
  setForm,
}: {
  form: TtsProfileForm | null | undefined;
  enabled: boolean;
  setForm: (patch: Partial<TtsProfileForm>) => void;
}): TtsEditorListings {
  // Memoized on the form identity: a fresh object per render would be a new
  // value for every consumer below on every state change.
  const draft = useMemo(
    () => (form === null || form === undefined ? undefined : formDraftConfig(form)),
    [form],
  );
  const backend = form?.backend;
  const profileId = form?.id ?? null;
  const fetchedModel =
    form === null || form === undefined ? null : ttsFetchedModelSpec(form.backend, form.config);
  const ready = enabled && backend !== undefined && draft !== undefined;
  // One owner per list: a saved profile on its backend. A draft has none.
  const scope = profileId === null || backend === undefined ? null : `${profileId}:${backend}`;
  const listingKey = (list: "models" | "voices"): string =>
    backend === undefined || draft === undefined ? "" : JSON.stringify(ttsListingConfig(backend, draft, list));
  const request = (source: "stored" | undefined) => {
    if (backend === undefined || draft === undefined) {
      // Unreachable: the lists are only enabled with a form.
      throw new Error("TTS listing requested without a form");
    }
    return {
      backend,
      config: draft,
      profileId: profileId ?? undefined,
      ...(source === undefined ? {} : { source }),
    };
  };

  // LLM rule (D20 voice half, owner directive; kept): keep the user's pick
  // while the roster carries it; otherwise settle on the first roster entry.
  // An empty or stale (D22: rosters are model-scoped — switching models
  // swaps the roster) selection lands on list[0], so a profile always shows a
  // real voice from the server instead of a blank/example stub. Guarded so a
  // settled selection never loops; an empty roster keeps "" (manual input
  // stays honest). Runs on stored answers and on refreshes alike; reads the
  // live voiceId at answer time (the lists' `onLoaded` is the latest render's).
  const settleVoice = (list: TtsVoiceRecord[]): void => {
    const current = form?.voiceId ?? "";
    if (current !== "" && list.some((voice) => voice.id === current)) return;
    const next = list[0]?.id ?? "";
    if (next !== current) setForm({ voiceId: next });
  };

  const voices = useStoredFirstListing<TtsDraftVoicesResponse>({
    enabled: ready && backend !== TTS_BACKEND.Kokoro,
    scope,
    inputKey: listingKey("voices"),
    storedFirst: profileId !== null,
    load: async (source) => listTtsDraftVoices(request(source)),
    onLoaded: (answer) => {
      // Null is NOT a failure: an empty chatterbox-style library (and any
      // host without a voices endpoint) parses to null by design — the empty
      // state is told apart through the clone capability (owner 2026-09-05:
      // "no voices yet" is not "failed").
      if (answer.voices !== null) settleVoice(answer.voices);
    },
  });

  // The model is NOT settled from the list (the old D20 rule is gone, step
  // 11c): an empty model stays empty until the user picks one, and nothing
  // here ever rewrites a saved model.
  const models = useStoredFirstListing<TtsModelListEntry[]>({
    enabled: ready && fetchedModel !== null,
    scope,
    inputKey: listingKey("models"),
    storedFirst: profileId !== null,
    load: async (source) => listTtsDraftModels(request(source)),
  });

  return {
    voices: voices.data?.voices ?? null,
    voicesLoading: voices.loading,
    voicesError: voices.error,
    cloneCaps: voices.data?.capabilities ?? null,
    refreshVoices: voices.refresh,
    models: models.data,
    modelsLoading: models.loading,
    modelsError: models.error,
    refreshModels: models.refresh,
  };
}
