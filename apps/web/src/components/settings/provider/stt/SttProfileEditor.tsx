/**
 * fork #1 of tts/TtsProfileEditor.tsx.
 */

import { useMemo } from "react";
import { STT_BACKENDS } from "@vibe-tavern/domain";
import { listSttDraftModels, type SttModelListEntry } from "../../../../api/stt-api.js";
import { useStoredFirstListing } from "../../../../hooks/use-stored-first-listing.js";
import { SttProviderForm } from "./SttProviderForm.js";
import { SttRecognitionSection } from "./SttRecognitionSection.js";
import { SttBaseCard } from "./SttBaseCard.js";
import { SttLocalConnectionChip } from "./SttLocalConnectionChip.js";
import { formDraftConfig, sttListingConfig, sttProviderSegmentOf, updateConfigField } from "./stt-form-helpers.js";
import type { SttProfileForm, useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

/** STT editor (STT_PLAN ST-4a): fork of the TTS editor structure — the
 *  connection form renders in edit mode (Edit settings / New); in view mode
 *  the base card sits on top with the LEVEL-2 recognition settings below
 *  (model picker — fetched for every listable backend, language, emotion
 *  toggle; P8 governing rule). Save/Delete live in the modal footer. */
export function SttProfileEditor({ stt }: { stt: SttHook }) {
  const formBackend = stt.form?.backend;
  const formId = stt.form?.id ?? null;
  const savedProfile =
    stt.editingId !== null ? (stt.profiles.find((p) => p.id === stt.editingId) ?? null) : null;
  const isView = stt.headerMode === "view" && savedProfile !== null;

  // Live model catalog (P8) — the STT twin of the TTS editor's model
  // listing: the form's just-typed key rides INSIDE the transient draft
  // config (formDraftConfig — the TTS formDraftConfig rule), profileId lets
  // the server inject the stored typed-column key. DEVIATION from the TTS
  // twin, named: the listing is gated on VIEW mode — the STT model lives ONLY
  // in level 2 (governing rule), so an edit-mode fetch would burn a request
  // nothing renders.
  //
  // Step 11c (owner 2026-10-15: "the first time you pick the model, after that
  // it must not be requested again for things to work"): a saved profile opens
  // on the server's STORED model list (`source: "stored"`, no upstream call;
  // live only when nothing is stored); the refresh button is the live path.
  // The mechanism (request numbering, quiet open failure, keep-the-list
  // re-runs, debounce) is useStoredFirstListing, shared with the TTS lists.
  // The model is never auto-picked from the list: an empty model stays empty
  // until the user picks one.
  const formDraft = useMemo(
    () => (stt.form === null || stt.form === undefined ? undefined : formDraftConfig(stt.form)),
    [stt.form],
  );
  const needsRemoteModels =
    isView &&
    (formBackend === STT_BACKENDS.OpenAiCompat ||
      formBackend === STT_BACKENDS.Gemini ||
      formBackend === STT_BACKENDS.Deepgram) &&
    formDraft !== undefined;
  const models = useStoredFirstListing<SttModelListEntry[]>({
    enabled: needsRemoteModels,
    scope: formId === null || formBackend === undefined ? null : `${formId}:${formBackend}`,
    // Picking a model or a language must not re-run the catalog listing.
    inputKey: formDraft === undefined ? "" : JSON.stringify(sttListingConfig(formDraft)),
    storedFirst: formId !== null,
    load: async (source) => {
      if (formBackend === undefined || formDraft === undefined) {
        // Unreachable: the listing is only enabled with a form.
        throw new Error("STT listing requested without a form");
      }
      return listSttDraftModels({
        backend: formBackend,
        config: formDraft,
        profileId: formId ?? undefined,
        ...(source === undefined ? {} : { source }),
      });
    },
  });

  if (!stt.form) return null;

  const form = stt.form;
  const isEdit = stt.headerMode === "edit";
  // LLM parity (owner 2026-09-22): the local-connection chip renders
  // OUTSIDE the provider card — between the card and the level-2 sections
  // in view mode, right below the form in edit mode — for LOCAL-segment
  // server backends only (cloud compat rows talk to fixed endpoints).
  const isLocalServerBackend =
    sttProviderSegmentOf(form.backend, form.config) === "local" &&
    (form.backend === STT_BACKENDS.OpenAiCompat || form.backend === STT_BACKENDS.WhisperCpp);

  function handleUpdateForm<K extends keyof SttProfileForm>(k: K, v: SttProfileForm[K]): void {
    // Generic computed-key object can't be proven assignable — scoped cast.
    stt.setForm({ [k]: v } as Pick<SttProfileForm, K>);
  }

  function handleUpdateConfig(key: string, value: unknown): void {
    updateConfigField(stt, form, key, value);
  }

  return (
    <div data-testid="stt-profile-editor" className="flex flex-col gap-4">
      {isEdit ? (
        <>
          <SttProviderForm
            form={form}
            editingId={form.id}
            sttProfiles={stt.profiles}
            updateForm={handleUpdateForm}
            stt={stt}
          />
          {isLocalServerBackend && <SttLocalConnectionChip form={form} />}
        </>
      ) : savedProfile !== null ? (
        <>
          <SttBaseCard
            form={form}
            isDefault={savedProfile.isDefault}
            onEdit={stt.startEdit}
            onSetDefault={() => void stt.setDefault(savedProfile.id)}
          />
          {isLocalServerBackend && <SttLocalConnectionChip form={form} />}
          {/* View mode: the LEVEL-2 recognition settings below the base card
              (P8 governing rule) — model, language, emotion. */}
          <SttRecognitionSection
            form={form}
            onUpdate={handleUpdateConfig}
            onUpdateForm={(patch) => stt.setForm(patch)}
            models={models.data ?? []}
            fetching={models.loading}
            fetchError={models.error}
            onRefresh={models.refresh}
          />
        </>
      ) : null}

      {stt.error && (
        <div data-testid="stt-editor-error" className="rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {stt.error}
        </div>
      )}

      {/* Save/Delete live in the modal FOOTER (MasterDetailFooter, ProviderModal
          stt branch) per the master-detail house pattern — nothing inline here. */}
    </div>
  );
}
