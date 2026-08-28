import { useEffect, useState, type ReactNode } from "react";
import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { Ic } from "../../../shared/icons.js";
import { inputCls, lblCls, monoUICls } from "../../../build/fields/field-styles.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { SliderField } from "../../../shared/SliderField.js";
import { Toggle } from "../../../shared/Toggle.js";
import { KOKORO_VOICES, kokoroVoiceLabel } from "../../../../lib/tts/kokoro-voices.js";
import { listTtsDraftModels, listTtsDraftVoices, type TtsVoiceRecord } from "../../../../api/tts-api.js";
import { TtsApiKeyField } from "./TtsApiKeyField.js";
import { useTtsPreview } from "./use-tts-preview.js";
import { TtsBindingFields } from "./TtsBindingFields.js";
import { TtsLocalServerPanel } from "./TtsLocalServerPanel.js";
import { KokoroModelPanel } from "./KokoroModelPanel.js";
import { configString, updateConfigField } from "./tts-form-helpers.js";
import {
  TTS_LOCAL_SERVER_FLAG,
  backendForVariant,
  ttsUiSpecFor,
  ttsUiVariantOf,
  type TtsTuningFieldSpec,
  type TtsUiVariant,
} from "./tts-backend-ui.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
}

/** The per-backend voice picker: async server voice list (draft endpoint,
 *  F1) with loading and error-fallback states; degrades to a plain input.
 *  Kokoro does not go through here (static manifest picker below). */
function TtsVoicePickerField({
  tts,
  form,
  voices,
  voicesLoading,
  voicesError,
  voicePlaceholder,
}: {
  tts: TtsHook;
  form: NonNullable<TtsHook["form"]>;
  voices: TtsVoiceRecord[] | null;
  voicesLoading: boolean;
  voicesError: string | null;
  voicePlaceholder?: string;
}): ReactNode {
  const { t } = useT();
  const placeholder = voicePlaceholder ?? t("tts_field_voice");
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
          placeholder={placeholder}
        />
        <div data-testid="tts-voices-load-error" className="mt-1 font-ui text-[11px] text-danger">
          {t("tts_voices_load_error")}
        </div>
      </>
    );
  }
  if (voices !== null && voices.length === 0) {
    return (
      <input
        data-testid="tts-voice-input"
        className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
        value={form.voiceId}
        onChange={(e) => tts.setForm({ voiceId: e.target.value })}
        placeholder={placeholder}
      />
    );
  }
  return (
    <div className="mt-1">
      <DropdownSelect
        value={form.voiceId}
        options={(voices ?? []).map((v) => ({ id: v.id, label: v.label || v.id }))}
        onChange={(value) => tts.setForm({ voiceId: value })}
        searchable={true}
        placeholder={placeholder}
        triggerTestId="tts-voice-select"
      />
    </div>
  );
}

/** One section card of the restructured editor (D5): a titled block that
 *  groups related fields instead of one flat per-backend list. */
function TtsSectionCard({ title, testid, children }: { title: string; testid: string; children: ReactNode }): ReactNode {
  return (
    <div data-testid={testid} className="flex flex-col gap-3 rounded-lg border border-border bg-s1 px-3.5 py-3">
      <div className="font-ui text-[12px] font-medium tracking-wide text-t2 uppercase">{title}</div>
      {children}
    </div>
  );
}

/** Renders ONE declarative tuning field from the variant spec (D5): the
 *  duplicated per-backend JSX branches collapse into this single switch. */
