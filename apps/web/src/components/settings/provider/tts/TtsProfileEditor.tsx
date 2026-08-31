import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { cloneTtsVoice, listTtsDraftModels, listTtsDraftVoices, type TtsBackendCapabilities, type TtsModelListEntry, type TtsVoiceRecord } from "../../../../api/tts-api.js";
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
import { TtsModelPicker } from "./TtsModelPicker.js";
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

/** Voice-cloning section (clone field design, agreed with the owner
 *  2026-08-31): name + reference audio + Clone button with inline
 *  error/result — rendered only for backends that reported the capability
 *  (the editor gates it). Single reusable form; provider differences live
 *  in the backend adapters, not here. No language field in v1; mic input is
 *  mic-later. The audio passes through the server's memory only — nothing
 *  is persisted. */
function TtsVoiceCloneCard({ backend, config, profileId, capabilities, onCloned }: {
  backend: string;
  config: Record<string, unknown>;
  profileId: string | undefined;
  capabilities: TtsBackendCapabilities;
  onCloned: (voice: TtsVoiceRecord) => void;
}): ReactNode {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const formats = capabilities.formats ?? ["wav", "mp3", "flac", "m4a", "ogg"];
  const maxMb = capabilities.maxSizeMb ?? 10;

  async function handleClone(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      setError(t("tts_clone_err_name"));
      setResult(null);
      return;
    }
    if (file === null) {
      setError(t("tts_clone_err_file"));
      setResult(null);
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      setError(t("tts_clone_err_size", { size: maxMb }));
      setResult(null);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const voice = await cloneTtsVoice({ backend, config, profileId, name: trimmed, audio: file });
      onCloned(voice);
      setResult(t("tts_clone_success", { name: voice.label }));
      setName("");
      setFile(null);
      // Same-file re-pick must re-fire onChange — clearing the hidden input
      // is what makes the browser treat it as a fresh selection.
      if (fileRef.current !== null) fileRef.current.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TtsSectionCard title={t("tts_clone_section_title")} testid="tts-clone-section">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tts-clone-name" className={lblCls}>
          {t("tts_clone_name_label")}
        </label>
        <input
          id="tts-clone-name"
          data-testid="tts-clone-name"
          type="text"
          className={inputCls + " px-3 py-2 text-[13px]"}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={lblCls}>{t("tts_clone_file_label")}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="tts-clone-file-btn"
            className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            onClick={() => fileRef.current?.click()}
          >
            <Ic.import />
            {t("tts_clone_choose_file")}
          </button>
          <span data-testid="tts-clone-file-name" className="min-w-0 truncate font-ui text-[12px] text-t3">
            {file === null ? t("tts_clone_no_file") : file.name}
          </span>
          <input
            ref={fileRef}
            className="hidden"
            type="file"
            data-testid="tts-clone-file"
            accept={formats.map((f) => "." + f).join(",") + ",audio/*"}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
              setResult(null);
            }}
          />
        </div>
        <div data-testid="tts-clone-hint" className="font-ui text-[11px] text-t4">
          {t("tts_clone_hint", { formats: formats.join(" · "), size: maxMb })}
        </div>
        {backend === "minimax" ? (
          <div data-testid="tts-clone-hint-minimax" className="font-ui text-[11px] text-t4">
            {t("tts_clone_hint_minimax")}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="tts-clone-submit"
          disabled={busy}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40 disabled:pointer-events-none"
          onClick={() => void handleClone()}
        >
          <Ic.user />
          {busy ? t("tts_clone_busy") : t("tts_clone_action")}
        </button>
        {error !== null && (
          <span data-testid="tts-clone-error" className="font-ui text-[11px] text-danger">
            {error}
          </span>
        )}
        {result !== null && (
          <span data-testid="tts-clone-success" className="font-ui text-[11px] text-t2">
            {result}
          </span>
        )}
      </div>
    </TtsSectionCard>
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
  // Clone capability rides the voices envelope (clone field design
  // 2026-08-31): null voices (empty library) may still carry supportsCloning.
  const [cloneCaps, setCloneCaps] = useState<TtsBackendCapabilities | null>(null);
  const [models, setModels] = useState<TtsModelListEntry[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [tuningOpen, setTuningOpen] = useState(false);
  // Post-clone refresh (clone field design 2026-08-31): bumping this re-runs
  // the debounced voices effect so the picker picks up the fresh library —
  // the ONLY non-config trigger for it.
  const [voicesRefreshTick, setVoicesRefreshTick] = useState(0);
  const formBackend = tts.form?.backend;
  // TE2-16: the form's typed apiKey is injected into the TRANSIENT draft
  // requests only (formDraft below) — the stored bag never carries it.
  // Memoized on the form identity: the voices/models effects depend on it,
  // and a fresh object per render made them re-run on EVERY state change —
  // each re-run's cleanup cancelled the in-flight fetch, so the list never
  // landed (reproduced in the full-suite run; isolated runs hid it).
  const formDraft = useMemo(
    () => (tts.form === null || tts.form === undefined ? undefined : formDraftConfig(tts.form)),
    [tts.form],
  );
  const formId = tts.form?.id ?? null;
  const needsRemoteVoices = formBackend !== undefined && formBackend !== TTS_BACKEND.Kokoro;
  const preview = useTtsPreview();
  // Mirror of the live voiceId for the voices effect (D22): read at
  // fetch-completion time, NOT an effect dep — putting voiceId in the deps
  // would restart the debounced fetch (and blank the list) on every pick.
  const formVoiceIdRef = useRef("");
  formVoiceIdRef.current = tts.form?.voiceId ?? "";
  // Mirror of the live config bag (read at fetch-completion time) for the
  // auto-settle model write below (D20) — config is NOT an effect dep for
  // the same reason as voiceId (a dep would restart the debounced fetch).
  const formConfigRef = useRef<Record<string, unknown>>({});
  formConfigRef.current = tts.form?.config ?? {};

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
    // LLM rule (D20, owner directive): keep the user's pick while the roster
    // carries it; otherwise settle on the first roster entry. An empty or
    // stale (D22: rosters are model-scoped — switching models swaps the
    // roster) selection lands on list[0], so a profile always shows a real
    // voice from the server instead of a blank/example stub. Guarded so a
    // settled selection never loops; an empty roster keeps "" (manual
    // input stays honest).
    const settleVoice = (list: TtsVoiceRecord[]): void => {
      const current = formVoiceIdRef.current;
      if (current !== "" && list.some((v) => v.id === current)) return;
      const next = list[0]?.id ?? "";
      if (next !== current) tts.setForm({ voiceId: next });
    };
    const timer = setTimeout(() => {
      listTtsDraftVoices({ backend, config, profileId })
        .then(({ voices: list, capabilities }) => {
          if (cancelled) return;
          setCloneCaps(capabilities);
          if (list === null) {
            setVoices(null);
            setVoicesError("unavailable");
            setVoicesLoading(false);
            return;
          }
          settleVoice(list);
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
  }, [needsRemoteVoices, voicesConfigKey, formBackend, formDraft, formId, voicesRefreshTick]);

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
          // LLM rule (D20, owner directive): an empty model field settles
          // on the first fetched entry — same one-key semantics as
          // updateConfigField; a user pick survives refetches.
          if (list.length > 0 && configString(formConfigRef.current, "model") === "") {
            tts.setForm({ config: { ...formConfigRef.current, model: list[0].id } });
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
  }, [needsRemoteModels, modelsConfigKey, formBackend, formDraft, formId]);

  // Refresh button handler for the model picker (TtsModelPicker) — the
  // same fetch the debounced effect performs, on demand.
  const refreshModels = () => {
    if (!needsRemoteModels || formDraft === undefined) return;
    setModelsLoading(true);
    setModelsError(null);
    listTtsDraftModels({ backend: formBackend as string, config: formDraft, profileId: formId ?? undefined })
      .then((list) => {
        setModels(list);
        setModelsLoading(false);
      })
      .catch((cause) => {
        setModelsError(cause instanceof Error ? cause.message : String(cause));
        setModelsLoading(false);
      });
  };

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
          : preset.backend === "cartesia"
            ? TTS_BACKEND.Cartesia
            : preset.backend === "inworld"
              ? TTS_BACKEND.Inworld
              : preset.backend === "lmnt"
                ? TTS_BACKEND.Lmnt
                : preset.backend === "minimax"
                  ? TTS_BACKEND.MiniMax
                  : TTS_BACKEND.OpenAiCompatible;
    const nextConfig: Record<string, unknown> = {};
    if (preset.baseUrl) nextConfig["endpoint"] = preset.baseUrl;
    // D15: the preset's modelFilter must ride the config bag — the server
    // reads it to shape the /models request (openrouter → speech-only).
    // Lost before: the registry declared it but nothing stamped it, so
    // the fetch returned the unfiltered chat catalog.
    if (preset.backend === "openai-compat" && preset.modelFilter !== "none") {
      nextConfig["modelFilter"] = preset.modelFilter;
    }
    nextConfig["preset"] = preset.id;
    tts.setForm({ backend: nextBackend, config: nextConfig, voiceId: "" });
  }

  function handleUpdateForm<K extends keyof TtsProfileForm>(k: K, v: TtsProfileForm[K]): void {
    // Generic computed-key object can't be proven assignable — single scoped cast.
    tts.setForm({ [k]: v } as Pick<TtsProfileForm, K>);
  }

  const modelSpec = spec.connection.model;
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
            form={form}
            isDefault={savedProfile.isDefault}
            onEdit={tts.startEdit}
            onSetDefault={() => void tts.setDefault(savedProfile.id)}
          />
          {/* View mode (LLM headerMode mechanism): compact card on top,
              config sections always visible below — the MODEL picker sits
              first (owner rule: voices are model-dependent, so the model
              is chosen before the voice), then voices, tuning, bindings. */}
          {modelSpec !== undefined &&
            (modelSpec.mode === "fetch" ? (
              <TtsModelPicker
                value={configString(form.config, modelSpec.key)}
                onChange={(id) => updateConfigField(tts, form, modelSpec.key, id)}
                models={models ?? []}
                fetching={modelsLoading}
                fetchError={modelsError}
                onRefresh={refreshModels}
                label={t(modelSpec.labelKey)}
              />
            ) : (
              /* Input-mode model id (ElevenLabs): a plain field, NO example
               * placeholder (owner directive 2026-08-29 — a fake example id
               * must never stand in for data). */
              <div className="my-4">
                <div className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1">{t(modelSpec.labelKey)}</div>
                <input
                  type="text"
                  data-testid="tts-field-model"
                  value={configString(form.config, modelSpec.key)}
                  onChange={(event) => updateConfigField(tts, form, modelSpec.key, event.target.value)}
                  className="h-[38px] w-full rounded-[6px] border border-border bg-s2 px-[13px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent"
                />
              </div>
            ))}
          <TtsSectionCard title={t("tts_field_voice")} testid="tts-voice-section">
            <TtsVoiceFields
              form={form}
              updateForm={handleUpdateForm}
              voices={voices}
              voicesLoading={voicesLoading}
              voicesError={voicesError}
            />
            {/* Owner 2026-08-29 (D18): listening docks UNDER the voice
             *  selection. Gated on a chosen voice — synthesizing with an
             *  empty voiceId is a guaranteed 500 on the server. */}
            <div className="mt-3 flex flex-col gap-1">
              <button
                type="button"
                data-testid="tts-preview-btn"
                disabled={preview.state !== "idle" || form.voiceId === ""}
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
                  {preview.error}
                </div>
              )}
            </div>
          </TtsSectionCard>

          {/* Clone section (clone field design 2026-08-31, owner-approved):
           *  its own card directly under the voice picker, rendered ONLY when
           *  the backend reported the capability — the empty-library case
           *  (voices null, supportsCloning true) still gets it, because
           *  uploading the first voice IS the feature there. */}
          {cloneCaps?.supportsCloning === true && (
            <TtsVoiceCloneCard
              backend={form.backend}
              config={formDraftConfig(form)}
              profileId={form.id ?? undefined}
              capabilities={cloneCaps}
              onCloned={(voice) => {
                // Auto-select (design point 2): the new voice lands in the
                // form's voiceId — dirty-flow, no auto-commit — and the
                // picker list refreshes to include it.
                tts.setForm({ voiceId: voice.id });
                setVoicesRefreshTick((n) => n + 1);
              }}
            />
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
  /** Editor-owned dynamic discovery state (single fetch owner). */
  voices: TtsVoiceRecord[] | null;
  voicesLoading: boolean;
  voicesError: string | null;
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
  voices,
  voicesLoading,
  voicesError,
}: TtsVoiceFieldsProps): ReactNode {
  const { t } = useT();
  const isKokoro = form.backend === TTS_BACKEND.Kokoro;
  // No example-id placeholder stubs (owner directive 2026-08-29): the
  // dropdown hint is the field label; the manual fallback input gets a
  // neutral hint instead of a fake voice id.
  const dropdownPlaceholder = t("tts_field_voice");
  const manualPlaceholder = t("tts_field_voice_manual_placeholder");
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
          placeholder={dropdownPlaceholder}
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
          placeholder={manualPlaceholder}
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
        placeholder={manualPlaceholder}
      />
        ) : (
      <div className="mt-1">
        <DropdownSelect
          value={form.voiceId}
          options={(voices ?? []).map((v) => ({ id: v.id, label: v.label || v.id }))}
          onChange={(value) => updateForm("voiceId", value)}
          searchable={true}
          placeholder={dropdownPlaceholder}
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
