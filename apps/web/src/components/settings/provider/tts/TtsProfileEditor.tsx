/**
 * forks: 1 — stt/SttProfileEditor.tsx.
 */

import { useState, type ReactNode } from "react";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { Ic, Icons } from "../../../shared/icons.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { TextInput } from "../../../shared/text-input.js";
import { cn } from "../../../../lib/cn.js";
import { AnimatedDisclosure } from "../../../shared/AnimatedDisclosure.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { SliderField } from "../../../shared/SliderField.js";
import { Toggle } from "../../../shared/Toggle.js";
import type { TtsVoiceRecord } from "../../../../api/tts-api.js";
import { useTtsPreview } from "../../../../hooks/use-tts-preview.js";
import { useTtsEditorListings } from "../../../../hooks/use-tts-editor-listings.js";
import { TtsBindingFields } from "./TtsBindingFields.js";
import { configString, formDraftConfig, updateConfigField } from "./tts-form-helpers.js";
import { backendForVariant, ttsPresetIdOf, ttsProviderSegmentOf, ttsUiSpecFor, ttsUiVariantOf, type TtsTuningFieldSpec, type TtsUiVariant } from "./tts-backend-ui.js";
import { TtsProviderForm } from "./TtsProviderForm.js";
import { TtsBaseCard } from "./TtsBaseCard.js";
import { TtsLocalConnectionChip } from "./TtsLocalConnectionChip.js";
import { TtsModelPicker } from "./TtsModelPicker.js";
import { TtsSectionCard } from "./TtsSectionCard.js";
import { TtsVoiceCloneCard } from "./TtsVoiceCloneCard.js";
import { TTS_PRESETS } from "../../../../lib/tts/tts-presets.js";
import { KOKORO_VOICES, kokoroVoiceLabel } from "../../../../lib/tts/kokoro-voices.js";
import type { TtsProfileForm, useTtsProfiles } from "../../../../hooks/use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
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
  if (field.kind === "text") {
    // Free-form string knob whose legal values are provider-side data
    // (Volcengine emotion — a per-voice enum living in the provider's
    // voice-roster page; a select here would be a hardcoded catalog,
    // owner rule 2026-09-01).
    return (
      <div>
        <label className={lblCls}>{t(field.labelKey)}</label>
        <TextInput
          value={configString(form.config, field.key)}
          onChange={(e) => {
            const v = e.target.value;
            updateConfigField(tts, form, field.key, v.length > 0 ? v : undefined);
          }}
          placeholder={field.placeholderKey !== undefined ? t(field.placeholderKey) : undefined}
          data-testid={`tts-field-${field.key}`}
        />
      </div>
    );
  }
  return (
    <div>
      <label className={lblCls}>{t(field.labelKey)}</label>
      <div>
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
  const [tuningOpen, setTuningOpen] = useState(false);
  const preview = useTtsPreview();
  const savedProfile =
    tts.editingId !== null ? (tts.profiles.find((p) => p.id === tts.editingId) ?? null) : null;
  const isView = tts.headerMode === "view" && savedProfile !== null;

  // Hooks stay ABOVE the early return — `if (!tts.form) return null` between
  // useState and useEffect would be a hooks-order violation the day any
  // caller keeps this mounted across a form→null transition.
  //
  // Voice and model lists (step 11c, owner 2026-10-15): the pickers render
  // only in the saved profile's VIEW mode, so that is the only mode that
  // lists. A saved profile opens on the server's STORED lists (no upstream
  // call; live only when nothing is stored); the refresh buttons are the live
  // path. Mechanism, gates and keys: use-tts-editor-listings.ts.
  const listings = useTtsEditorListings({ form: tts.form, enabled: isView, setForm: tts.setForm });

  if (!tts.form) return null;

  const form = tts.form;
  const variant = ttsUiVariantOf(form.backend, form.config);
  const spec = ttsUiSpecFor(variant);

  function handleApplyPreset(presetId: string): void {
    const preset = TTS_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    // Every native preset backend id IS its UI variant (one id space), and
    // backendForVariant is the exhaustive pinned map — the historic
    // hand-rolled ternary here silently truncated at MiniMax, dropping
    // Wave B/C rows (volcengine…google-cloud) into the OpenAI-compatible
    // backend on selection. One mapping, one place.
    const nextBackend =
      preset.backend === "openai-compat"
        ? TTS_BACKEND.OpenAiCompatible
        : backendForVariant(preset.backend);
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
  const isEdit = tts.headerMode === "edit";
  // LLM parity (owner 2026-09-22): the local-connection chip renders
  // OUTSIDE the provider card — between the card and the level-2 sections in
  // view mode, right below the form in edit mode — for the LOCAL segment's
  // openai-compatible server variant only.
  const isLocalServerBackend =
    form !== undefined && ttsProviderSegmentOf(form.backend, form.config) === "local" && form.backend === TTS_BACKEND.OpenAiCompatible;

  return (
    <div data-testid="tts-profile-editor" className="flex flex-col gap-4">
      {isEdit ? (
        <>
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
          {isLocalServerBackend && <TtsLocalConnectionChip form={form} />}
        </>
      ) : savedProfile !== null ? (
        <>
          <TtsBaseCard
            form={form}
            isDefault={savedProfile.isDefault}
            onEdit={tts.startEdit}
            onSetDefault={() => void tts.setDefault(savedProfile.id)}
          />
          {isLocalServerBackend && <TtsLocalConnectionChip form={form} />}
          {/* View mode (LLM headerMode mechanism): compact card on top,
              config sections always visible below — the MODEL picker sits
              first (owner rule: voices are model-dependent, so the model
              is chosen before the voice), then voices, tuning, bindings. */}
          {modelSpec !== undefined &&
            (modelSpec.mode === "fetch" ? (
              <TtsModelPicker
                value={configString(form.config, modelSpec.key)}
                onChange={(id) => updateConfigField(tts, form, modelSpec.key, id)}
                models={listings.models ?? []}
                fetching={listings.modelsLoading}
                fetchError={listings.modelsError}
                onRefresh={listings.refreshModels}
                label={t(modelSpec.labelKey)}
              />
            ) : (
              /* Input-mode model id (ElevenLabs/Cartesia/LMNT): a plain
               * field, NO example placeholder (owner directive
               * 2026-08-29 — a fake example id must never stand in for
               * data). When the spec carries docsUrl (owner decision
               * 2026-09-01, TPE-9a), a link to the provider's model docs
               * sits under the input — the discovery path instead of a
               * static catalog. */
              <div className="my-4">
                <div className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1">{t(modelSpec.labelKey)}</div>
                <TextInput
                  data-testid="tts-field-model"
                  value={configString(form.config, modelSpec.key)}
                  onChange={(event) => updateConfigField(tts, form, modelSpec.key, event.target.value)}
                />
                {modelSpec.docsUrl !== undefined && (
                  <a
                    data-testid="tts-model-docs-link"
                    href={modelSpec.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 font-ui text-[12px] text-t3 transition-colors hover:text-accent"
                  >
                    <Icons.Book className="h-3.5 w-3.5" />
                    {t("tts_model_docs_link")}
                  </a>
                )}
              </div>
            ))}
          <TtsSectionCard title={t("tts_field_voice")} testid="tts-voice-section">
            <TtsVoiceFields
              form={form}
              updateForm={handleUpdateForm}
              voices={listings.voices}
              voicesLoading={listings.voicesLoading}
              voicesError={listings.voicesError}
              cloneCapable={listings.cloneCaps?.supportsCloning === true}
              onRefreshVoices={listings.refreshVoices}
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
          {listings.cloneCaps?.supportsCloning === true && (
            <TtsVoiceCloneCard
              backend={form.backend}
              config={formDraftConfig(form)}
              profileId={form.id ?? undefined}
              capabilities={listings.cloneCaps}
              onCloned={(voice) => {
                // Auto-select (design point 2): the new voice lands in the
                // form's voiceId — dirty-flow, no auto-commit — and the
                // picker list refreshes to include it. The refresh is LIVE
                // (the stored voice list predates the clone and would not
                // carry it) and overwrites the stored copy.
                tts.setForm({ voiceId: voice.id });
                listings.refreshVoices();
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

      {form.id !== null && (
        <div className="rounded-lg border border-border2 bg-s2 px-4 py-2.5" data-testid="tts-toggle-card-waitForFullGeneration">
          <div className="flex items-center gap-3">
            <Toggle
              checked={form.config["waitForFullGeneration"] === true}
              onChange={(checked) => updateConfigField(tts, form, "waitForFullGeneration", checked || undefined)}
              aria-label={t("tts_playback_wait_full_label")}
            />
            <div>
              <div className="font-ui text-[13px] font-medium text-t1">{t("tts_playback_wait_full_label")}</div>
              <div className="mt-0.5 font-ui text-[11px] text-t3">{t("tts_playback_wait_full_hint")}</div>
            </div>
          </div>
        </div>
      )}

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
  /** A listing is in flight. The loading placeholder replaces the pickers only
   *  while there is no list to show; a re-run or refresh over a list already
   *  on screen keeps it (the refresh button is just disabled meanwhile). */
  voicesLoading: boolean;
  voicesError: string | null;
  /** Clone capability from the voices envelope — drives the friendly
   *  empty-library hint (TPE-12: null voices on a clone-capable server is
   *  "no voices yet", never a load failure). */
  cloneCapable: boolean;
  /** Voices are a refreshable resource like models (owner 2026-09-05). */
  onRefreshVoices: () => void;
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
  cloneCapable,
  onRefreshVoices,
}: TtsVoiceFieldsProps): ReactNode {
  const { t } = useT();
  const isKokoro = form.backend === TTS_BACKEND.Kokoro;
  // Loading is told only over an empty slate — never blank a list that is
  // already showing just because it is being re-checked.
  const showVoicesLoading = voicesLoading && voices === null;
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
      <div>
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
      <div>
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
        {showVoicesLoading ? (
      <div data-testid="tts-voices-loading" className="mt-1 font-ui text-[12px] text-t3">
        {t("tts_voices_loading")}
      </div>
        ) : voicesError !== null ? (
      <>
        <TextInput
          data-testid="tts-voice-input"
          mono
          value={form.voiceId}
          onChange={(e) => updateForm("voiceId", e.target.value)}
          placeholder={manualPlaceholder}
        />
        <div data-testid="tts-voices-load-error" className="mt-1 font-ui text-[11px] text-danger">
          {t("tts_voices_load_error")}
        </div>
      </>
        ) : voices === null ? (
      cloneCapable ? (
        // Empty library on a clone-capable server (chatterbox shape): the
        // honest state is "no voices yet" — uploading the first one IS the
        // feature (owner 2026-09-05: never render this as a load failure).
        <div data-testid="tts-voices-empty" className="mt-1 font-ui text-[12px] text-t3">
          {t("tts_voices_empty_library")}
        </div>
      ) : (
        // Host without a voices endpoint — the manual floor stays honest.
        <TextInput
          data-testid="tts-voice-input"
          mono
          value={form.voiceId}
          onChange={(e) => updateForm("voiceId", e.target.value)}
          placeholder={manualPlaceholder}
        />
      )
        ) : voices.length === 0 ? (
      <TextInput
        data-testid="tts-voice-input"
        mono
        value={form.voiceId}
        onChange={(e) => updateForm("voiceId", e.target.value)}
        placeholder={manualPlaceholder}
      />
        ) : (
      <div>
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
        {form.backend !== undefined && (
          <button
            type="button"
            data-testid="tts-voices-refresh"
            onClick={() => onRefreshVoices()}
            disabled={voicesLoading}
            className="mt-1.5 flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40 disabled:pointer-events-none"
            title={t("tts_refresh_voices")}
          >
            <Icons.Regen />
            {t("tts_refresh_voices")}
          </button>
        )}
      </div>
      <div className="mb-3">
        <label className={lblCls}>{t("tts_field_narrator_voice")}</label>
        {showVoicesLoading ? (
      <div data-testid="tts-narrator-voices-loading" className="mt-1 font-ui text-[12px] text-t3">
        {t("tts_voices_loading")}
      </div>
        ) : voicesError !== null || voices === null || voices.length === 0 ? (
      <TextInput
        data-testid="tts-narrator-voice-input"
        mono
        value={form.narratorVoiceId}
        onChange={(e) => updateForm("narratorVoiceId", e.target.value)}
        placeholder={t("tts_field_narrator_voice_none")}
      />
        ) : (
      <div>
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
