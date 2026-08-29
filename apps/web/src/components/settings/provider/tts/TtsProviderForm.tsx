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
import { TtsApiKeyField } from "./TtsApiKeyField.js";
import { ttsProviderSegmentOf, ttsPresetIdOf, ttsUiSpecFor, ttsUiVariantOf, type TtsProviderSegment } from "./tts-backend-ui.js";
import { configString, formDraftConfig } from "./tts-form-helpers.js";
import { KokoroModelPanel } from "./KokoroModelPanel.js";
import { TtsLocalServerPanel } from "./TtsLocalServerPanel.js";
import { useTtsPreview } from "./use-tts-preview.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

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
  hideTestChat?: boolean;
  tts?: TtsHook | null;
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
  hideTestChat,
  tts,
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
  const apiKey = form.apiKey;
  const variant = ttsUiVariantOf(form.backend, form.config);
  const spec = ttsUiSpecFor(variant);

  const duplicateNameWarning =
    form.name &&
    ttsProfiles.some((p) => p.id !== editingId && p.name.trim().toLowerCase() === form.name.trim().toLowerCase());

  // Short segment labels — the row must fit the modal detail pane; the
  // long wording (browser/local detail) lives in the option tooltip.
  const segmentOptions: Array<{ value: TtsProviderSegment; label: string; tooltip?: string }> = [
    { value: "browser", label: t("tts_segment_browser"), tooltip: t("tts_backend_kokoro") },
    { value: "local", label: t("tts_segment_local"), tooltip: t("tts_backend_local_server") },
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

  const isKokoroSegment = segment === "browser";
  // Test card wiring (real)
  const [testOk, setTestOk] = useState<boolean | null>(testOkProp);
  const [testing, setTesting] = useState(testingProp);
  const preview = useTtsPreview();
  const configNumber = (key: string, fallback: number): number => {
    const v = form.config[key];
    return typeof v === "number" ? v : fallback;
  };

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
    const config = formDraftConfig(form);
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
      config: formDraftConfig(form),
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
            options={segmentOptions.map((o) => ({ value: o.value, label: o.label, tooltip: o.tooltip }))}
            onChange={handleSegmentChange}
            wrap
            mobileFill
            mobileSelect
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
            onChange={(v) => updateForm("apiKey", v)}
            placeholder={t("api_key_placeholder")}
            stored={form.hasStoredApiKey}
          />
          {/* Default-on key reuse (owner decision): when an LLM provider
              profile's endpoint auto-matches, say WHERE the key comes from —
              typing an own key above overrides it. */}
          {!apiKey && !form.hasStoredApiKey && form.autoKeyProviderName !== null && (
            <div className="mt-1.5 flex items-center gap-1.5 font-ui text-[11px] text-t3" data-testid="tts-key-source-hint">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px] shrink-0">
                <Icons.lock />
              </span>
              {t("tts_key_from_provider_hint", { name: form.autoKeyProviderName })}
            </div>
          )}
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

      {/* Test connection card */}
      <div className="my-3 rounded-lg border border-border bg-surface p-3.5" data-testid="tts-test-card">
        {needsKey && !apiKey && !form.hasStoredApiKey && form.autoKeyProviderName === null ? (
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
  );
}
