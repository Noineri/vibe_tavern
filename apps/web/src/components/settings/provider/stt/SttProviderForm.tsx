import { useState } from "react";
import {
  STT_BACKENDS,
  STT_BACKEND_EMOTION_CAPABILITY,
  STT_PROVIDER_PRESETS,
  getSttNativePreset,
  getSttProviderPreset,
  type SttProviderPreset,
} from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { listSttDraftModels } from "../../../../api/stt-api.js";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { lblCls } from "../../../../lib/field-tokens.js";
import { TextInput } from "../../../shared/text-input.js";
import { SttApiKeyField } from "./SttApiKeyField.js";
import { ConnectionAutoKeyHint } from "../../../shared/connection-auto-key-hint.js";
import { ConnectionProbeStatus } from "../../../shared/connection-probe-status.js";
import { SttLocalServerPanel } from "./SttLocalServerPanel.js";
import { WhisperModelPanel } from "./WhisperModelPanel.js";
import {
  STT_LOCAL_PRESET_ENDPOINT,
  STT_LOCAL_SERVER_FLAG,
  configString,
  formDraftConfig,
  normalizeSttEndpoint,
  sttProviderSegmentOf,
  updateConfigField,
  type SttProviderSegment,
} from "./stt-form-helpers.js";
import type { SttProfileForm, useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

/** defaultModel of the arms that carry one (static/fetch/free-text);
 *  `undefined` for the server-bound arm (SPE-9 — whisper.cpp binds its
 *  model at server start; there is no request-side default to prefill). */
function defaultModelOf(
  source: SttProviderPreset["modelSource"],
): string | undefined {
  return source.kind === "server" ? undefined : source.defaultModel;
}

/** Preset id → i18n label key (SPE-7). A template literal would not
 *  typecheck against the i18n key union, so this explicit record is the
 *  one place that must grow with every new preset row — an unmapped id
 *  falls back to its raw slug (a visible signal, never a wrong label). */
const STT_PRESET_LABEL_KEYS = {
  openai: "stt_preset_openai",
  openrouter: "stt_preset_openrouter",
  groq: "stt_preset_groq",
  mistral: "stt_preset_mistral",
  cartesia: "stt_preset_cartesia",
  local: "stt_preset_local",
  "whisper-cpp": "stt_preset_whisper_cpp",
  gemini: "stt_preset_gemini",
  deepgram: "stt_preset_deepgram",
  elevenlabs: "stt_preset_elevenlabs",
  nvidia: "stt_preset_nvidia",
} as const;

/** Test-connection semantics — PROBE (audit P10, the TTS card pattern):
 *  the button validates key + endpoint + catalog via the draft-models
 *  route (P8), NOT by transcribing. The form's just-typed key rides inside
 *  the draft config (formDraftConfig), and a saved profile's stored key is
 *  injected server-side — so an UNSAVED/dirty draft is testable exactly
 *  like TTS (no save-first constraint; transcription had one only because
 *  it required a saved profile id). The browser tier transcribes
 *  client-side and has nothing remote to test. */
function canTestConnection(form: SttProfileForm): boolean {
  return form.backend !== STT_BACKENDS.WhisperBrowser;
}

interface SttProviderFormProps {
  form: SttProfileForm;
  editingId: string | null;
  sttProfiles: SttHook["profiles"];
  updateForm: <K extends keyof SttProfileForm>(k: K, v: SttProfileForm[K]) => void;
  stt: SttHook;
}

/** GOVERNING RULE (owner 2026-09-04): provider settings are TWO-LEVEL
 *  everywhere. Level 1 = connection card — a shared component (or clone
 *  family) whose ONLY allowed elements: provider preset, endpoint OR
 *  browser-model download, API key (+ auto-key hint), key-validity check
 *  (probe), local-backend setup reference. The MODEL element is FORBIDDEN
 *  here — model and tuning live in the level-2 outer profile settings
 *  (SttRecognitionSection, P8). This is the STT member of the
 *  connection-card family (ProviderEditHeader · TtsProviderForm ·
 *  SttProviderForm) — COMPLIANT since P8; P11 shares the mechanically
 *  identical leaves (masked key field, auto-key hint, probe badges). This
 *  form keeps its own preset/endpoint/panel composition because those
 *  elements differ. */
export function SttProviderForm({ form, editingId, sttProfiles, updateForm, stt }: SttProviderFormProps) {
  const { t } = useT();
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const isBrowser = form.backend === STT_BACKENDS.WhisperBrowser;
  const isCompat = form.backend === STT_BACKENDS.OpenAiCompat;
  const apiKey = form.apiKey;
  // P2 — the pre-save draft hint (TTS F4/D21 pattern): server-decorated
  //  value for saved profiles, client-side mirror for drafts — the hint
  //  appears the moment a backend/endpoint qualifies, not after a save.
  const autoKeyName = stt.draftAutoKeyProviderName;

  const duplicateNameWarning =
    form.name &&
    sttProfiles.some((p) => p.id !== editingId && p.name.trim().toLowerCase() === form.name.trim().toLowerCase());

  // SPE-8: level-1 segments mirror the LLM-tab group taxonomy (Cloud /
  // Native / Local / Custom + the whisper Browser tier) — backends are no
  // longer segment options. "Cloud"/"Native" are literal (LLM/TTS
  // precedent); browser/local/custom ride i18n keys.
  const segment = sttProviderSegmentOf(form.backend, form.config);
  const segmentOptions: Array<{ value: SttProviderSegment; label: string }> = [
    { value: "browser", label: t("stt_segment_whisper") },
    { value: "cloud", label: "Cloud" },
    { value: "native", label: "Native" },
    { value: "local", label: t("stt_segment_local") },
    { value: "custom", label: t("custom") },
  ];

  // Data-driven per-backend notes under the segment (SPE-6/7): the NVIDIA
  // roster is English-speech-only (owner-approved roster fact — RU dictation
  // stays on the other rows); Deepgram's nova-3 understands Russian natively
  // (changelog-verified, SPE-R).
  const nativePreset = form.backend === STT_BACKENDS.OpenAiCompat ? undefined : getSttNativePreset(form.backend);

  // Rows of the active group (TTS effectiveGroup twin): a stored preset's
  // group wins when the segment carries none (custom/browser offer no rows
  // — the dropdown disables there, exactly like the TTS form). The LOCAL
  // segment carries its named rows too (SPE-9: the generic OpenAI-compat
  // server + whisper.cpp's own-wire row — the LLM-tab local-group shape).
  const groupPresets: readonly SttProviderPreset[] =
    segment === "cloud" || segment === "native" || segment === "local"
      ? STT_PROVIDER_PRESETS.filter((p) => p.group === segment)
      : [];

  function handleSegmentChange(next: string) {
    const seg = next as SttProviderSegment;
    if (seg === segment) return;
    // The hook's backend-switch branch owns the reset + per-backend model
    // prefill (whisper roster default / gemini / native adapter defaults) —
    // setForm resets config + apiKey + hasStoredApiKey on switch.
    if (seg === "browser") {
      updateForm("backend", STT_BACKENDS.WhisperBrowser);
    } else if (seg === "local") {
      // TTS local-branch twin: the flag marks the arm (survives
      // save/reopen), the endpoint prefills the faster-whisper suggestion
      // for editing, the model rides the local row's default.
      const local = getSttProviderPreset("local");
      updateForm("backend", STT_BACKENDS.OpenAiCompat);
      updateForm("config", {
        [STT_LOCAL_SERVER_FLAG]: true,
        endpoint: STT_LOCAL_PRESET_ENDPOINT,
        model: (local ? defaultModelOf(local.modelSource) : undefined) ?? "whisper-1",
      });
    } else if (seg === "cloud" || seg === "native") {
      // Each group segment applies its first roster row (cloud → OpenAI,
      // native → Gemini — roster order, never hardcoded ids).
      const first = STT_PROVIDER_PRESETS.find((p) => p.group === seg);
      if (first) applyPreset(first.id);
    } else {
      updateForm("backend", STT_BACKENDS.OpenAiCompat);
      updateForm("config", {});
    }
  }

  /** Preset apply (SPE-7 (+ SPE-8 group arms) — the stt-quickstarts.ts
   *  successor). Cloud rows fill endpoint + default model; the LOCAL row
   *  takes the local-segment mechanics (flag + port suggestion the user
   *  edits — the old quickstart's behavior, kept verbatim); native rows
   *  set the backend slug (the hook prefills the adapter default model)
   *  and restore the row default on re-apply. The whisper.cpp row (SPE-9)
   *  sets its own backend slug + prefilled endpoint under the local flag
   *  — no model (server-bound). */
  function applyPreset(id: string): void {
    const preset = getSttProviderPreset(id);
    if (!preset) return;
    if (preset.group === "native") {
      if (form.backend !== preset.backend) updateForm("backend", preset.backend);
      updateForm("config", { ...form.config, model: defaultModelOf(preset.modelSource) });
      return;
    }
    if (preset.id === "local") {
      if (form.backend !== STT_BACKENDS.OpenAiCompat) updateForm("backend", STT_BACKENDS.OpenAiCompat);
      updateForm("config", {
        ...form.config,
        [STT_LOCAL_SERVER_FLAG]: true,
        endpoint: STT_LOCAL_PRESET_ENDPOINT,
        model: defaultModelOf(preset.modelSource),
      });
      return;
    }
    // SPE-9: an own-wire LOCAL row (whisper.cpp) — backend slug + prefilled
    // endpoint under the local flag; no model field to fill.
    if (preset.group === "local" && preset.backend !== STT_BACKENDS.OpenAiCompat) {
      if (form.backend !== preset.backend) updateForm("backend", preset.backend);
      const next: Record<string, unknown> = {
        ...form.config,
        [STT_LOCAL_SERVER_FLAG]: true,
        endpoint: preset.baseUrl,
      };
      // A stale model from the previous arm is meaningless here — the
      // model is bound at server start (`-m`), not request-side.
      delete next.model;
      updateForm("config", next);
      return;
    }
    if (preset.backend !== STT_BACKENDS.OpenAiCompat) return;
    if (form.backend !== STT_BACKENDS.OpenAiCompat) updateForm("backend", STT_BACKENDS.OpenAiCompat);
    const next: Record<string, unknown> = {
      ...form.config,
      endpoint: preset.baseUrl,
      model: defaultModelOf(preset.modelSource),
    };
    // A cloud apply leaves the local arm (the flag is segment state).
    delete next[STT_LOCAL_SERVER_FLAG];
    updateForm("config", next);
  }

  async function handleTest(): Promise<void> {
    if (testing || !canTestConnection(form)) return;
    setTesting(true);
    setTestOk(null);
    try {
      // Single probe (TTS fans out models+voices; STT has one catalog —
      // the model list IS the reachability proof).
      await listSttDraftModels({
        backend: form.backend,
        config: formDraftConfig(form),
        profileId: form.id ?? undefined,
      });
      setTestOk(true);
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  /** Dropdown value (SPE-7 detection + SPE-8 native arm): cloud matches the
   *  endpoint against fixed-baseUrl rows (the local row never auto-detects
   *  — TTS preset rule: the user stays on «custom»/«local» until re-apply);
   *  native resolves the row backing the backend slug; local resolves the
   *  whisper.cpp row by its backend slug (the generic row never
   *  auto-detects — its baseUrl is empty by design). */
  const formEndpoint = normalizeSttEndpoint(configString(form.config, "endpoint"));
  const selectedPreset =
    segment === "cloud"
      ? groupPresets.find((p) => p.baseUrl !== "" && normalizeSttEndpoint(p.baseUrl) === formEndpoint)
      : segment === "native"
        ? getSttNativePreset(form.backend)
        : segment === "local"
          ? groupPresets.find(
              (p) => p.backend !== STT_BACKENDS.OpenAiCompat && p.backend === form.backend,
            )
          : undefined;
  const presetId = selectedPreset?.id ?? "";
  const presetEndpoint = selectedPreset?.baseUrl ?? "";

  return (
    <>
      {/* Row 1: profile name + backend segment */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="mb-3">
          <label className={lblCls}>{t("profile_name")}</label>
          <TextInput
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder={t("profile_name_placeholder")}
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
          <label className={lblCls}>{t("provider_preset_label")}</label>
          {/* P7 (audit 2026-09-04): dropdown instead of the wrapping segment
           *  row — same replacement as the TTS preset segment. */}
          <DropdownSelect
            value={segment}
            options={segmentOptions.map((o) => ({ id: o.value, label: o.label }))}
            onChange={handleSegmentChange}
            searchable={false}
            triggerTestId="stt-backend-select"
          />
          {/* Data-driven per-backend notes (SPE-6/7): EN-only warning for the
           *  NVIDIA roster; the Deepgram RU note — nova-3 understands Russian
           *  natively. Authored copy, never truncated (layout rule). */}
          {nativePreset?.englishOnly === true && (
            <div
              data-testid="stt-nvidia-en-only-hint"
              className="mt-1 flex items-center gap-1 text-[11px] text-warning"
            >
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px] shrink-0">
                <Icons.Alert />
              </span>
              {t("stt_nvidia_en_only")}
            </div>
          )}
          {form.backend === STT_BACKENDS.Deepgram && (
            <div data-testid="stt-deepgram-ru-note" className="mt-1 font-ui text-[11px] text-t3">
              {t("stt_deepgram_ru_note")}
            </div>
          )}
        </div>
      </div>

      {/* Named presets (SPE-7 rows + SPE-8 group filter — the stt-quickstarts
          successor): the active group's rows from STT_PROVIDER_PRESETS, pure
          data (endpoint + default model prefill for cloud; backend slug +
          default model for natives; backend slug + prefilled endpoint for
          own-wire locals, SPE-9). Custom/browser offer no rows — the
          dropdown disables there, exactly like the TTS form; the Local
          segment carries its named rows (SPE-9). Live discovery stays the
          level-2 fetched picker (ST-8/P8). */}
      {(segment === "cloud" || segment === "native" || segment === "local") && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="mb-3">
            <label className={lblCls}>{t("api_format_label")}</label>
            <DropdownSelect
              value={presetId}
              options={groupPresets.map((p) => {
                const key = STT_PRESET_LABEL_KEYS[p.id as keyof typeof STT_PRESET_LABEL_KEYS];
                return { id: p.id, label: key !== undefined ? t(key) : p.id };
              })}
              placeholder={t("custom")}
              onChange={(val) => {
                if (val) applyPreset(val);
              }}
              triggerTestId="stt-quickstart-select"
            />
          </div>
          <div className="mb-3">
            <label className={lblCls}>{t("preset_endpoint_label")}</label>
            <TextInput value={presetEndpoint || t("custom")} readOnly />
          </div>
        </div>
      )}

      {/* Endpoint (the TTS showEndpoint twin: custom + local always —
          including the whisper.cpp own-wire local backend, whose address
          is user-editable; cloud only for the compat transport — cloud
          natives talk to fixed endpoints; the model and language moved to
          the level-2 section, P8). */}
      {(segment === "custom" || segment === "local" || (segment === "cloud" && isCompat)) && (
        <div className="mb-3">
          <label className={lblCls}>{t("stt_field_endpoint")}</label>
          <TextInput
            value={configString(form.config, "endpoint")}
            onChange={(e) => updateConfigField(stt, form, "endpoint", e.target.value)}
            placeholder="https://api.openai.com/v1"
            data-testid="stt-field-endpoint"
          />
        </div>
      )}

      {/* API key (cloud, native, custom, and the generic local server —
          which MAY front a keyed edge server; the browser tier and the
          keyless whisper.cpp local backend need none, SPE-9) */}
      {!isBrowser && form.backend !== STT_BACKENDS.WhisperCpp && (
        <div className="mb-3">
          <label className={lblCls}>{t("api_key_label")}</label>
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
            <ConnectionAutoKeyHint
              testId="stt-key-source-hint"
              message={t("stt_key_from_provider_hint", { name: autoKeyName })}
            />
          )}
        </div>
      )}

      {/* Local-server discovery + setup help (ST-8) — the TTS localHelpers
          twin: the panel belongs to the Local segment only, not to every
          compat profile. */}
      {segment === "local" && <SttLocalServerPanel form={form} stt={stt} />}

      {/* Browser-model download panel (audit P5) — the level-1 whisper
          surface, mirroring the kokoro branch of TtsProviderForm: the
          roster PICK lives in level 2 (SttRecognitionSection), this panel
          is the DOWNLOAD. */}
      {isBrowser && (
        <div className="mb-3">
          <WhisperModelPanel form={form} stt={stt} />
        </div>
      )}

      {/* Test connection card — PROBE semantics (P10): key+endpoint+catalog
          via the draft-models route; works on unsaved drafts like TTS.
          Every server arm (cloud, native, local, custom); the browser
          backend has nothing remote to test — its "status" is the roster
          badge above. */}
      {!isBrowser ? (
        <div className="my-3 rounded-lg border border-border bg-surface p-3.5" data-testid="stt-test-card">
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
            {testOk !== null && (
              <ConnectionProbeStatus
                ok={testOk}
                successTestId="stt-test-success"
                failureTestId="stt-test-failure"
                successText={t("connection_successful")}
                failureText={t("connection_failed")}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="my-3 rounded-lg border border-border bg-surface p-3.5" data-testid="stt-browser-test-note">
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <Icons.Check className="h-3.5 w-3.5 shrink-0 text-success" />
            <span className="font-ui text-[12px] text-t4">{t("stt_test_browser_note")}</span>
          </div>
        </div>
      )}
    </>
  );
}