import { useState } from "react";
import { useT } from "../../../../i18n/context.js";
import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { SaveBar } from "../../../shared/SaveBar.js";
import { inputCls, lblCls } from "../../../build/fields/field-styles.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

export function TtsProfileEditor({ tts }: { tts: TtsHook }) {
  const { t } = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!tts.form) return null;

  const form = tts.form;
  const canSave = tts.dirty && form.name.trim().length > 0 && !tts.saving;

  const backendOptions = [
    { id: TTS_BACKEND.Kokoro, label: t("tts_backend_kokoro") },
    { id: TTS_BACKEND.OpenAiCompatible, label: t("tts_backend_openai_compatible") },
    { id: TTS_BACKEND.Gemini, label: t("tts_backend_gemini") },
    { id: TTS_BACKEND.ElevenLabs, label: t("tts_backend_elevenlabs") },
  ];

  return (
    <div data-testid="tts-profile-editor" className="flex flex-col gap-4">
      <div>
        <label className={lblCls}>{t("tts_profile_name_label")}</label>
        <input
          data-testid="tts-profile-name-input"
          className={inputCls + " mt-1 px-3 py-2 text-[13px]"}
          value={form.name}
          onChange={(e) => tts.setForm({ name: e.target.value })}
          placeholder={t("tts_profile_name_label")}
        />
      </div>

      <div>
        <label className={lblCls}>{t("tts_profile_backend_label")}</label>
        <div className="mt-1">
          <DropdownSelect
            value={form.backend}
            options={backendOptions}
            // DropdownSelect emits the clicked item's id as a plain string; the
            // ids here ARE TtsBackendSlug values, so the emit is always a
            // valid slug (provably-safe string-land re-entry, same as
            // SegmentedControl's Radix onValueChange).
            onChange={(value) => tts.setForm({ backend: value as TtsBackendSlug })}
            searchable={false}
            triggerTestId="tts-backend-select"
          />
        </div>
      </div>

      <div
        data-testid="tts-editor-fields-placeholder"
        className="rounded-md border border-dashed border-border2 bg-s2/50 px-3 py-4 text-center font-ui text-[12px] text-t3"
      >
        {t("tts_editor_fields_placeholder")}
      </div>

      {tts.error && (
        <div data-testid="tts-editor-error" className="rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {tts.error}
        </div>
      )}

      <SaveBar
        dirty={tts.dirty}
        saveState={tts.saving ? "saving" : "idle"}
        onClick={() => void tts.save()}
        onReset={() => tts.cancelEdit()}
      />

      <button
        type="button"
        data-testid="tts-delete-btn"
        disabled={form.id === null}
        className="self-start font-ui text-[13px] text-danger/80 transition-colors hover:text-danger disabled:opacity-40 disabled:pointer-events-none"
        onClick={() => setConfirmDelete(true)}
      >
        {t("delete")}
      </button>

      {confirmDelete && (
        <DestructiveConfirmModal
          title={t("tts_profile_delete_confirm_title")}
          body={t("tts_profile_delete_confirm_body", { name: form.name })}
          confirmLabel={t("delete_btn")}
          onConfirm={() => {
            setConfirmDelete(false);
            void tts.remove();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
