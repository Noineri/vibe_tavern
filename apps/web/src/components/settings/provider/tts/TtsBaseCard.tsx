import { useT } from "../../../../i18n/context.js";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import { ttsTagDialectForProfile } from "../../../../lib/tts/tts-tags.js";
import { TTS_PRESETS } from "../../../../lib/tts/tts-presets.js";
import { Icons } from "../../../shared/icons.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { configString } from "./tts-form-helpers.js";
import { ttsPresetIdOf } from "./tts-backend-ui.js";
import type { TtsTagDialect } from "../../../../lib/tts/tts-tags.js";
import type { TtsProfileForm } from "./use-tts-profiles.js";

/** i18n key for the per-dialect tooltip; null when the profile strips tags
 *  (TPE-15: the badge is hidden in that case, so no tooltip is needed). */
export function emotionTagsHintKey(dialect: TtsTagDialect): string | null {
  switch (dialect) {
    case "orpheus":
      return "tts_emotion_tags_hint_orpheus";
    case "chatterbox":
      return "tts_emotion_tags_hint_chatterbox";
    case "inworld":
      return "tts_emotion_tags_hint_inworld";
    case "minimax":
      return "tts_emotion_tags_hint_minimax";
    case "strip":
      return null;
  }
}

interface TtsBaseCardProps {
  /** Current form (clean, collapsed state — label/status derivation). */
  form: TtsProfileForm;
  isDefault: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
}

function ttsPresetLabelFor(form: TtsProfileForm): string {
  const presetId = ttsPresetIdOf(form.config);
  if (presetId) {
    const preset = TTS_PRESETS.find((p) => p.id === presetId);
    if (preset) return preset.label;
    return presetId;
  }
  if (form.backend === TTS_BACKEND.Kokoro) return "Kokoro";
  if (form.backend === TTS_BACKEND.Gemini) return "Gemini";
  if (form.backend === TTS_BACKEND.ElevenLabs) return "ElevenLabs";
  const endpoint = configString(form.config, "endpoint");
  if (endpoint) {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  }
  return form.backend;
}

export function TtsBaseCard({ form, isDefault, onEdit, onSetDefault }: TtsBaseCardProps) {
  const { t, tDynamic } = useT();

  const presetLabel = ttsPresetLabelFor(form);
  const isKokoro = form.backend === TTS_BACKEND.Kokoro;
  const hasKey =
    isKokoro || form.hasStoredApiKey || form.autoKeyProviderName !== null || Boolean(configString(form.config, "apiKey"));
  // Keep the same status rendering pattern as ProviderViewHeader: a colored chip with icon.
  // Kokoro has no key — show "Model ready" instead.
  // TPE-15: surface the profile's emotion-tag dialect as a card-level fact,
  // next to the other status chips. Visible only when the profile actually
  // speaks tags (dialect !== "strip"); strip profiles say nothing.
  const tagDialect = ttsTagDialectForProfile({ backend: form.backend, config: form.config });
  const tagHintKey = emotionTagsHintKey(tagDialect);
  // Keep the same status rendering pattern as ProviderViewHeader: a colored chip with icon.
  // Kokoro has no key — show "Model ready" instead.
  const statusKey = isKokoro ? "tts_kokoro_model_ready" : hasKey ? "api_key_saved" : "no_api_key";

  return (
    <div className="mb-6" data-testid="tts-base-card">
      <div className="rounded-lg border border-border2 bg-s2 p-3 sm:p-4">
        <div className="min-w-0">
          <div className="mb-1 truncate font-ui text-[16px] font-semibold text-t1" data-testid="tts-base-card-name">
            {form.name}
          </div>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[13px] text-t3 sm:flex-nowrap"
            data-testid="tts-base-card-status"
          >
            <span>{presetLabel}</span>
            <span className="h-1 w-1 rounded-full bg-t4" />
            {form.autoKeyProviderName !== null && (
              <span className="text-t3" data-testid="tts-key-source-hint">
                {t("tts_key_from_provider_hint", { name: form.autoKeyProviderName })}
              </span>
            )}
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-success">
                <Icons.Check /> {t(statusKey)}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-warning">
                <Icons.Alert /> {t("no_api_key")}
              </span>
            )}
            {tagHintKey !== null && (
              <CustomTooltip content={tDynamic(tagHintKey)}>
                <span className="flex items-center gap-1.5 text-accent" data-testid="tts-emotion-tags-badge">
                  <Icons.Sparkles /> {t("tts_emotion_tags_badge")}
                </span>
              </CustomTooltip>
            )}
          </div>
        </div>
        {/* Owner 2026-08-29 (D18): Make-default sits on ONE line with Edit
         *  settings, on the opposite side — no right-hand button column, no
         *  Test-"Hi" on this card (listening lives under the voice picker). */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="tts-base-card-actions">
          <button
            type="button"
            onClick={onEdit}
            data-testid="tts-base-card-edit-btn"
            className="flex items-center gap-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:text-accent"
          >
            <Icons.Edit /> {t("edit_settings_btn")}
          </button>
          <button
            type="button"
            onClick={onSetDefault}
            data-testid="tts-base-card-default-btn"
            className="min-h-9 rounded-md border border-accent bg-accent-dim px-3 font-ui text-[12px] font-medium text-accent-t transition-colors hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isDefault}
          >
            {isDefault ? t("tts_is_default") : t("tts_make_default")}
          </button>
        </div>
      </div>
    </div>
  );
}
