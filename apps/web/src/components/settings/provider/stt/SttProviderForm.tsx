import { useState } from "react";
import { DEFAULT_WHISPER_MODEL_ID, STT_BACKENDS } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { STT_QUICKSTARTS, getSttQuickstart } from "../../../../lib/stt/stt-quickstarts.js";
import { transcribeSttAudio } from "../../../../api/stt-api.js";
import { buildSilentTestWav } from "../../../../lib/stt/test-audio.js";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { labelCls, inputCls } from "../form-field-classes.js";
import { SttConfigFields } from "./SttConfigFields.js";
import { SttApiKeyField } from "./SttApiKeyField.js";
import { SttLocalServerPanel } from "./SttLocalServerPanel.js";
import { configString, updateConfigField } from "./stt-form-helpers.js";
import type { SttProfileForm, useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

/** Test connection semantics for the STT tab (ST-5b scope deviation, noted):
 *  there is NO draft-transcribe route — the test button transcribes with a
 *  SAVED profile only, so it is enabled when the form belongs to a saved
 *  profile AND is clean (dirty would mean the profile on disk differs from
 *  the form). The clip is a silent WAV built client-side (test-audio.ts) —
 *  a successful round-trip proves endpoint+key+model without a mic. */
function canTestConnection(form: SttProfileForm, dirty: boolean): boolean {
  return form.id !== null && !dirty && form.backend === STT_BACKENDS.OpenAiCompat;
}

interface SttProviderFormProps {
  form: SttProfileForm;
  editingId: string | null;
  sttProfiles: SttHook["profiles"];
  updateForm: <K extends keyof SttProfileForm>(k: K, v: SttProfileForm[K]) => void;
  stt: SttHook;
}

export function SttProviderForm({ form, editingId, sttProfiles, updateForm, stt }: SttProviderFormProps) {
  const { t } = useT();
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const isBrowser = form.backend === STT_BACKENDS.WhisperBrowser;
  const apiKey = form.apiKey;
  const autoKeyName = form.autoKeyProviderName;

  const duplicateNameWarning =
    form.name &&
    sttProfiles.some((p) => p.id !== editingId && p.name.trim().toLowerCase() === form.name.trim().toLowerCase());

  const segmentOptions: Array<{ value: string; label: string }> = [
    { value: STT_BACKENDS.OpenAiCompat, label: t("stt_segment_openai") },
    { value: STT_BACKENDS.WhisperBrowser, label: t("stt_segment_whisper") },
  ];

  function handleSegmentChange(next: string) {
    if (next === form.backend) return;
    // Mirror the hook's backend-switch branch: a whisper profile lands on
    // the roster default model; the config/know-key reset happens in the
    // hook (setForm resets config + apiKey + hasStoredApiKey on switch).
    updateForm("backend", next as SttProfileForm["backend"]);
    if (next === STT_BACKENDS.WhisperBrowser) {
      updateForm("config", { model: DEFAULT_WHISPER_MODEL_ID });
    }
  }

  /** Quickstart glue: fill endpoint+model into the openai-compat config and
   *  force the backend segment (a whisper profile switching to a quickstart
   *  must land on openai-compat; the key field clears — same rule as the
   *  TTS preset apply). */
  function applyQuickstart(id: string): void {
    const qs = getSttQuickstart(id);
    if (!qs) return;
    if (form.backend !== STT_BACKENDS.OpenAiCompat) updateForm("backend", STT_BACKENDS.OpenAiCompat);
    const next: Record<string, unknown> = { ...form.config, endpoint: qs.endpoint, model: qs.model };
    updateForm("config", next);
  }

  async function handleTest(): Promise<void> {
    if (testing || !canTestConnection(form, stt.dirty) || form.id === null) return;
    setTesting(true);
    setTestOk(null);
    try {
      await transcribeSttAudio(form.id, buildSilentTestWav());
      setTestOk(true);
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  const selectedQuickstart = STT_QUICKSTARTS.find(
    (q) => configString(form.config, "endpoint") === q.endpoint && configString(form.config, "model") === q.model,
  );
  const quickstartId = selectedQuickstart?.id ?? "";

  return (
    <>
      {/* Row 1: profile name + backend segment */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("profile_name")}</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder={t("profile_name_placeholder")}
            className={inputCls}
            data-testid="stt-profile-name-input"
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
          <label className={labelCls + " mb-[6px]"}>{t("stt_backend_label")}</label>
          <SegmentedControl
            value={form.backend}
            options={segmentOptions}
            onChange={handleSegmentChange}
            wrap
            mobileFill
            mobileSelect
          />
        </div>
      </div>

      {/* Quickstart + applied-endpoint readout (openai-compat only — recipes,
          not a catalog; live discovery is ST-8). */}
      {!isBrowser && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="mb-3">
            <label className={labelCls + " mb-[6px]"}>{t("stt_quickstart_label")}</label>
            <DropdownSelect
              value={quickstartId}
              options={STT_QUICKSTARTS.map((q) => ({ id: q.id, label: q.label }))}
              placeholder={t("custom")}
              onChange={(val) => {
                if (val) applyQuickstart(val);
              }}
              triggerTestId="stt-quickstart-select"
            />
          </div>
          <div className="mb-3">
            <label className={labelCls + " mb-[6px]"}>{t("preset_endpoint_label")}</label>
            <input
              type="text"
              value={configString(form.config, "endpoint") || t("custom")}
              readOnly
              className={cn(inputCls, "!cursor-not-allowed !opacity-60")}
            />
          </div>
        </div>
      )}

      {/* Shared per-backend config fields (endpoint/model/language). */}
      <SttConfigFields
        backend={form.backend}
        config={form.config}
        onUpdate={(key, value) => updateConfigField(stt, form, key, value)}
      />

      {/* API key (openai-compat only — browser whisper needs none) */}
      {!isBrowser && (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("api_key_label")}</label>
          <SttApiKeyField
            value={apiKey}
            onChange={(v) => updateForm("apiKey", v)}
            placeholder={t("api_key_placeholder")}
            stored={form.hasStoredApiKey}
          />
          {/* Default-on key reuse (owner 2026-08-28, applied to STT): a
              provider profile (or openai-compat TTS profile) whose endpoint
              auto-matches — typing an own key above overrides it. */}
          {!apiKey && !form.hasStoredApiKey && autoKeyName !== null && (
            <div className="mt-1.5 flex items-center gap-1.5 font-ui text-[11px] text-t3" data-testid="stt-key-source-hint">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px] shrink-0">
                <Icons.lock />
              </span>
              {t("stt_key_from_provider_hint", { name: autoKeyName })}
            </div>
          )}
        </div>
      )}

      {/* Local-server discovery + setup help (openai-compat only — the
          whisper-browser tier is in-browser). ST-8. */}
      {!isBrowser && <SttLocalServerPanel form={form} stt={stt} />}

      {/* Test connection card (openai-compat only — the browser backend has
          nothing remote to test; its "status" is the roster badge above). */}
      {!isBrowser ? (
        <div className="my-3 rounded-lg border border-border bg-surface p-3.5" data-testid="stt-test-card">
          {canTestConnection(form, stt.dirty) ? (
            <div>
              <div className="flex">
                <button
                  type="button"
                  data-testid="stt-test-connection-btn"
                  className={cn(
                    "min-h-11 rounded-md border px-4 py-2 font-ui text-[13px] font-medium transition-colors sm:min-h-0 sm:py-1.5",
                    testOk === true
                      ? "border-success/30 bg-success/10 text-success"
                      : testOk === false
                        ? "border-danger/30 bg-danger/10 text-danger"
                        : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1",
                  )}
                  onClick={() => void handleTest()}
                  disabled={testing}
                >
                  {testing ? t("testing") : t("test_connection")}
                </button>
              </div>
              {testOk === true && (
                <div className="mt-3" data-testid="stt-test-success">
                  <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] text-success">
                    <Icons.Check />
                    {t("connection_successful")}
                  </span>
                </div>
              )}
              {testOk === false && (
                <div className="mt-3" data-testid="stt-test-failure">
                  <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
                    <Icons.Close />
                    {t("connection_failed")}
                  </span>
                </div>
              )}
            </div>
          ) : form.id === null || stt.dirty ? (
            <div className="flex items-center gap-2 font-ui text-[13px] text-t3" data-testid="stt-test-dot-save-first">
              <span className="h-2 w-2 rounded-full bg-t4" />
              {t("stt_test_save_first")}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="my-3 rounded-lg border border-border bg-surface p-3.5" data-testid="stt-browser-test-note">
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <span className="flex items-center gap-1.5">
              <Icons.Check className="h-3.5 w-3.5 text-success" />
              {t("stt_backend_browser_badge")}
            </span>
            <span className="font-ui text-[12px] text-t4">{t("stt_test_browser_note")}</span>
          </div>
        </div>
      )}
    </>
  );
}