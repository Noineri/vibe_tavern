import { useT } from "../../../../i18n/context.js";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import { getImageGenProviderPreset } from "../../../../provider-presets.js";
import { Icons } from "../../../shared/icons.js";
import type { ImageGenProfileForm } from "../../../../hooks/use-image-profiles.js";

interface ImageGenBaseCardProps {
  /** Current form (clean, collapsed state — label/status derivation). */
  form: ImageGenProfileForm;
  onEdit: () => void;
}

/** View-mode connection label: a preset-backed profile shows the preset row
 *  label; a Custom profile shows the Custom label (IG-CF8 — bare custom,
 *  no protocol table) with the endpoint host beside it. */
function backendLabelFor(form: ImageGenProfileForm, customLabel: string): string {
  const preset = form.presetId !== null ? getImageGenProviderPreset(form.presetId) : undefined;
  if (preset) return preset.label;
  return customLabel;
}

function endpointHost(form: ImageGenProfileForm): string {
  const endpoint = form.endpoint.trim();
  if (!endpoint) return endpoint;
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** View-mode base card for a saved image-gen profile — the SttBaseCard fork
 *  (IG-11): name + connection line + key status + Edit. No Make-default
 *  action: image-gen profiles have no isDefault (a chat-level concern,
 *  IG-16/17 — the design decision recorded in the plan). The A1111 tier is
 *  keyless by default, so its no-key status is neutral, not a warning. */
export function ImageGenBaseCard({ form, onEdit }: ImageGenBaseCardProps) {
  const { t } = useT();

  const label = backendLabelFor(form, t("custom"));
  const host = endpointHost(form);
  const keylessByDesign = form.backend === IMAGE_GEN_BACKENDS.A1111;
  // IG-21: an auto-matched key counts as ready (the SttBaseCard twin) —
  //  the status row names its source; a1111 never matches.
  const autoKeyName = form.autoKeyProviderName;
  const hasKey = form.hasStoredApiKey || autoKeyName !== null || form.apiKey.trim() !== "";

  return (
    <div className="mb-6" data-testid="image-gen-base-card">
      <div className="rounded-lg border border-border2 bg-s2 p-3 sm:p-4">
        <div className="min-w-0">
          <div className="mb-1 truncate font-ui text-[16px] font-semibold text-t1" data-testid="image-gen-base-card-name">
            {form.name}
          </div>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[13px] text-t3 sm:flex-nowrap"
            data-testid="image-gen-base-card-status"
          >
            <span>{label}</span>
            {host && (
              <>
                <span className="h-1 w-1 rounded-full bg-t4" />
                <span className="min-w-0 truncate">{host}</span>
              </>
            )}
            <span className="h-1 w-1 rounded-full bg-t4" />
            {autoKeyName !== null && (
              <span className="text-t3" data-testid="image-gen-key-source-hint">
                {t("image_gen_key_from_provider_hint", { name: autoKeyName })}
              </span>
            )}
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-success">
                <Icons.Check /> {t("api_key_saved")}
              </span>
            ) : keylessByDesign ? (
              <span className="flex items-center gap-1.5 text-t3" data-testid="image-gen-base-card-keyless">
                <Icons.Check /> {t("image_gen_keyless_note")}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-warning">
                <Icons.Alert /> {t("no_api_key")}
              </span>
            )}
          </div>
        </div>
        {/* Action row: Edit only (no default-profile action — see header). */}
        <div className="mt-3 flex items-center" data-testid="image-gen-base-card-actions">
          <button
            type="button"
            onClick={onEdit}
            data-testid="image-gen-base-card-edit-btn"
            className="flex items-center gap-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:text-accent"
          >
            <Icons.Edit /> {t("edit_settings_btn")}
          </button>
        </div>
      </div>
    </div>
  );
}
