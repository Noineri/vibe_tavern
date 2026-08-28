import { useState, type ReactNode } from "react";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { TTS_PRESETS, getVisibleTtsPresets, getVisibleTtsPresetGroups, getTtsPresetGroup } from "../../../../lib/tts/tts-presets.js";
import type { TtsProfileForm } from "./use-tts-profiles.js";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";
import { listTtsDraftModels, listTtsDraftVoices } from "../../../../api/tts-api.js";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { labelCls, inputCls } from "../form-field-classes.js";
import { monoUICls } from "../../../build/fields/field-styles.js";
import { KOKORO_VOICES, kokoroVoiceLabel } from "../../../../lib/tts/kokoro-voices.js";
import { TtsApiKeyField } from "./TtsApiKeyField.js";
import { ttsProviderSegmentOf, ttsPresetIdOf, ttsUiSpecFor, ttsUiVariantOf, type TtsProviderSegment } from "./tts-backend-ui.js";
import { configString } from "./tts-form-helpers.js";
import { KokoroModelPanel } from "./KokoroModelPanel.js";
import { TtsLocalServerPanel } from "./TtsLocalServerPanel.js";
import { useTtsPreview } from "./use-tts-preview.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";
import type { TtsVoiceRecord } from "../../../../api/tts-api.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

interface TtsProviderFormProps {
  form: TtsProfileForm;
  editingId: string | null;
  ttsProfiles: TtsProfileRecord[];
  updateForm: <K extends keyof TtsProfileForm>(k: K, v: TtsProfileForm[K]) => void;
  applyPreset: (presetId: string) => void;
  testOk: boolean | null;
  testing: boolean;
  testingChat: boolean;
  chatResult: { reply?: string; error?: string } | null;
  onTest: () => void;
  onTestChat: () => void;
  hideConnectionFields?: boolean;
  hideTestChat?: boolean;
  tts?: TtsHook | null;
  // Discovery state owned by the editor (single fetch owner) — passed to
  // the form so it can render the full voice UI without duplicate effects.
  voices?: TtsVoiceRecord[] | null;
  voicesLoading?: boolean;
  voicesError?: string | null;
  models?: Array<{ id: string; label: string }> | null;
  modelsLoading?: boolean;
  modelsError?: string | null;
}

