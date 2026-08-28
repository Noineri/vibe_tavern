import { useEffect, useState, type ReactNode } from "react";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { Ic, Icons } from "../../../shared/icons.js";
import { inputCls, lblCls, monoUICls } from "../../../build/fields/field-styles.js";
import { cn } from "../../../../lib/cn.js";
import { AnimatedDisclosure } from "../../../shared/AnimatedDisclosure.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { SliderField } from "../../../shared/SliderField.js";
import { Toggle } from "../../../shared/Toggle.js";
import { listTtsDraftModels, listTtsDraftVoices, type TtsVoiceRecord } from "../../../../api/tts-api.js";
import { useTtsPreview } from "./use-tts-preview.js";
import { TtsBindingFields } from "./TtsBindingFields.js";
import { configString, formDraftConfig, updateConfigField } from "./tts-form-helpers.js";
import {
  ttsPresetIdOf,
  ttsUiSpecFor,
  ttsUiVariantOf,
  type TtsTuningFieldSpec,
  type TtsUiVariant,
} from "./tts-backend-ui.js";
import { TtsProviderForm } from "./TtsProviderForm.js";
import { TtsBaseCard } from "./TtsBaseCard.js";
import { TTS_PRESETS } from "../../../../lib/tts/tts-presets.js";
import { KOKORO_VOICES, kokoroVoiceLabel } from "../../../../lib/tts/kokoro-voices.js";
import type { TtsProfileForm, useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
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
      <div className="rounded-lg border border-border2 bg-s2 px-4 py-2.5" data-testid={`tts-toggle-card-${field.key}`}>
        <div className="flex items-center gap-3">
          <Toggle
            checked={form.config[field.key] === true}
            onChange={(checked) => updateConfigField(tts, form, field.key, checked || undefined)}
            aria-label={t(field.labelKey)}
          />
          <div className="font-ui text-[13px] font-medium text-t1">{t(field.labelKey)}</div>
        </div>
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
  const [tuningOpen, setTuningOpen] = useState(false);
  const formBackend = tts.form?.backend;
  // TE2-16: the form's typed apiKey is injected into the TRANSIENT draft
  // requests only (formDraft below) — the stored bag never carries it.
  const formDraft = tts.form === null || tts.form === undefined ? undefined : formDraftConfig(tts.form);
  const formId = tts.form?.id ?? null;
  const needsRemoteVoices = formBackend !== undefined && formBackend !== TTS_BACKEND.Kokoro;
  const preview = useTtsPreview();

  // Hooks stay ABOVE the early return — `if (!tts.form) return null` between
  // useState and useEffect would be a hooks-order violation the day any
  // caller keeps this mounted across a form→null transition.
  //
  // Voices come from the TRANSIENT draft endpoint (F1): the CURRENT form
  // config, saved or not. profileId (TE2-16) lets the server inject the
  // STORED typed-column key when the form's apiKey is empty and the identity
  // matches. The dep is a serialized config key (object identity changes per
  // keystroke), debounced so typing an endpoint/key doesn't spam the backend.
  const voicesConfigKey = formDraft === undefined ? null : JSON.stringify(formDraft);
  useEffect(() => {
    if (!needsRemoteVoices || formDraft === undefined) {
      setVoices(null);
      setVoicesError(null);
      setVoicesLoading(false);
      return;
    }
    let cancelled = false;
    const backend = formBackend;
    const config = formDraft;
    const profileId = formId ?? undefined;
    setVoicesLoading(true);
    setVoicesError(null);
    // A new (debounced) fetch starts from an empty slate — a stale list
    // from a previous profile/backend must never render under a dead or
    // switched endpoint (honest-data rule, same as models below).
    setVoices(null);
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
  }, [needsRemoteVoices, voicesConfigKey, formBackend, formDraft, formId]);

  // Models (F3): fetched from the server for fetch-mode model fields (the
  // local/openai/gemini variants) via the transient draft endpoint —
  // mirrors the voices effect (debounced, JSON-stringified config dep,
  // profileId stored-key resolution).
  const needsRemoteModels =
    (formBackend === TTS_BACKEND.Gemini || formBackend === TTS_BACKEND.OpenAiCompatible) &&
    formDraft !== undefined;
  const modelsConfigKey = formDraft === undefined ? null : JSON.stringify(formDraft);
  useEffect(() => {
    if (!needsRemoteModels || modelsConfigKey === null) {
      setModels(null);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    const backend = formBackend as string;
    const config = formDraft;
    const profileId = formId ?? undefined;
    setModelsLoading(true);
    setModelsError(null);
    // Same slate rule: while the new fetch is in flight (or failing — a
    // dead local server), the field must degrade to manual input, never
    // keep rendering the previous profile's model list.
    setModels(null);
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
  }, [needsRemoteModels, modelsConfigKey, formBackend, formDraft, formId]);

  if (!tts.form) return null;

  const form = tts.form;
  const variant = ttsUiVariantOf(form.backend, form.config);
  const spec = ttsUiSpecFor(variant);

  function handleApplyPreset(presetId: string): void {
    const preset = TTS_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const nextBackend =
      preset.backend === "gemini"
        ? TTS_BACKEND.Gemini
        : preset.backend === "elevenlabs"
          ? TTS_BACKEND.ElevenLabs
          : TTS_BACKEND.OpenAiCompatible;
    const nextConfig: Record<string, unknown> = {};
    if (preset.baseUrl) nextConfig["endpoint"] = preset.baseUrl;
    nextConfig["preset"] = preset.id;
    tts.setForm({ backend: nextBackend, config: nextConfig, voiceId: "" });
  }

  function handleUpdateForm<K extends keyof TtsProfileForm>(k: K, v: TtsProfileForm[K]): void {
    // Generic computed-key object can't be proven assignable — single scoped cast.
    tts.setForm({ [k]: v } as Pick<TtsProfileForm, K>);
  }

  const modelSpec = spec.connection.model;
  const hasConnectionCard = spec.connection.endpoint !== undefined || spec.connection.apiKey !== undefined || modelSpec !== undefined;
  const savedProfile =
    tts.editingId !== null ? (tts.profiles.find((p) => p.id === tts.editingId) ?? null) : null;
  const isView = tts.headerMode === "view" && savedProfile !== null;
  const isEdit = tts.headerMode === "edit";

  return (
    <div data-testid="tts-profile-editor" className="flex flex-col gap-4">
      {isEdit ? (
        <TtsProviderForm
          form={form}
          editingId={form.id}
          ttsProfiles={tts.profiles}
          updateForm={handleUpdateForm}
          applyPreset={handleApplyPreset}
          testOk={null}
          testing={false}
          testingChat={false}
          chatResult={null}
          onTest={() => {}}
          onTestChat={() => {}}
          tts={tts}
        />
      ) : savedProfile !== null ? (
        <>
          <TtsBaseCard
            profile={savedProfile}
            form={form}
            isDefault={savedProfile.isDefault}
            onEdit={tts.startEdit}
            onSetDefault={() => void tts.setDefault(savedProfile.id)}
          />
          {/* View mode (LLM headerMode mechanism): compact card on top,
              config sections always visible below — voices first (plan
              Goal: always-visible voice/speed/binding sections). */}
          <TtsSectionCard title={t("tts_field_voice")} testid="tts-voice-section">
            <TtsVoiceFields
              form={form}
              updateForm={handleUpdateForm}
              voicePlaceholder={spec.voicePlaceholder}
              staticVoices={ttsStaticVoicesOf(form)}
              voices={voices}
              voicesLoading={voicesLoading}
              voicesError={voicesError}
            />
          </TtsSectionCard>

      {/* ── Connection card (D5): model choice, rendered from the variant
          spec — kokoro has none (browser-local). View mode only (the edit
          screen is connection-form-only, LLM mechanism). */}
      {hasConnectionCard && (
        <TtsSectionCard title={t("tts_section_connection")} testid="tts-connection-card">

          {modelSpec?.mode === "fetch" && (
            <div>
              <div className="flex items-center justify-between">
                <label className={lblCls}>{t(modelSpec.labelKey)}</label>
                <button
                  type="button"
                  data-testid="tts-models-refresh"
                  onClick={() => {
                    if (!needsRemoteModels || formDraft === undefined) return;
                    const backend = formBackend as string;
                    const config = formDraft;
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

      {/* Local-server helpers now owned by the form (defect 3) — editor copy removed. */}

      {/* Tuning accordion — progressive disclosure forked verbatim from ProviderSamplerPanel/TtsLocalServerPanel */}
      <div data-testid="tts-voice-card">
        <div className="overflow-hidden rounded-lg border border-border2" data-testid="tts-tuning-accordion">
          <div
            className={cn(
              "flex w-full items-center justify-between bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] cursor-pointer",
              tuningOpen && "!rounded-b-none",
            )}
          >
            <span
              className="flex items-center gap-2"
              onClick={() => setTuningOpen(!tuningOpen)}
              data-testid="tts-tuning-accordion-toggle"
            >
              <span className={cn("transition-transform", tuningOpen && "rotate-90")}>
                <Icons.Caret direction="r" />
              </span>
              {t("tts_section_voice_tuning")}
            </span>
          </div>
          <AnimatedDisclosure open={tuningOpen} className="border-t border-border2 bg-surface p-4" data-testid="tts-tuning-accordion-body">
            <div className="flex flex-col gap-3">
              {spec.tuning.map((field) => (
                <TtsTuningField key={field.key + field.kind} tts={tts} form={form} field={field} />
              ))}
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
                      narratorVoiceId: form.narratorVoiceId,
                      speed: configNumber(form.config, "speed", 1),
                      config: formDraftConfig(form),
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
            </div>
          </AnimatedDisclosure>
        </div>
      </div>

      {form.id !== null && <TtsBindingFields tts={tts} form={form} />}
        </>
      ) : null}

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

export interface TtsVoiceFieldsProps {
  form: TtsProfileForm;
  updateForm: <K extends keyof TtsProfileForm>(k: K, v: TtsProfileForm[K]) => void;
  /** Per-variant placeholder override (tts-backend-ui spec), if any. */
  voicePlaceholder?: string;
  /** Static preset roster — non-null only for voiceMode "static" presets. */
  staticVoices: Array<{ id: string; label: string }> | null;
  /** Editor-owned dynamic discovery state (single fetch owner). */
  voices: TtsVoiceRecord[] | null;
  voicesLoading: boolean;
  voicesError: string | null;
}

/** Static preset roster for the form's config.preset — null when the profile
 *  is not preset-static (kokoro, dynamic fetch, native backends). */
export function ttsStaticVoicesOf(form: TtsProfileForm): Array<{ id: string; label: string }> | null {
  const presetId = ttsPresetIdOf(form.config);
  const preset = presetId ? TTS_PRESETS.find((p) => p.id === presetId) : undefined;
  if (preset?.voiceMode === "static" && preset.staticVoices && preset.staticVoices.length > 0) {
    return preset.staticVoices;
  }
  return null;
}

/** The character + narrator voice pickers (TE2-9): kokoro manifest dropdown,
 *  static preset roster, or the editor-fetched dynamic list with the TE2-3
 *  null-contract degradation. Rendered ONLY in the editor's view mode —
 *  the connection form (edit screen) never shows voices (LLM mechanism:
 *  header form is connection-only; voices are a config section below the
 *  base card, always visible in view mode). */
export function TtsVoiceFields({
  form,
  updateForm,
  voicePlaceholder,
  staticVoices,
  voices,
  voicesLoading,
  voicesError,
}: TtsVoiceFieldsProps): ReactNode {
  const { t } = useT();
  const isKokoro = form.backend === TTS_BACKEND.Kokoro;
  const placeholder = voicePlaceholder ?? t("tts_field_voice");
  const kokoroVoiceOptions = KOKORO_VOICES.filter((v) => v.lang === "a" || v.lang === "b").map((v) => ({
    id: v.id,
    label: kokoroVoiceLabel(v, t),
  }));
  if (isKokoro) {
    return (
      <>
        <div className="mb-3">
      <label className={lblCls}>{t("tts_field_voice")}</label>
      <div className="mt-1">
        <DropdownSelect
          value={form.voiceId}
          options={kokoroVoiceOptions}
          onChange={(value) => updateForm("voiceId", value)}
          searchable={true}
          placeholder={placeholder}
          triggerTestId="tts-voice-select"
        />
      </div>
        </div>
        <div className="mb-3">
      <label className={lblCls}>{t("tts_field_narrator_voice")}</label>
      <div className="mt-1">
        <DropdownSelect
          value={form.narratorVoiceId}
          options={[{ id: "", label: t("tts_field_narrator_voice_none") }, ...kokoroVoiceOptions]}
          onChange={(value) => updateForm("narratorVoiceId", value)}
          searchable={true}
          placeholder={t("tts_field_narrator_voice_none")}
          triggerTestId="tts-narrator-voice-select"
        />
      </div>
      <div className="mt-1 font-ui text-[11px] text-t3">{t("tts_field_narrator_voice_hint")}</div>
        </div>
      </>
    );
  }
  if (staticVoices !== null) {
    return (
      <>
        <div className="mb-3">
      <label className={lblCls}>{t("tts_field_voice")}</label>
      <div className="mt-1">
        <DropdownSelect
          value={form.voiceId}
          options={staticVoices}
          onChange={(value) => updateForm("voiceId", value)}
          searchable={true}
          placeholder={placeholder}
          triggerTestId="tts-voice-select"
        />
      </div>
        </div>
        <div className="mb-3">
      <label className={lblCls}>{t("tts_field_narrator_voice")}</label>
      <div className="mt-1">
        <DropdownSelect
          value={form.narratorVoiceId}
          options={[{ id: "", label: t("tts_field_narrator_voice_none") }, ...staticVoices]}
          onChange={(value) => updateForm("narratorVoiceId", value)}
          searchable={true}
          placeholder={t("tts_field_narrator_voice_none")}
          triggerTestId="tts-narrator-voice-select"
        />
      </div>
      <div className="mt-1 font-ui text-[11px] text-t3">{t("tts_field_narrator_voice_hint")}</div>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="mb-3">
        <label className={lblCls}>{t("tts_field_voice")}</label>
        {voicesLoading ? (
      <div data-testid="tts-voices-loading" className="mt-1 font-ui text-[12px] text-t3">
        {t("tts_voices_loading")}
      </div>
        ) : voicesError !== null ? (
      <>
        <input
          data-testid="tts-voice-input"
          className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
          value={form.voiceId}
          onChange={(e) => updateForm("voiceId", e.target.value)}
          placeholder={placeholder}
        />
        <div data-testid="tts-voices-load-error" className="mt-1 font-ui text-[11px] text-danger">
          {t("tts_voices_load_error")}
        </div>
      </>
        ) : voices !== null && voices.length === 0 ? (
      <input
        data-testid="tts-voice-input"
        className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
        value={form.voiceId}
        onChange={(e) => updateForm("voiceId", e.target.value)}
        placeholder={placeholder}
      />
        ) : (
      <div className="mt-1">
        <DropdownSelect
          value={form.voiceId}
          options={(voices ?? []).map((v) => ({ id: v.id, label: v.label || v.id }))}
          onChange={(value) => updateForm("voiceId", value)}
          searchable={true}
          placeholder={placeholder}
          triggerTestId="tts-voice-select"
        />
      </div>
        )}
      </div>
      <div className="mb-3">
        <label className={lblCls}>{t("tts_field_narrator_voice")}</label>
        {voicesLoading ? (
      <div data-testid="tts-narrator-voices-loading" className="mt-1 font-ui text-[12px] text-t3">
        {t("tts_voices_loading")}
      </div>
        ) : voicesError !== null ? (
      <input
        data-testid="tts-narrator-voice-input"
        className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
        value={form.narratorVoiceId}
        onChange={(e) => updateForm("narratorVoiceId", e.target.value)}
        placeholder={t("tts_field_narrator_voice_none")}
      />
        ) : voices !== null && voices.length === 0 ? (
      <input
        data-testid="tts-narrator-voice-input"
        className={monoUICls + " mt-1 px-3 py-2 text-[13px]"}
        value={form.narratorVoiceId}
        onChange={(e) => updateForm("narratorVoiceId", e.target.value)}
        placeholder={t("tts_field_narrator_voice_none")}
      />
        ) : (
      <div className="mt-1">
        <DropdownSelect
          value={form.narratorVoiceId}
          options={[{ id: "", label: t("tts_field_narrator_voice_none") }, ...(voices ?? []).map((v) => ({ id: v.id, label: v.label || v.id }))]}
          onChange={(value) => updateForm("narratorVoiceId", value)}
          searchable={true}
          placeholder={t("tts_field_narrator_voice_none")}
          triggerTestId="tts-narrator-voice-select"
        />
      </div>
        )}
        <div className="mt-1 font-ui text-[11px] text-t3">{t("tts_field_narrator_voice_hint")}</div>
      </div>
    </>
  );
}
