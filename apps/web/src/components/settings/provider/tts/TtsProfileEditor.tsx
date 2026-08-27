import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../../../../i18n/context.js";
import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { DestructiveConfirmModal } from "../../../shared/destructive-confirm-modal.js";
import { SaveBar } from "../../../shared/SaveBar.js";
import { inputCls, lblCls, monoUICls } from "../../../build/fields/field-styles.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { Toggle } from "../../../shared/Toggle.js";
import { KOKORO_VOICES } from "../../../../lib/tts/kokoro-voices.js";
import { listTtsVoices, type TtsVoiceRecord } from "../../../../api/tts-api.js";
import { Ic } from "../../../shared/icons.js";
import { useTtsPreview } from "./use-tts-preview.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

function updateConfigField(
  tts: TtsHook,
  form: NonNullable<TtsHook["form"]>,
  key: string,
  value: unknown,
): void {
  const next = { ...form.config };
  if (value === undefined || value === null || (typeof value === "string" && value === "")) {
    delete next[key];
  } else {
    next[key] = value;
  }
  tts.setForm({ config: next });
}

/** Reads an optional string/number config key with a display fallback. The
 *  `typeof` guard narrows `unknown` — no casts needed. */
function configString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
}

/** The per-backend voice picker: unsaved → plain input + save-first hint;
 *  saved → async server voice list with loading and error-fallback states.
 *  Extracted from the three identical backend blocks (kokoro uses its own
 *  static manifest picker and does not go through here). */
function TtsVoicePickerField({
  tts,
  form,
  voices,
  voicesLoading,
  voicesError,
}: {
  tts: TtsHook;
  form: NonNullable<TtsHook["form"]>;
  voices: TtsVoiceRecord[] | null;
  voicesLoading: boolean;
  voicesError: string | null;
}): ReactNode {
  const { t } = useT();
  if (form.id === null) {
    return (
      <>
        <input
          data-testid="tts-voice-input"
          className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
          value={form.voiceId}
          onChange={(e) => tts.setForm({ voiceId: e.target.value })}
          placeholder={t("tts_field_voice")}
        />
        <div className="mt-1 font-ui text-[11px] text-t3">{t("tts_voices_save_first_hint")}</div>
      </>
    );
  }
  if (voicesLoading) {
    return (
      <div data-testid="tts-voices-loading" className="mt-1 font-ui text-[12px] text-t3">
        {t("tts_voices_loading")}
      </div>
    );
  }
  if (voicesError !== null) {
    return (
      <>
        <input
          data-testid="tts-voice-input"
          className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
          value={form.voiceId}
          onChange={(e) => tts.setForm({ voiceId: e.target.value })}
          placeholder={t("tts_field_voice")}
        />
        <div data-testid="tts-voices-load-error" className="mt-1 font-ui text-[11px] text-danger">
          {t("tts_voices_load_error")}
        </div>
      </>
    );
  }
  return (
    <div className="mt-1">
      <DropdownSelect
        value={form.voiceId}
        options={(voices ?? []).map((v) => ({ id: v.id, label: v.label || v.id }))}
        onChange={(value) => tts.setForm({ voiceId: value })}
        searchable={true}
        placeholder={t("tts_field_voice")}
        triggerTestId="tts-voice-select"
      />
    </div>
  );
}

