import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../../../../i18n/context.js";
import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { Ic } from "../../../shared/icons.js";
import { inputCls, lblCls, monoUICls } from "../../../build/fields/field-styles.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { Toggle } from "../../../shared/Toggle.js";
import { KOKORO_VOICES } from "../../../../lib/tts/kokoro-voices.js";
import { listTtsDraftModels, listTtsDraftVoices, type TtsVoiceRecord } from "../../../../api/tts-api.js";
import { TtsApiKeyField } from "./TtsApiKeyField.js";
import { useTtsPreview } from "./use-tts-preview.js";
import { TtsBindingFields } from "./TtsBindingFields.js";
import { TtsLocalServerPanel } from "./TtsLocalServerPanel.js";
import { KokoroModelPanel } from "./KokoroModelPanel.js";
import { configString, updateConfigField } from "./tts-form-helpers.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

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
  // Draft voices (F1): unsaved forms load them too — the save-first branch
  // is gone; loading/error states degrade to a plain input below.
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
  const [voices, setVoices] = useState<TtsVoiceRecord[] | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [models, setModels] = useState<Array<{ id: string; label: string }> | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const formBackend = tts.form?.backend;
  const formConfig = tts.form?.config;
  const needsRemoteVoices = formBackend !== undefined && formBackend !== TTS_BACKEND.Kokoro;
  const preview = useTtsPreview();

  // Hooks stay ABOVE the early return — `if (!tts.form) return null` between
  // useState and useEffect would be a hooks-order violation the day any
  // caller keeps this mounted across a form→null transition.
  //
  // Voices come from the TRANSIENT draft endpoint (F1): the CURRENT form
  // config, saved or not — no save-to-test detour. The dep is a serialized
  // config key (object identity changes per keystroke), debounced so typing
  // an endpoint/key doesn't spam the backend.
  const voicesConfigKey = formConfig === undefined ? null : JSON.stringify(formConfig);
  useEffect(() => {
    if (!needsRemoteVoices || formConfig === undefined) {
      setVoices(null);
      setVoicesError(null);
      setVoicesLoading(false);
      return;
    }
    let cancelled = false;
    const backend = formBackend;
    const config = formConfig;
    setVoicesLoading(true);
    setVoicesError(null);
    const timer = setTimeout(() => {
      listTtsDraftVoices({ backend, config })
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
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsRemoteVoices, voicesConfigKey, formBackend, formConfig]);

  // Models (F3): fetched from the server for gemini + openai-compatible via
  // the transient draft endpoint — mirrors the voices effect (debounced,
  // JSON-stringified config dep). Kokoro/elevenlabs have no model listing.
  const needsRemoteModels =
    formBackend === TTS_BACKEND.Gemini || formBackend === TTS_BACKEND.OpenAiCompatible;
  const modelsConfigKey = formConfig === undefined ? null : JSON.stringify(formConfig);
  useEffect(() => {
    if (!needsRemoteModels || modelsConfigKey === null) {
      setModels(null);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    const backend = formBackend as string;
    const config = formConfig as Record<string, unknown>;
    setModelsLoading(true);
    setModelsError(null);
    const timer = setTimeout(() => {
      listTtsDraftModels({ backend, config })
        .then((list) => {
          if (cancelled) return;
          setModels(list);
          setModelsLoading(false);
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
  }, [needsRemoteModels, modelsConfigKey, formBackend, formConfig]);

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
          <div>
            <label className={lblCls}>{t("tts_kokoro_model")}</label>
            <KokoroModelPanel />
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
            <TtsApiKeyField
              value={configString(form.config, "apiKey")}
              onChange={(v) => updateConfigField(tts, form, "apiKey", v)}
              placeholder="sk-..."
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className={lblCls}>{t("tts_field_model")}</label>
              <button
                type="button"
                data-testid="tts-models-refresh"
                onClick={() => {
                  if (!needsRemoteModels || formConfig === undefined) return;
                  const backend = formBackend as string;
                  const config = formConfig as Record<string, unknown>;
                  setModelsLoading(true);
                  setModelsError(null);
                  listTtsDraftModels({ backend, config })
                    .then((list) => {
                      setModels(list);
                      setModelsLoading(false);
                    })
                    .catch((cause) => {
                      setModelsError(cause instanceof Error ? cause.message : String(cause));
                      setModelsLoading(false);
                    });
                }}
                disabled={modelsLoading}
                className="flex items-center gap-1 rounded border border-s3 px-2 py-1 font-ui text-[11px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-40"
              >
                <Ic.regen />
                {modelsLoading ? t("tts_models_loading") : t("tts_models_refresh")}
              </button>
            </div>
            <div className="mt-1">
              {/* Manual fallback (F3): DropdownSelect is filter-only, so while the
                  fetched list is empty/unavailable the field degrades to a plain
                  input — a half-configured local endpoint must stay typeable. */}
              {models !== null && models.length > 0 ? (
                <DropdownSelect
                  value={configString(form.config, "model")}
                  options={(() => {
                    const current = configString(form.config, "model");
                    if (current === "" || models.some((o) => o.id === current)) return models;
                    return [{ id: current, label: current }, ...models];
                  })()}
                  onChange={(value) => updateConfigField(tts, form, "model", value)}
                  searchable={true}
                  placeholder="kokoro"
                  triggerTestId="tts-field-model"
                />
              ) : (
                <input
                  data-testid="tts-field-model"
                  className={monoUICls + " w-full px-3 py-2 text-[13px]"}
                  value={configString(form.config, "model")}
                  onChange={(e) => updateConfigField(tts, form, "model", e.target.value)}
                  placeholder="kokoro"
                />
              )}
            </div>
            {modelsError !== null && (
              <div data-testid="tts-models-error" className="mt-1 font-ui text-[11px] text-danger">
                {t("tts_models_load_error")}
              </div>
            )}
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
            <TtsApiKeyField
              value={configString(form.config, "apiKey")}
              onChange={(v) => updateConfigField(tts, form, "apiKey", v)}
              placeholder="AIza..."
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className={lblCls}>{t("tts_field_model")}</label>
              <button
                type="button"
                data-testid="tts-models-refresh"
                onClick={() => {
                  if (!needsRemoteModels || formConfig === undefined) return;
                  const backend = formBackend as string;
                  const config = formConfig as Record<string, unknown>;
                  setModelsLoading(true);
                  setModelsError(null);
                  listTtsDraftModels({ backend, config })
                    .then((list) => {
                      setModels(list);
                      setModelsLoading(false);
                    })
                    .catch((cause) => {
                      setModelsError(cause instanceof Error ? cause.message : String(cause));
                      setModelsLoading(false);
                    });
                }}
                disabled={modelsLoading}
                className="flex items-center gap-1 rounded border border-s3 px-2 py-1 font-ui text-[11px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-40"
              >
                <Ic.regen />
                {modelsLoading ? t("tts_models_loading") : t("tts_models_refresh")}
              </button>
            </div>
            <div className="mt-1">
              {/* Same manual fallback as openai-compat (F3): a failed/unfetched
                  list must not block pasting a model id. */}
              {models !== null && models.length > 0 ? (
                <DropdownSelect
                  value={configString(form.config, "model")}
                  options={(() => {
                    const current = configString(form.config, "model");
                    if (current === "" || models.some((o) => o.id === current)) return models;
                    return [{ id: current, label: current }, ...models];
                  })()}
                  onChange={(value) => updateConfigField(tts, form, "model", value)}
                  searchable={true}
                  placeholder="gemini-2.5-flash-preview-tts"
                  triggerTestId="tts-field-model"
                />
              ) : (
                <input
                  data-testid="tts-field-model"
                  className={monoUICls + " w-full px-3 py-2 text-[13px]"}
                  value={configString(form.config, "model")}
                  onChange={(e) => updateConfigField(tts, form, "model", e.target.value)}
                  placeholder="gemini-2.5-flash-preview-tts"
                />
              )}
            </div>
            {modelsError !== null && (
              <div data-testid="tts-models-error" className="mt-1 font-ui text-[11px] text-danger">
                {t("tts_models_load_error")}
              </div>
            )}
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
            <TtsApiKeyField
              value={configString(form.config, "apiKey")}
              onChange={(v) => updateConfigField(tts, form, "apiKey", v)}
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

      {isOpenAi && <TtsLocalServerPanel tts={tts} form={form} />}

      <div className="flex flex-col gap-1">
        <button
          type="button"
          data-testid="tts-preview-btn"
          disabled={preview.state !== "idle"}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40 disabled:pointer-events-none"
          onClick={() =>
            preview.preview({
              backend: form.backend,
              voiceId: form.voiceId,
              speed: configNumber(form.config, "speed", 1),
              config: form.config,
            })
          }
        >
          <Ic.speaker className="h-3.5 w-3.5" />
          {preview.state === "generating"
            ? preview.downloadPct !== null
              ? t("tts_preview_downloading", { pct: preview.downloadPct })
              : t("tts_preview_generating")
            : preview.state === "playing"
              ? t("tts_preview_playing")
              : t("tts_preview")}
        </button>
        {preview.error && (
          <div data-testid="tts-preview-error" className="font-ui text-[11px] text-danger">
            {t("tts_preview_failed")}: {preview.error}
          </div>
        )}
      </div>

      {form.id !== null && <TtsBindingFields tts={tts} form={form} />}

      {tts.error && (
        <div data-testid="tts-editor-error" className="rounded-md bg-danger/10 px-3 py-2 font-ui text-[12px] text-danger">
          {tts.error}
        </div>
      )}

      {/* Save/Delete live in the modal FOOTER (MasterDetailFooter, ProviderModal
          audio branch) per the master-detail house pattern — same fix as the
          regex/service tabs. Nothing inline here. */}
    </div>
  );
}
