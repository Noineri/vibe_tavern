import { TTS_BACKEND } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { TTS_PRESETS, getVisibleTtsPresets, getVisibleTtsPresetGroups, getTtsPresetGroup } from "../../../../lib/tts/tts-presets.js";
import type { TtsProfileForm } from "./use-tts-profiles.js";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { labelCls, inputCls } from "../form-field-classes.js";
import { TtsApiKeyField } from "./TtsApiKeyField.js";
import { ttsProviderSegmentOf, ttsPresetIdOf, type TtsProviderSegment } from "./tts-backend-ui.js";
import { configString } from "./tts-form-helpers.js";

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
}

export function TtsProviderForm({
  form,
  editingId,
  ttsProfiles,
  updateForm,
  applyPreset,
  testOk,
  testing,
  testingChat,
  chatResult,
  onTest,
  onTestChat,
  hideConnectionFields,
  hideTestChat,
}: TtsProviderFormProps) {
  const { t } = useT();
  const segment = ttsProviderSegmentOf(form.backend, form.config);
  const visiblePresets = getVisibleTtsPresets();
  const visiblePresetGroups = getVisibleTtsPresetGroups();
  const presetId = ttsPresetIdOf(form.config);
  const presetGroup = presetId ? getTtsPresetGroup(presetId) : null;
  const visiblePresetGroup = presetGroup && visiblePresetGroups.some((g) => g.id === presetGroup) ? presetGroup : null;
  const filteredPresets = visiblePresetGroup ? visiblePresets.filter((f) => f.group === visiblePresetGroup) : visiblePresets;
  const presetEndpoint = presetId ? (TTS_PRESETS.find((f) => f.id === presetId)?.baseUrl ?? "") : "";
  const apiKey = configString(form.config, "apiKey");

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
          {/* Custom endpoint */}
          {showEndpoint && (
            <div className="mb-3">
              <label className={labelCls + " mb-[6px]"}>{t("custom_endpoint_label")}</label>
              <input
                type="text"
                value={configString(form.config, "endpoint")}
                onChange={(e) => {
                  const v = e.target.value;
                  const next = { ...form.config } as Record<string, unknown>;
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
                  const next = { ...form.config } as Record<string, unknown>;
                  if (v === "") delete next["apiKey"];
                  else next["apiKey"] = v;
                  updateForm("config", next);
                }}
                placeholder={t("api_key_placeholder")}
                stored={form.hasStoredApiKey}
              />
            </div>
          )}

          {/* Test connection card */}
          <div className="my-3 rounded-lg border border-border bg-surface p-3.5">
            {needsKey && !apiKey && !form.hasStoredApiKey ? (
              <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
                <span className="h-2 w-2 rounded-full bg-t4" />
                {t("no_connection_enter_key")}
              </div>
            ) : !form.voiceId ? (
              <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
                <span className="h-2 w-2 rounded-full bg-t4" />
                {t("no_model_selected_begin")}
              </div>
            ) : (
              <div>
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
                  <button
                    type="button"
                    className={cn(
                      "min-h-11 rounded-md border px-4 py-2 font-ui text-[13px] font-medium transition-colors sm:min-h-0 sm:py-1.5",
                      testOk === true
                        ? "border-success/30 bg-success/10 text-success"
                        : testOk === false
                          ? "border-danger/30 bg-danger/10 text-danger"
                          : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1",
                    )}
                    onClick={() => void onTest()}
                    disabled={testing}
                  >
                    {testing ? t("testing") : t("test_connection")}
                  </button>
                  {!hideTestChat && (
                    <button
                      type="button"
                      className="min-h-11 rounded-md border border-border bg-s2 px-4 py-2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50 sm:min-h-0 sm:py-1.5"
                      onClick={() => void onTestChat()}
                      disabled={testingChat}
                    >
                      {testingChat ? t("sending") : t("test_hi_btn")}
                    </button>
                  )}
                </div>
                {testOk === true && (
                  <div className="mt-3">
                    <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] text-success">
                      <Icons.Check />
                      {t("connection_successful")}
                    </span>
                  </div>
                )}
                {testOk === false && (
                  <div className="mt-3">
                    <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
                      <Icons.Close />
                      {t("connection_failed")}
                    </span>
                  </div>
                )}
                {!hideTestChat && chatResult && (
                  <div className="mt-3">
                    {chatResult.reply && (
                      <span className="inline-flex max-w-full items-center gap-1.5 break-words rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] italic text-success">
                        &ldquo;
                        {chatResult.reply.length > 200 ? chatResult.reply.slice(0, 200) + "..." : chatResult.reply}
                        &rdquo;
                      </span>
                    )}
                    {chatResult.error && (
                      <span className="inline-flex max-w-full items-center gap-1.5 break-words rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
                        <Icons.Close />
                        {chatResult.error}
                      </span>
                    )}
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
