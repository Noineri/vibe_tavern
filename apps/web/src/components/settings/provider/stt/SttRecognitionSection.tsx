import {
  STT_BACKENDS,
  STT_BACKEND_EMOTION_CAPABILITY,
  WHISPER_MODELS,
  getSttNativePreset,
} from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { whisperAcceptsLanguage } from "../../../../lib/stt/whisper-language.js";
import { WHISPER_LANGUAGES, whisperLanguageLabel } from "../../../../lib/stt/whisper-languages.js";
import { currentWhisperLane } from "../../../../lib/stt/whisper-client-instance.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { Icons } from "../../../shared/icons.js";
import { Toggle } from "../../../shared/Toggle.js";
import { labelCls } from "../form-field-classes.js";
import { configString } from "./stt-form-helpers.js";
import { SttModelPicker } from "./SttModelPicker.js";
import type { SttModelOption } from "./SttModelPicker.js";
import type { SttProfileForm, useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

interface SttRecognitionSectionProps {
  /** Clean view-mode form (the saved profile's values). */
  form: SttProfileForm;
  /** Config write (model / language) — same updateConfigField path as before. */
  onUpdate: (key: string, value: unknown) => void;
  /** Form-field write (the emotion toggle rides the profile, not config). */
  onUpdateForm: (patch: Partial<SttProfileForm>) => void;
  /** Live catalog for the fetched picker (openai-compat + gemini). */
  models: SttModelOption[];
  fetching: boolean;
  fetchError: string | null;
  onRefresh: () => void;
}

/**
 * LEVEL-2 outer recognition settings (P8, governing rule owner 2026-09-04):
 * everything that is NOT connection lives here, under the base card in view
 * mode — the MODEL (fetched picker for every listable backend: openai-compat
 * + gemini; the whisper-browser roster dropdown for the local tier), the
 * language hint, and the ST-7 emotion toggle. The connection card
 * (SttProviderForm) keeps ONLY preset/endpoint-or-download/key/probe. The
 * TTS twin is the model-picker + voice section under TtsBaseCard.
 */
export function SttRecognitionSection({
  form,
  onUpdate,
  onUpdateForm,
  models,
  fetching,
  fetchError,
  onRefresh,
}: SttRecognitionSectionProps) {
  const { t } = useT();
  const isBrowser = form.backend === STT_BACKENDS.WhisperBrowser;
  const showsEmotionToggle = STT_BACKEND_EMOTION_CAPABILITY[form.backend];
  const whisperModelId = configString(form.config, "model");
  // SPE-7 natives: a preset row with a STATIC roster (elevenlabs/nvidia)
  // feeds the picker shipped data instead of a fetch — same popover UX
  // (search + custom-slug row), refresh hidden. NVIDIA additionally hides
  // the language field (the adapter ignores it — English-only roster).
  const nativePreset = isBrowser ? undefined : getSttNativePreset(form.backend);
  const staticRoster =
    nativePreset?.modelSource.kind === "static"
      ? nativePreset.modelSource.models.map((id) => ({ id, label: id }))
      : null;
  // SPE-9: an own-wire LOCAL backend with a server-bound model
  // (whisper.cpp `-m`) — no request-side model at all; the model picker is
  // replaced by the server-flags hint (the language field stays: the
  // server accepts a per-request `language` multipart field).
  const serverBoundModel = nativePreset?.modelSource.kind === "server";
  const showLanguageField =
    (!isBrowser || whisperAcceptsLanguage(whisperModelId)) && nativePreset?.englishOnly !== true;
  // Lane-aware size (P12 — same rule as WhisperModelPanel): the GPU lane
  // downloads the fp32-encoder + q4-decoder file set, so the roster detail
  // must describe what will ACTUALLY land on this machine.

  return (
    <>
      {/* Model: fetched picker (openai-compat + gemini + deepgram), the
       *  local roster dropdown (whisper-browser — no fetch; the roster is
       *  fixed data), the STATIC native roster (elevenlabs/nvidia —
       *  preset data, refresh hidden, SPE-7), or the server-flags hint
       *  (whisper.cpp — model bound at server start, SPE-9). */}
      {isBrowser ? (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("stt_field_model")}</label>
          <DropdownSelect
            value={whisperModelId}
            options={WHISPER_MODELS.map((m) => ({
              id: m.id,
              label: m.label,
              detail: `${currentWhisperLane() === "webgpu" ? m.approxMbGpu : m.approxMb} MB`,
            }))}
            placeholder={t("stt_field_model")}
            onChange={(id) => onUpdate("model", id)}
            searchable={false}
            triggerTestId="stt-whisper-model-select"
          />
          <div data-testid="stt-backend-browser-note" className="mt-1 font-ui text-[11px] text-t3">
            {t("stt_field_whisper_hint")}
          </div>
        </div>
      ) : serverBoundModel ? (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("stt_field_model")}</label>
          <div
            data-testid="stt-whispercpp-server-model-hint"
            className="rounded-md border border-border bg-s1 px-3 py-2 font-ui text-[11px] text-t3"
          >
            {t("stt_whispercpp_server_hint")}
          </div>
        </div>
      ) : staticRoster !== null ? (
        <SttModelPicker
          value={configString(form.config, "model")}
          onChange={(id) => onUpdate("model", id)}
          models={staticRoster}
          fetching={false}
          fetchError={null}
          label={t("stt_field_model")}
        />
      ) : (
        <SttModelPicker
          value={configString(form.config, "model")}
          onChange={(id) => onUpdate("model", id)}
          models={models}
          fetching={fetching}
          fetchError={fetchError}
          onRefresh={onRefresh}
          label={t("stt_field_model")}
        />
      )}

      {/* Language (P12) — a searchable dropdown over the whisper catalog,
       *  NOT free text: transformers.js accepts only a two-letter code or
       *  an English name and throws on anything else, and an empty language
       *  does NOT auto-detect. The pinned top entry ("interface language",
       *  stored as "") sends the UI locale on the whisper-browser path;
       *  hidden for English-only whisper models. */}
      {showLanguageField && (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("stt_field_language")}</label>
          <DropdownSelect
            value={configString(form.config, "language")}
            options={WHISPER_LANGUAGES.map((l) => ({
              id: l.code,
              label: whisperLanguageLabel(l),
            }))}
            placeholder={t("stt_field_language_interface")}
            defaultOption={t("stt_field_language_interface")}
            onChange={(id) => onUpdate("language", id)}
            searchable={true}
            triggerTestId="stt-field-language"
          />
        </div>
      )}

      {/* ST-7: the tone-annotation toggle — rendered ONLY for capable
          backends (gemini); pure-ASR backends never see it and the server
          forces the stored flag off. Relocated from the connection form in
          P8 (governing rule: tuning is level-2). */}
      {showsEmotionToggle && (
        <div className="mb-3" data-testid="stt-emotion-toggle-block">
          <div className="flex cursor-pointer items-start gap-2.5 text-left">
            <Toggle
              checked={form.emotionAnnotation}
              onChange={(v) => onUpdateForm({ emotionAnnotation: v })}
              aria-label={t("stt_emotion_label")}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-ui text-[13px] text-t1">{t("stt_emotion_label")}</span>
              <span className="font-ui text-[11px] text-t3">{t("stt_emotion_hint")}</span>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
