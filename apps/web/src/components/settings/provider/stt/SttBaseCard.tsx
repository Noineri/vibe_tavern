import { useT } from "../../../../i18n/context.js";
import { STT_BACKENDS } from "@vibe-tavern/domain";
import { Icons } from "../../../shared/icons.js";
import { configString } from "./stt-form-helpers.js";
import type { SttProfileForm } from "./use-stt-profiles.js";

interface SttBaseCardProps {
  /** Current form (clean, collapsed state — label/status derivation). */
  form: SttProfileForm;
  isDefault: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
}

/** View-mode connection label: browser backend is its own label; gemini is
 *  its own label (fixed endpoint, ST-7); an openai-compat profile labels
 *  itself by endpoint host (the TTS preset-label precedent, minus the cloud
 *  preset table). */
function sttBackendLabelFor(form: SttProfileForm): string {
  if (form.backend === STT_BACKENDS.WhisperBrowser) return "Whisper (in browser)";
  if (form.backend === STT_BACKENDS.Gemini) return "Gemini";
  const endpoint = configString(form.config, "endpoint");
  if (endpoint) {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  }
  return "OpenAI-compatible";
}

export function SttBaseCard({ form, isDefault, onEdit, onSetDefault }: SttBaseCardProps) {
  const { t } = useT();

  const backendLabel = sttBackendLabelFor(form);
  const isBrowser = form.backend === STT_BACKENDS.WhisperBrowser;
  const hasKey =
    isBrowser || form.hasStoredApiKey || form.autoKeyProviderName !== null || Boolean(configString(form.config, "apiKey"));
  // Same status rendering pattern as TtsBaseCard (its Kokoro twin shows
  // "Model ready" — tts_kokoro_model_ready); the browser backend needs no
  // key, so it shows the same model-centric status, not a place badge
  // (owner 2026-09-05: the "runs in browser" badge is an anti-pattern the
  // TTS side never had — removed).
  const statusKey = isBrowser ? "stt_whisper_model_ready" : hasKey ? "api_key_saved" : "no_api_key";

  return (
    <div className="mb-6" data-testid="stt-base-card">
      <div className="rounded-lg border border-border2 bg-s2 p-3 sm:p-4">
        <div className="min-w-0">
          <div className="mb-1 truncate font-ui text-[16px] font-semibold text-t1" data-testid="stt-base-card-name">
            {form.name}
          </div>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[13px] text-t3 sm:flex-nowrap"
            data-testid="stt-base-card-status"
          >
            <span>{backendLabel}</span>
            <span className="h-1 w-1 rounded-full bg-t4" />
            {form.autoKeyProviderName !== null && (
              <span className="text-t3" data-testid="stt-key-source-hint">
                {t("stt_key_from_provider_hint", { name: form.autoKeyProviderName })}
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
          </div>
        </div>
        {/* Same action row as TtsBaseCard (D18 pattern): Make-default on one
            line with Edit settings, on the opposite side. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2" data-testid="stt-base-card-actions">
          <button
            type="button"
            onClick={onEdit}
            data-testid="stt-base-card-edit-btn"
            className="flex items-center gap-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:text-accent"
          >
            <Icons.Edit /> {t("edit_settings_btn")}
          </button>
          <button
            type="button"
            onClick={onSetDefault}
            data-testid="stt-base-card-default-btn"
            className="min-h-9 rounded-md border border-accent bg-accent-dim px-3 font-ui text-[12px] font-medium text-accent-t transition-colors hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isDefault}
          >
            {isDefault ? t("stt_is_default") : t("stt_make_default")}
          </button>
        </div>
      </div>
    </div>
  );
}