export function TtsProfileEditor({ tts }: { tts: TtsHook }) {
  const { t } = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [voices, setVoices] = useState<TtsVoiceRecord[] | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const formId = tts.form?.id ?? null;
  const formBackend = tts.form?.backend;
  const needsRemoteVoices = formBackend !== undefined && formBackend !== TTS_BACKEND.Kokoro;
  const preview = useTtsPreview();

  // Hooks stay ABOVE the early return — `if (!tts.form) return null` between
  // useState and useEffect would be a hooks-order violation the day any
  // caller keeps this mounted across a form→null transition.
  useEffect(() => {
    if (!needsRemoteVoices || formId === null) {
      setVoices(null);
      setVoicesError(null);
      setVoicesLoading(false);
      return;
    }
    let cancelled = false;
    setVoicesLoading(true);
    setVoicesError(null);
    listTtsVoices(formId)
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        setVoicesLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setVoicesError(cause instanceof Error ? cause.message : String(cause));
        setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formId, formBackend, needsRemoteVoices]);

  if (!tts.form) return null;

  const form = tts.form;

  const backendOptions = [
    { id: TTS_BACKEND.Kokoro, label: t("tts_backend_kokoro") },
    { id: TTS_BACKEND.OpenAiCompatible, label: t("tts_backend_openai_compatible") },
    { id: TTS_BACKEND.Gemini, label: t("tts_backend_gemini") },
    { id: TTS_BACKEND.ElevenLabs, label: t("tts_backend_elevenlabs") },
  ];

  const isKokoro = form.backend === TTS_BACKEND.Kokoro;
  const isOpenAi = form.backend === TTS_BACKEND.OpenAiCompatible;
  const isGemini = form.backend === TTS_BACKEND.Gemini;
  const isElevenLabs = form.backend === TTS_BACKEND.ElevenLabs;
  // Server backends preview from the SAVED profile (the generate API keys on
  // profileId) — unsaved or dirty forms cannot preview; kokoro synthesizes
  // client-side from form values, so it previews without saving.
  const serverNeedsSave = !isKokoro && (form.id === null || tts.dirty);


  const kokoroEnglishVoices = KOKORO_VOICES.filter((v) => v.lang === "a" || v.lang === "b");
  const kokoroVoiceOptions = kokoroEnglishVoices.map((v) => ({ id: v.id, label: v.id }));

  const responseFormatOptions = [
    { id: "mp3", label: "mp3" },
    { id: "opus", label: "opus" },
    { id: "aac", label: "aac" },
    { id: "flac", label: "flac" },
    { id: "wav", label: "wav" },
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

      {isKokoro && (
        <>
          <div>
            <label className={lblCls}>{t("tts_field_voice")}</label>
            <div className="mt-1">
              <DropdownSelect
                value={form.voiceId}
                options={kokoroVoiceOptions}
                onChange={(value) => tts.setForm({ voiceId: value })}
                searchable={true}
                placeholder={t("tts_field_voice")}
                triggerTestId="tts-voice-select"
              />
            </div>
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_speed")}</label>
            <div className="mt-1">
              <NumberInput
                value={configNumber(form.config, "speed", 1)}
                onChange={(val) => updateConfigField(tts, form, "speed", val)}
                min={0.5}
                max={2.0}
                step={0.1}
              />
            </div>
          </div>
        </>
      )}

      {isOpenAi && (
        <>
          <div>
            <label className={lblCls}>{t("tts_field_endpoint")}</label>
            <input
              data-testid="tts-field-endpoint"
              className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "endpoint")}
              onChange={(e) => updateConfigField(tts, form, "endpoint", e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_api_key")}</label>
            <input
              data-testid="tts-field-api-key"
              className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "apiKey")}
              onChange={(e) => updateConfigField(tts, form, "apiKey", e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_model")}</label>
            <input
              data-testid="tts-field-model"
              className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "model")}
              onChange={(e) => updateConfigField(tts, form, "model", e.target.value)}
              placeholder="kokoro"
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_response_format")}</label>
            <div className="mt-1">
              <DropdownSelect
                value={configString(form.config, "responseFormat", "mp3")}
                options={responseFormatOptions}
                onChange={(value) => updateConfigField(tts, form, "responseFormat", value)}
                searchable={false}
                triggerTestId="tts-field-response-format"
              />
            </div>
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_speed")}</label>
            <div className="mt-1">
              <NumberInput
                value={configNumber(form.config, "speed", 1)}
                onChange={(val) => updateConfigField(tts, form, "speed", val)}
                min={0.25}
                max={4.0}
                step={0.1}
              />
            </div>
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_voice")}</label>
            <TtsVoicePickerField tts={tts} form={form} voices={voices} voicesLoading={voicesLoading} voicesError={voicesError} />
          </div>
        </>
      )}

      {isGemini && (
        <>
          <div>
            <label className={lblCls}>{t("tts_field_api_key")}</label>
            <input
              data-testid="tts-field-api-key"
              className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "apiKey")}
              onChange={(e) => updateConfigField(tts, form, "apiKey", e.target.value)}
              placeholder="AIza..."
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_model")}</label>
            <input
              data-testid="tts-field-model"
              className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "model")}
              onChange={(e) => updateConfigField(tts, form, "model", e.target.value)}
              placeholder="gemini-2.5-flash-preview-tts"
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_style_instructions")}</label>
            <AutoTextarea
              className={inputCls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "styleInstructions")}
              onChange={(e) => updateConfigField(tts, form, "styleInstructions", e.target.value)}
              placeholder={t("tts_field_style_instructions_placeholder")}
              minRows={2}
              maxRows={6}
              data-testid="tts-field-style-instructions"
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_voice")}</label>
            <TtsVoicePickerField tts={tts} form={form} voices={voices} voicesLoading={voicesLoading} voicesError={voicesError} />
          </div>
        </>
      )}

      {isElevenLabs && (
        <>
          <div>
            <label className={lblCls}>{t("tts_field_api_key")}</label>
            <input
              data-testid="tts-field-api-key"
              className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "apiKey")}
              onChange={(e) => updateConfigField(tts, form, "apiKey", e.target.value)}
              placeholder="sk_..."
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_model_id")}</label>
            <input
              data-testid="tts-field-model-id"
              className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
              value={configString(form.config, "modelId")}
              onChange={(e) => updateConfigField(tts, form, "modelId", e.target.value)}
              placeholder="eleven_multilingual_v2"
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_stability")}</label>
            <div className="mt-1">
              <NumberInput
                value={configNumber(form.config, "stability", 0.5)}
                onChange={(val) => updateConfigField(tts, form, "stability", val)}
                min={0}
                max={1}
                step={0.05}
              />
            </div>
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_similarity")}</label>
            <div className="mt-1">
              <NumberInput
                value={configNumber(form.config, "similarityBoost", 0.75)}
                onChange={(val) => updateConfigField(tts, form, "similarityBoost", val)}
                min={0}
                max={1}
                step={0.05}
              />
            </div>
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_style")}</label>
            <div className="mt-1">
              <NumberInput
                value={configNumber(form.config, "style", 0)}
                onChange={(val) => updateConfigField(tts, form, "style", val)}
                min={0}
                max={1}
                step={0.05}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className={lblCls}>{t("tts_field_speaker_boost")}</label>
            <Toggle
              checked={form.config.useSpeakerBoost === true}
              onChange={(checked) => updateConfigField(tts, form, "useSpeakerBoost", checked || undefined)}
              aria-label={t("tts_field_speaker_boost")}
            />
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_speed")}</label>
            <div className="mt-1">
              <NumberInput
                value={configNumber(form.config, "speed", 1)}
                onChange={(val) => updateConfigField(tts, form, "speed", val)}
                min={0.7}
                max={1.2}
                step={0.05}
              />
            </div>
          </div>
          <div>
            <label className={lblCls}>{t("tts_field_voice")}</label>
            <TtsVoicePickerField tts={tts} form={form} voices={voices} voicesLoading={voicesLoading} voicesError={voicesError} />
          </div>
        </>
      )}

      <div className="flex flex-col gap-1">
        <button
          type="button"
          data-testid="tts-preview-btn"
          disabled={preview.state !== "idle" || serverNeedsSave}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40 disabled:pointer-events-none"
          onClick={() =>
            preview.preview({
              backend: form.backend,
              voiceId: form.voiceId,
              speed: configNumber(form.config, "speed", 1),
              profileId: form.id,
            })
          }
        >
          <Ic.speaker className="h-3.5 w-3.5" />
          {preview.state === "generating"
            ? t("tts_preview_generating")
            : preview.state === "playing"
              ? t("tts_preview_playing")
              : t("tts_preview")}
        </button>
        {serverNeedsSave && (
          <div className="font-ui text-[11px] text-t3">{t("tts_preview_save_first")}</div>
        )}
        {preview.error && (
          <div data-testid="tts-preview-error" className="font-ui text-[11px] text-danger">
            {t("tts_preview_failed")}: {preview.error}
          </div>
        )}
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
