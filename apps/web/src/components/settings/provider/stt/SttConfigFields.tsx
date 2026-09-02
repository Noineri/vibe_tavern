import {
  DEFAULT_GEMINI_STT_MODEL,
  STT_BACKENDS,
  WHISPER_MODELS,
  type SttBackendType,
} from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { whisperAcceptsLanguage } from "../../../../lib/stt/whisper-language.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { labelCls, inputCls } from "../form-field-classes.js";
import { monoUICls } from "../../../build/fields/field-styles.js";
import { configString } from "./stt-form-helpers.js";

/** Per-backend config fields shared by the view-mode editor and the
 *  connection form (STT_PLAN ST-4a): endpoint/model/language for
 *  openai-compat (free-text — live discovery is ST-8), roster dropdown +
 *  language for whisper-browser (English-only models hide the language
 *  field — the tokenizer rejects a hint on .en checkpoints), and free-text
 *  model + language for gemini (fixed endpoint — no endpoint field, ST-7).
 *  The API key is NOT here — connection-form-only (SttProviderForm). */
export function SttConfigFields({
  backend,
  config,
  onUpdate,
}: {
  backend: SttBackendType;
  config: Record<string, unknown>;
  onUpdate: (key: string, value: unknown) => void;
}) {
  const { t } = useT();
  const isBrowser = backend === STT_BACKENDS.WhisperBrowser;
  const isCompat = backend === STT_BACKENDS.OpenAiCompat;
  const isGemini = backend === STT_BACKENDS.Gemini;
  const whisperModelId = configString(config, "model");
  const showLanguageField = !isBrowser || whisperAcceptsLanguage(whisperModelId);

  return (
    <>
      {/* Endpoint (openai-compat only — gemini talks to the fixed Gemini API
          endpoint, ST-7). */}
      {isCompat && (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("stt_field_endpoint")}</label>
          <input
            type="text"
            value={configString(config, "endpoint")}
            onChange={(e) => onUpdate("endpoint", e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={monoUICls}
            data-testid="stt-field-endpoint"
          />
        </div>
      )}

      {/* Model: roster dropdown (browser) or free-text (openai-compat — no
          live discovery in this unit, ST-8 owns it; gemini — free text, the
          catalog cannot be filtered by audio input, ST-7). */}
      <div className="mb-3">
        <label className={labelCls + " mb-[6px]"}>{t("stt_field_model")}</label>
        {isBrowser ? (
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
        ) : (
          <input
            type="text"
            value={configString(config, "model")}
            onChange={(e) => onUpdate("model", e.target.value)}
            placeholder={isGemini ? DEFAULT_GEMINI_STT_MODEL : "whisper-1"}
            className={inputCls}
            data-testid="stt-field-model"
          />
        )}
        {isBrowser && (
          <div data-testid="stt-backend-browser-note" className="mt-1 font-ui text-[11px] text-t3">
            {t("stt_field_whisper_hint")}
          </div>
        )}
      </div>

      {/* Optional language — hidden for English-only whisper models. */}
      {showLanguageField && (
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("stt_field_language")}</label>
          <input
            type="text"
            value={configString(config, "language")}
            onChange={(e) => onUpdate("language", e.target.value)}
            placeholder={t("stt_field_language_placeholder")}
            className={inputCls}
            data-testid="stt-field-language"
          />
        </div>
      )}
    </>
  );
}