export function TtsProviderForm({
  form,
  editingId,
  ttsProfiles,
  updateForm,
  applyPreset,
  testOk: testOkProp,
  testing: testingProp,
  testingChat: testingChatProp,
  chatResult: chatResultProp,
  onTest: onTestProp,
  onTestChat: onTestChatProp,
  hideConnectionFields,
  hideTestChat,
  tts,
  voices = null,
  voicesLoading = false,
  voicesError = null,
  models = null,
  modelsLoading = false,
  modelsError = null,
}: TtsProviderFormProps) {
  const { t } = useT();
  const segment = ttsProviderSegmentOf(form.backend, form.config);
  const visiblePresets = getVisibleTtsPresets();
  const visiblePresetGroups = getVisibleTtsPresetGroups();
  const presetId = ttsPresetIdOf(form.config);
  const presetGroup = presetId ? getTtsPresetGroup(presetId) : null;
  const visiblePresetGroup = presetGroup && visiblePresetGroups.some((g) => g.id === presetGroup) ? presetGroup : null;
  const filteredPresets = visiblePresetGroup ? visiblePresets.filter((f) => f.group === visiblePresetGroup) : visiblePresets;
  const preset = presetId ? TTS_PRESETS.find((p) => p.id === presetId) : undefined;
  const presetEndpoint = preset?.baseUrl ?? "";
  const apiKey = configString(form.config, "apiKey");
  const variant = ttsUiVariantOf(form.backend, form.config);
  const spec = ttsUiSpecFor(variant);

  const duplicateNameWarning =
    form.name &&
    ttsProfiles.some((p) => p.id !== editingId && p.name.trim().toLowerCase() === form.name.trim().toLowerCase());

  const segmentOptions: Array<{ value: TtsProviderSegment; label: string }> = [
    { value: "browser", label: t("tts_backend_kokoro") },
    { value: "local", label: t("tts_backend_local_server") },
    { value: "cloud", label: "Cloud" },
    { value: "custom", label: t("custom") },
  ];

  function handleSegmentChange(next: string) {
    const seg = next as TtsProviderSegment;
    if (seg === segment) return;
    if (seg === "browser") {
      updateForm("backend", TTS_BACKEND.Kokoro);
      updateForm("config", {});
    } else if (seg === "local") {
      updateForm("backend", TTS_BACKEND.OpenAiCompatible);
      updateForm("config", { localServer: true, endpoint: "http://127.0.0.1:8880/v1" });
    } else if (seg === "cloud") {
      const first = visiblePresets[0];
      if (first) applyPreset(first.id);
    } else if (seg === "custom") {
      updateForm("backend", TTS_BACKEND.OpenAiCompatible);
      updateForm("config", {});
    }
  }

  const needsKey = segment === "cloud" || segment === "custom";
  const showEndpoint = segment === "custom" || segment === "local" || (segment === "cloud" && form.backend === TTS_BACKEND.OpenAiCompatible);

  const wantsStaticVoices = preset?.voiceMode === "static" && preset.staticVoices && preset.staticVoices.length > 0;
  const isKokoroSegment = segment === "browser";
  // Test card wiring (real)
  const [testOk, setTestOk] = useState<boolean | null>(testOkProp);
  const [testing, setTesting] = useState(testingProp);
  const preview = useTtsPreview();
  const configNumber = (key: string, fallback: number): number => {
    const v = form.config[key];
    return typeof v === "number" ? v : fallback;
  };
  const kokoroVoiceOptions = KOKORO_VOICES.filter((v) => v.lang === "a" || v.lang === "b").map((v) => ({
    id: v.id,
    label: kokoroVoiceLabel(v, t),
  }));

  async function handleTest(): Promise<void> {
    if (testing) return;
    // Browser segment (Kokoro) has no remote endpoint to test — the model
    // panel is the status. Don't fake a green signal.
    if (isKokoroSegment) {
      onTestProp();
      return;
    }
    setTesting(true);
    setTestOk(null);
    const backend = form.backend;
    const config = form.config;
    const profileId = editingId ?? undefined;
    const results = await Promise.allSettled([
      listTtsDraftModels({ backend, config, profileId }),
      listTtsDraftVoices({ backend, config, profileId }),
    ]);
    const ok = results.some((r) => r.status === "fulfilled");
    setTestOk(ok);
    onTestProp();
    setTesting(false);
  }

  function handleTestChat(): void {
    if (preview.state !== "idle") return;
    onTestChatProp();
    preview.preview({
      backend: form.backend,
      voiceId: form.voiceId,
      narratorVoiceId: form.narratorVoiceId,
      speed: configNumber("speed", 1),
      config: form.config,
      profileId: editingId,
    });
  }

  // Sync prop-driven testOk for parent-controlled flows (keeps stub-compat)
  const testOkEff = testOkProp !== null ? testOkProp : testOk;
  const testingEff = testingProp || testing;
  const testingChatEff = testingChatProp || preview.state !== "idle";
  const chatResultEff = chatResultProp;

  const modelSpec = spec.connection.model;

  return (
    <>
      {/* Row 1: profile name + segment */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("profile_name")}</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder={t("profile_name_placeholder")}
            className={inputCls}
            data-testid="tts-profile-name-input"
          />
          {duplicateNameWarning && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-warning">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]">
                <Icons.Alert />
              </span>
              {t("profile_name_exists")}
            </div>
          )}
        </div>
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("provider_preset_label")}</label>
          <SegmentedControl
            value={segment}
            options={segmentOptions.map((o) => ({ value: o.value, label: o.label }))}
            onChange={handleSegmentChange}
            mobileFill
          />
        </div>
      </div>

      {/* Row 2: preset select + preset endpoint */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("api_format_label")}</label>
          <DropdownSelect
            value={presetId || ""}
            options={segment === "cloud" ? filteredPresets.map((f) => ({ id: f.id, label: f.label })) : []}
            placeholder={t("custom")}
            disabled={segment !== "cloud"}
            onChange={(val) => {
              if (val) applyPreset(val);
            }}
          />
        </div>
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("preset_endpoint_label")}</label>
          <input type="text" value={presetEndpoint || t("custom")} readOnly className={cn(inputCls, "!cursor-not-allowed !opacity-60")} />
        </div>
      </div>

      {!hideConnectionFields && (
        <>
          {/* Custom/local endpoint */}
          {showEndpoint && (
            <div className="mb-3">
              <label className={labelCls + " mb-[6px]"}>{t("custom_endpoint_label")}</label>
              <input
                type="text"
                value={configString(form.config, "endpoint")}
                onChange={(e) => {
                  const v = e.target.value;
                  const next = { ...form.config };
                  if (v === "") delete next["endpoint"];
                  else next["endpoint"] = v;
                  updateForm("config", next);
                }}
                placeholder="https://api.openai.com/v1"
                className={inputCls}
                data-testid="tts-field-endpoint"
              />
            </div>
          )}

          {/* API key */}
          {needsKey && (
            <div className="mb-3">
              <label className={labelCls + " mb-[6px]"}>{t("api_key_label")}</label>
              <TtsApiKeyField
                value={apiKey}
                onChange={(v) => {
                  const next = { ...form.config };
                  if (v === "") delete next["apiKey"];
                  else next["apiKey"] = v;
                  updateForm("config", next);
                }}
                placeholder={t("api_key_placeholder")}
                stored={form.hasStoredApiKey}
              />
            </div>
          )}

          {/* Per-segment bodies */}
          {segment === "local" && tts && <TtsLocalServerPanel tts={tts} form={form} />}
          {segment === "local" && !tts && (
            <div className="mb-3 rounded border border-border bg-s1 p-3 font-ui text-[12px] text-t3" data-testid="tts-local-server-panel">
              {t("loading")}
            </div>
          )}
          {segment === "browser" && (
            <div className="mb-3">
              <KokoroModelPanel />
            </div>
          )}

          {/* Model fields are rendered in the editor's connection card (spec-driven) — form owns only static voice for cloud presets to avoid duplicate fetch owners */}

          {/* Voice pickers — single-owner component (TE2-9 defect 2); the
              collapsed view reuses TtsVoiceFields so voices stay visible
              when the base card is collapsed (TE2-10 plan row). */}
          <TtsVoiceFields
            form={form}
            updateForm={updateForm}
            voicePlaceholder={spec.voicePlaceholder}
            staticVoices={wantsStaticVoices && preset?.staticVoices ? preset.staticVoices : null}
            voices={voices}
            voicesLoading={voicesLoading}
            voicesError={voicesError}
          />

          {/* Test connection card */}
          <div className="my-3 rounded-lg border border-border bg-surface p-3.5" data-testid="tts-test-card">
            {needsKey && !apiKey && !form.hasStoredApiKey ? (
              <div className="flex items-center gap-2 font-ui text-[13px] text-t3" data-testid="tts-test-dot-enter-key">
                <span className="h-2 w-2 rounded-full bg-t4" />
                {t("no_connection_enter_key")}
              </div>
            ) : !form.voiceId ? (
              <div className="flex items-center gap-2 font-ui text-[13px] text-t3" data-testid="tts-test-dot-no-voice">
                <span className="h-2 w-2 rounded-full bg-t4" />
                {t("no_model_selected_begin")}
              </div>
            ) : (
              <div>
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
                  {!isKokoroSegment && (
                    <button
                      type="button"
                      data-testid="tts-test-connection-btn"
                    className={cn(
                      "min-h-11 rounded-md border px-4 py-2 font-ui text-[13px] font-medium transition-colors sm:min-h-0 sm:py-1.5",
                      testOkEff === true
                        ? "border-success/30 bg-success/10 text-success"
                        : testOkEff === false
                          ? "border-danger/30 bg-danger/10 text-danger"
                          : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1",
                    )}
                    onClick={() => void handleTest()}
                    disabled={testingEff}
                  >
                    {testingEff ? t("testing") : t("test_connection")}
                  </button>
                  )}
                  {!hideTestChat && (
                    <button
                      type="button"
                      data-testid="tts-test-preview-btn"
                      className="min-h-11 rounded-md border border-border bg-s2 px-4 py-2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50 sm:min-h-0 sm:py-1.5"
                      onClick={() => void handleTestChat()}
                      disabled={testingChatEff}
                    >
                      {testingChatEff ? t("sending") : t("test_hi_btn")}
                    </button>
                  )}
                </div>
                {testOkEff === true && (
                  <div className="mt-3" data-testid="tts-test-success">
                    <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] text-success">
                      <Icons.Check />
                      {t("connection_successful")}
                    </span>
                  </div>
                )}
                {testOkEff === false && (
                  <div className="mt-3" data-testid="tts-test-failure">
                    <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
                      <Icons.Close />
                      {t("connection_failed")}
                    </span>
                  </div>
                )}
                {!hideTestChat && chatResultEff && (
                  <div className="mt-3">
                    {chatResultEff.reply && (
                      <span className="inline-flex max-w-full items-center gap-1.5 break-words rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] italic text-success">
                        &ldquo;
                        {chatResultEff.reply.length > 200 ? chatResultEff.reply.slice(0, 200) + "..." : chatResultEff.reply}
                        &rdquo;
                      </span>
                    )}
                    {chatResultEff.error && (
                      <span className="inline-flex max-w-full items-center gap-1.5 break-words rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
                        <Icons.Close />
                        {chatResultEff.error}
                      </span>
                    )}
                  </div>
                )}
                {preview.error && (
                  <div data-testid="tts-preview-error" className="mt-2 font-ui text-[11px] text-danger">
                    {preview.error}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </>
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
 *  null-contract degradation. Single owner — TtsProviderForm renders it in
 *  the expanded flow; TtsProfileEditor renders it under the collapsed base
 *  card (TE2-10: voices stay visible when the base card is collapsed). */
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
          <label className={labelCls}>{t("tts_field_voice")}</label>
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
          <label className={labelCls}>{t("tts_field_narrator_voice")}</label>
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
          <label className={labelCls}>{t("tts_field_voice")}</label>
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
          <label className={labelCls}>{t("tts_field_narrator_voice")}</label>
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
        <label className={labelCls}>{t("tts_field_voice")}</label>
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
        <label className={labelCls}>{t("tts_field_narrator_voice")}</label>
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
