import { useT } from "../../../../i18n/context.js";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import { TTS_PRESETS } from "../../../../lib/tts/tts-presets.js";
import { Icons } from "../../../shared/icons.js";
import { useTtsPreview } from "./use-tts-preview.js";
import { configString } from "./tts-form-helpers.js";
import { ttsPresetIdOf } from "./tts-backend-ui.js";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";
import type { TtsProfileForm } from "./use-tts-profiles.js";
import { toBackendSlug } from "./use-tts-profiles.js";

interface TtsBaseCardProps {
  /** Saved profile record — source of truth for isDefault + preview. */
  profile: TtsProfileRecord;
  /** Current form (clean, collapsed state — mirrors profile but needed for label derivation). */
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

export function TtsBaseCard({ profile, form, isDefault, onEdit, onSetDefault }: TtsBaseCardProps) {
  const { t } = useT();
  const preview = useTtsPreview();

  const presetLabel = ttsPresetLabelFor(form);
  const isKokoro = form.backend === TTS_BACKEND.Kokoro;
  const hasKey = isKokoro || form.hasStoredApiKey || Boolean(configString(form.config, "apiKey"));
  // Keep the same status rendering pattern as ProviderViewHeader: a colored chip with icon.
  // Kokoro has no key — show "Model ready" instead.
  const statusKey = isKokoro ? "tts_kokoro_model_ready" : hasKey ? "api_key_saved" : "no_api_key";

  function handlePreview(): void {
    const speedRaw = profile.config["speed"];
    const speed = typeof speedRaw === "number" ? speedRaw : 1;
    preview.preview({
      backend: toBackendSlug(profile.backend),
      voiceId: profile.voiceId,
      narratorVoiceId: profile.narratorVoiceId,
      speed,
      config: profile.config,
      profileId: profile.id,
    });
  }

  return (
    <div className="mb-6" data-testid="tts-base-card">
      <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border2 bg-s2 p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4">
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
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-success">
                <Icons.Check /> {t(statusKey)}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-warning">
                <Icons.Alert /> {t("no_api_key")}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onEdit}
            data-testid="tts-base-card-edit-btn"
            className="mt-3 flex items-center gap-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:text-accent"
          >
            <Icons.Edit /> {t("edit_settings_btn")}
          </button>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <button
            type="button"
            onClick={handlePreview}
            disabled={preview.state !== "idle"}
            data-testid="tts-base-card-preview-btn"
            className="min-h-11 w-full rounded-md border border-border bg-s2 px-4 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50 sm:h-[34px] sm:min-h-0 sm:w-auto"
          >
            {preview.state === "generating"
              ? preview.downloadPct !== null
                ? t("tts_preview_downloading", { pct: preview.downloadPct })
                : t("tts_preview_generating")
              : preview.state === "playing"
                ? t("tts_preview_playing")
                : t("test_hi_btn")}
          </button>
          <button
            type="button"
            onClick={onSetDefault}
            data-testid="tts-base-card-default-btn"
            className="min-h-11 w-full rounded-md border border-accent bg-accent-dim px-4 font-ui text-[13px] font-medium text-accent-t transition-colors hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:opacity-50 sm:h-[34px] sm:min-h-0 sm:w-auto"
            disabled={isDefault}
          >
            {isDefault ? t("tts_is_default") : t("tts_make_default")}
          </button>
        </div>
      </div>
      {preview.error && (
        <div data-testid="tts-base-card-preview-error" className="mt-2 font-ui text-[11px] text-danger">
          {preview.error}
        </div>
      )}
    </div>
  );
}
