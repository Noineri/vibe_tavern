import { useEffect, useMemo, useRef, useState } from "react";
import { STT_BACKENDS } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { listSttDraftModels, type SttModelListEntry } from "../../../../api/stt-api.js";
import { SttProviderForm } from "./SttProviderForm.js";
import { SttRecognitionSection } from "./SttRecognitionSection.js";
import { SttBaseCard } from "./SttBaseCard.js";
import { configString, formDraftConfig, updateConfigField } from "./stt-form-helpers.js";
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

  // Live model catalog (P8) — the STT twin of the TTS editor's models
  // effect: debounced, JSON-stringified config dep, honest-slate resets,
  // profileId stored-key resolution server-side. The form's just-typed key
  // rides INSIDE the transient draft config (formDraftConfig — the TTS
  // formDraftConfig rule). DEVIATION from the TTS twin, named: the fetch is
  // gated on VIEW mode — the STT model lives ONLY in level 2 (governing
  // rule), so an edit-mode fetch would burn a request nothing renders.
  const [models, setModels] = useState<SttModelListEntry[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const formDraft = useMemo(
    () => (stt.form === null || stt.form === undefined ? undefined : formDraftConfig(stt.form)),
    [stt.form],
  );
  const needsRemoteModels =
    isView &&
    (formBackend === STT_BACKENDS.OpenAiCompat || formBackend === STT_BACKENDS.Gemini) &&
    formDraft !== undefined;
  const modelsConfigKey = formDraft === undefined ? null : JSON.stringify(formDraft);
  // Mirror of the live config bag (read at fetch-completion time) for the
  // settle-on-first write below — config is NOT an effect dep (a dep would
  // restart the debounced fetch on every keystroke).
  const formConfigRef = useRef<Record<string, unknown>>({});
  formConfigRef.current = stt.form?.config ?? {};

  useEffect(() => {
    if (!needsRemoteModels || modelsConfigKey === null) {
      setModels(null);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    const backend = formBackend;
    const config = formDraft;
    const profileId = formId ?? undefined;
    setModelsLoading(true);
    setModelsError(null);
    // Honest-slate rule (the TTS twin): while the new fetch is in flight
    // the field degrades to manual input, never keeps the previous
    // profile's list under a dead or switched endpoint.
    setModels(null);
    const timer = setTimeout(() => {
      listSttDraftModels({ backend, config, profileId })
        .then((list) => {
          if (cancelled) return;
          setModels(list);
          setModelsLoading(false);
          // LLM rule (D20, owner directive — the TTS twin): an empty model
          // field settles on the first fetched entry; a user pick survives
          // refetches.
          if (list.length > 0 && configString(formConfigRef.current, "model") === "") {
            stt.setForm({ config: { ...formConfigRef.current, model: list[0].id } });
          }
        })
        .catch((cause) => {
          if (cancelled) return;
          setModelsError(cause instanceof Error ? cause.message : String(cause));
          setModelsLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsRemoteModels, modelsConfigKey, formBackend, formDraft, formId, stt.setForm]);

  // Refresh button handler for the model picker — the same fetch the
  // debounced effect performs, on demand.
  const refreshModels = () => {
    if (!needsRemoteModels || formDraft === undefined || formBackend === undefined) return;
    setModelsLoading(true);
    setModelsError(null);
    listSttDraftModels({ backend: formBackend, config: formDraft, profileId: formId ?? undefined })
      .then((list) => {
        setModels(list);
        setModelsLoading(false);
      })
      .catch((cause) => {
        setModelsError(cause instanceof Error ? cause.message : String(cause));
        setModelsLoading(false);
      });
  };

  if (!stt.form) return null;

  const form = stt.form;
  const isEdit = stt.headerMode === "edit";

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
        <SttProviderForm
          form={form}
          editingId={form.id}
          sttProfiles={stt.profiles}
          updateForm={handleUpdateForm}
          stt={stt}
        />
      ) : savedProfile !== null ? (
        <>
          <SttBaseCard
            form={form}
            isDefault={savedProfile.isDefault}
            onEdit={stt.startEdit}
            onSetDefault={() => void stt.setDefault(savedProfile.id)}
          />
          {/* View mode: the LEVEL-2 recognition settings below the base card
              (P8 governing rule) — model, language, emotion. */}
          <SttRecognitionSection
            form={form}
            onUpdate={handleUpdateConfig}
            onUpdateForm={(patch) => stt.setForm(patch)}
            models={models ?? []}
            fetching={modelsLoading}
            fetchError={modelsError}
            onRefresh={refreshModels}
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