function TtsTuningField({ tts, form, field }: { tts: TtsHook; form: NonNullable<TtsHook["form"]>; field: TtsTuningFieldSpec }): ReactNode {
  const { t } = useT();
  if (field.kind === "number") {
    const val = configNumber(form.config, field.key, field.fallback);
    return (
      <SliderField
        label={t(field.labelKey)}
        value={val}
        min={field.min}
        max={field.max}
        step={field.step}
        onChange={(v) => updateConfigField(tts, form, field.key, v)}
        ariaLabel={t(field.labelKey)}
        rangeTestId={`tts-field-${field.key}-range`}
        numberTestId={`tts-field-${field.key}-number`}
      />
    );
  }
  if (field.kind === "toggle") {
    return (
      <div className="flex items-center gap-2">
        <label className={lblCls}>{t(field.labelKey)}</label>
        <Toggle
          checked={form.config[field.key] === true}
          onChange={(checked) => updateConfigField(tts, form, field.key, checked || undefined)}
          aria-label={t(field.labelKey)}
        />
      </div>
    );
  }
  if (field.kind === "textarea") {
    return (
      <div>
        <label className={lblCls}>{t(field.labelKey)}</label>
        <AutoTextarea
          className={inputCls + " mt-1 px-3 py-2 text-[13px]"}
          value={configString(form.config, field.key)}
          onChange={(e) => updateConfigField(tts, form, field.key, e.target.value)}
          placeholder={t(field.placeholderKey)}
          minRows={2}
          maxRows={6}
          data-testid="tts-field-style-instructions"
        />
      </div>
    );
  }
  return (
    <div>
      <label className={lblCls}>{t(field.labelKey)}</label>
      <div className="mt-1">
        <DropdownSelect
          value={configString(form.config, field.key, field.fallback)}
          options={field.options}
          onChange={(value) => updateConfigField(tts, form, field.key, value)}
          searchable={false}
          triggerTestId={field.testid}
        />
      </div>
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
  const formId = tts.form?.id ?? null;
  const needsRemoteVoices = formBackend !== undefined && formBackend !== TTS_BACKEND.Kokoro;
  const preview = useTtsPreview();

  // Hooks stay ABOVE the early return — `if (!tts.form) return null` between
  // useState and useEffect would be a hooks-order violation the day any
  // caller keeps this mounted across a form→null transition.
  //
  // Voices come from the TRANSIENT draft endpoint (F1): the CURRENT form
  // config, saved or not. profileId (F2b) lets the server inject the STORED
  // key when the form's apiKey is empty (strip-on-read) and the identity
  // matches. The dep is a serialized config key (object identity changes per
  // keystroke), debounced so typing an endpoint/key doesn't spam the backend.
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
    const profileId = formId ?? undefined;
    setVoicesLoading(true);
    setVoicesError(null);
    const timer = setTimeout(() => {
      listTtsDraftVoices({ backend, config, profileId })
        .then((list) => {
          if (cancelled) return;
          if (list === null) {
            setVoices(null);
            setVoicesError("unavailable");
            setVoicesLoading(false);
            return;
          }
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
  }, [needsRemoteVoices, voicesConfigKey, formBackend, formConfig, formId]);

  // Models (F3): fetched from the server for fetch-mode model fields (the
  // local/openai/gemini variants) via the transient draft endpoint —
  // mirrors the voices effect (debounced, JSON-stringified config dep,
  // profileId stored-key resolution).
  const needsRemoteModels =
    (formBackend === TTS_BACKEND.Gemini || formBackend === TTS_BACKEND.OpenAiCompatible) &&
    formConfig !== undefined;
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
    const profileId = formId ?? undefined;
    setModelsLoading(true);
    setModelsError(null);
    const timer = setTimeout(() => {
      listTtsDraftModels({ backend, config, profileId })
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
  }, [needsRemoteModels, modelsConfigKey, formBackend, formConfig, formId]);

  if (!tts.form) return null;

  const form = tts.form;
  const variant = ttsUiVariantOf(form.backend, form.config);
  const spec = ttsUiSpecFor(variant);
  const isKokoro = variant === "kokoro";

  const backendOptions: Array<{ id: TtsUiVariant; label: string }> = [
    { id: "kokoro", label: t("tts_backend_kokoro") },
    { id: "local", label: t("tts_backend_local_server") },
    { id: "openai", label: t("tts_backend_openai_compatible") },
    { id: "gemini", label: t("tts_backend_gemini") },
    { id: "elevenlabs", label: t("tts_backend_elevenlabs") },
  ];

  /** Variant switch (D8): "local" and "openai" share the wire backend — the
   *  flip keeps the typed config and toggles only the localServer marker;
   *  any real backend change resets config/voice via setForm's reset rule. */
  function onVariantChange(next: string): void {
    const target = next as TtsUiVariant;
    const backend = backendForVariant(target);
    if (target === "local" || target === "openai") {
      const nextConfig = { ...form.config };
      if (target === "local") nextConfig[TTS_LOCAL_SERVER_FLAG] = true;
      else delete nextConfig[TTS_LOCAL_SERVER_FLAG];
      tts.setForm({ backend, config: nextConfig });
      return;
    }
    tts.setForm({ backend });
  }

  const kokoroVoiceOptions = KOKORO_VOICES.filter((v) => v.lang === "a" || v.lang === "b").map((v) => ({
    id: v.id,
    // Human-readable picker label (owner request): "Heart · Female · American · A"
    // — the stored voiceId stays the raw id (af_heart).
    label: kokoroVoiceLabel(v, t),
  }));

  const modelSpec = spec.connection.model;
  const hasConnectionCard = spec.connection.endpoint !== undefined || spec.connection.apiKey !== undefined || modelSpec !== undefined;

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
            value={variant}
            options={backendOptions}
            onChange={onVariantChange}
            searchable={false}
            triggerTestId="tts-backend-select"
          />
        </div>
      </div>

      {/* ── Connection card (D5): identity + credentials + model choice.
          Rendered from the variant spec — kokoro has none (browser-local). */}
      {hasConnectionCard && (
        <TtsSectionCard title={t("tts_section_connection")} testid="tts-connection-card">
          {spec.connection.endpoint !== undefined && (
            <div>
              <label className={lblCls}>{t("tts_field_endpoint")}</label>
              <input
                data-testid="tts-field-endpoint"
                className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
                value={configString(form.config, "endpoint")}
                onChange={(e) => updateConfigField(tts, form, "endpoint", e.target.value)}
                placeholder={spec.connection.endpoint.placeholder}
              />
            </div>
          )}
          {spec.connection.apiKey !== undefined && (
            <div>
              <label className={lblCls}>{t("tts_field_api_key")}</label>
              <TtsApiKeyField
                value={configString(form.config, "apiKey")}
                onChange={(v) => updateConfigField(tts, form, "apiKey", v)}
                placeholder={spec.connection.apiKey.placeholder}
                stored={form.hasStoredApiKey}
              />
            </div>
          )}
          {modelSpec?.mode === "fetch" && (
            <div>
              <div className="flex items-center justify-between">
                <label className={lblCls}>{t(modelSpec.labelKey)}</label>
                <button
                  type="button"
                  data-testid="tts-models-refresh"
                  onClick={() => {
                    if (!needsRemoteModels || formConfig === undefined) return;
                    const backend = formBackend as string;
                    const config = formConfig as Record<string, unknown>;
                    const profileId = formId ?? undefined;
                    setModelsLoading(true);
                    setModelsError(null);
                    listTtsDraftModels({ backend, config, profileId })
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
                    value={configString(form.config, modelSpec.key)}
                    options={(() => {
                      const current = configString(form.config, modelSpec.key);
                      if (current === "" || models.some((o) => o.id === current)) return models;
                      return [{ id: current, label: current }, ...models];
                    })()}
                    onChange={(value) => updateConfigField(tts, form, modelSpec.key, value)}
                    searchable={true}
                    placeholder={modelSpec.placeholder}
                    triggerTestId="tts-field-model"
                  />
                ) : (
                  <input
                    data-testid="tts-field-model"
                    className={monoUICls + " w-full px-3 py-2 text-[13px]"}
                    value={configString(form.config, modelSpec.key)}
                    onChange={(e) => updateConfigField(tts, form, modelSpec.key, e.target.value)}
                    placeholder={modelSpec.placeholder}
                  />
                )}
              </div>
              {modelsError !== null && (
                <div data-testid="tts-models-error" className="mt-1 font-ui text-[11px] text-danger">
                  {t("tts_models_load_error")}
                </div>
              )}
            </div>
          )}
          {modelSpec?.mode === "input" && (
            <div>
              <label className={lblCls}>{t(modelSpec.labelKey)}</label>
              <input
                data-testid="tts-field-model-id"
                className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
                value={configString(form.config, modelSpec.key)}
                onChange={(e) => updateConfigField(tts, form, modelSpec.key, e.target.value)}
                placeholder={modelSpec.placeholder}
              />
            </div>
          )}
        </TtsSectionCard>
      )}

      {/* ── Local-server helpers (D8): ONLY the "local" variant mounts the
          quickstart/discovery panel — a cloud API profile never sees it. */}
      {spec.localHelpers && <TtsLocalServerPanel tts={tts} form={form} />}

      {/* ── Voice & tuning card (D5): voice selector + declarative tuning
          fields + the preview ("audition") button. */}
      <TtsSectionCard title={t("tts_section_voice_tuning")} testid="tts-voice-card">
        <div>
          <label className={lblCls}>{t("tts_field_voice")}</label>
          {isKokoro ? (
            <div className="mt-1">
              <DropdownSelect
                value={form.voiceId}
                options={kokoroVoiceOptions}
                onChange={(value) => tts.setForm({ voiceId: value })}
                searchable={true}
                placeholder={spec.voicePlaceholder ?? t("tts_field_voice")}
                triggerTestId="tts-voice-select"
              />
            </div>
          ) : (
            <TtsVoicePickerField
              tts={tts}
              form={form}
              voices={voices}
              voicesLoading={voicesLoading}
              voicesError={voicesError}
              voicePlaceholder={spec.voicePlaceholder}
            />
          )}
        </div>
        {spec.tuning.map((field) => (
          <TtsTuningField key={field.key + field.kind} tts={tts} form={form} field={field} />
        ))}
        {isKokoro && (
          <div>
            <label className={lblCls}>{t("tts_kokoro_model")}</label>
            <KokoroModelPanel />
          </div>
        )}
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
                profileId: form.id,
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
      </TtsSectionCard>

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
