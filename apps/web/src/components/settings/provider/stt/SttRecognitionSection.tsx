import {
  STT_BACKENDS,
  STT_BACKEND_EMOTION_CAPABILITY,
  WHISPER_MODELS,
} from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { whisperAcceptsLanguage } from "../../../../lib/stt/whisper-language.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { Icons } from "../../../shared/icons.js";
import { cn } from "../../../../lib/cn.js";
import { labelCls, inputCls } from "../form-field-classes.js";
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
  const showLanguageField = !isBrowser || whisperAcceptsLanguage(whisperModelId);

  return (
    <>
      {/* Model: fetched picker (openai-compat + gemini) or the local roster
       * dropdown (whisper-browser — no fetch; the roster is fixed data). */}
      {isBrowser ? (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("stt_field_model")}</label>
          <DropdownSelect
            value={whisperModelId}
            options={WHISPER_MODELS.map((m) => ({
              id: m.id,
              label: m.label,
              detail: `${m.approxMb} MB`,
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

      {/* Optional language — hidden for English-only whisper models. */}
      {showLanguageField && (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("stt_field_language")}</label>
          <input
            type="text"
            value={configString(form.config, "language")}
            onChange={(e) => onUpdate("language", e.target.value)}
            placeholder={t("stt_field_language_placeholder")}
            className={inputCls}
            data-testid="stt-field-language"
          />
        </div>
      )}

      {/* ST-7: the tone-annotation toggle — rendered ONLY for capable
          backends (gemini); pure-ASR backends never see it and the server
          forces the stored flag off. Relocated from the connection form in
          P8 (governing rule: tuning is level-2). */}
      {showsEmotionToggle && (
        <div className="mb-3" data-testid="stt-emotion-toggle-block">
          <button
            type="button"
            role="switch"
            aria-checked={form.emotionAnnotation}
            onClick={() => onUpdateForm({ emotionAnnotation: !form.emotionAnnotation })}
            className="flex cursor-pointer items-start gap-2.5 text-left"
            data-testid="stt-emotion-toggle"
          >
            <span
              className={cn(
                "mt-0.5 flex h-[18px] w-[32px] shrink-0 items-center rounded-full border px-[2px] transition-colors",
                form.emotionAnnotation ? "border-accent bg-accent/20 justify-end" : "border-border bg-s3 justify-start",
              )}
            >
              <span
                className={cn(
                  "h-[12px] w-[12px] rounded-full transition-colors",
                  form.emotionAnnotation ? "bg-accent" : "bg-t4",
                )}
              />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-ui text-[13px] text-t1">{t("stt_emotion_label")}</span>
              <span className="font-ui text-[11px] text-t3">{t("stt_emotion_hint")}</span>
            </span>
          </button>
        </div>
      )}
    </>
  );
}
