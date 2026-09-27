import { useT } from "../../../i18n/context.js";
import type { FavoriteProviderModelRecord } from "../../../api/types.js";
import type { FormState } from "../../modals/ProviderModal.js";
import { Icons } from "../../shared/icons.js";
import { Toggle } from "../../shared/Toggle.js";

interface ProviderBindingPanelProps {
  form: FormState;
  /** Starred models for this profile (drives the follow/badge state). */
  favorites: FavoriteProviderModelRecord[];
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}

/**
 * Per-model binding control. Renders the profile-level "bind settings per
 * model" toggle and, when ON, an honest badge saying WHERE the settings below
 * are being edited (owner ruling 2026-09-27):
 *  - active model is a favorite → "Editing: <model>" — its own overlay;
 *  - active model is not a favorite (or none starred) → "Base settings" —
 *    edits land on the profile base, which is exactly what non-favorite
 *    models use at generation.
 *
 * The editor FOLLOWS the profile's active model (ProviderModal's follow
 * effect) — there is no manual binding dropdown: switching the model (here or
 * via the chat quick-switch) re-points the editor automatically. The toggle
 * itself is profile-level (persisted as `bindPerModel` on the profile).
 */
export function ProviderBindingPanel({
  form,
  favorites,
  updateForm,
}: ProviderBindingPanelProps) {
  const { t } = useT();

  return (
    <div className="my-3 rounded-lg border border-border2 bg-s2 px-4 py-2.5">
      {/* Toggle row */}
      <div className="flex items-center gap-3">
        <Toggle
          checked={form.bindPerModel}
          onChange={(v) => updateForm("bindPerModel", v as FormState["bindPerModel"])}
          className="!mb-0 !inline-flex"
        />
        <div className="min-w-0">
          <div className="font-ui text-[13px] font-medium text-t1">
            {t("bind_to_favorite_model")}
          </div>
          <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
            {t("bind_to_favorite_model_hint")}
          </div>
        </div>
      </div>

      {/* Editing-target badge — only when binding is ON */}
      {form.bindPerModel && (
        <div className="mt-3">
          {favorites.length === 0 ? (
            <div className="flex items-center gap-1.5 font-ui text-[12px] text-t3 italic">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Alert /></span>
              {t("binding_no_favorites_hint")}
            </div>
          ) : form.editingModelId ? (
            <div>
              <span className="inline-flex items-center gap-1.5 rounded bg-accent/10 px-2.5 py-1 font-mono text-[11px] text-accent">
                <span className="[&_svg]:h-[11px] [&_svg]:w-[11px]"><Icons.Edit /></span>
                {t("editing_model_badge", { model: form.editingModelId })}
              </span>
            </div>
          ) : (
            <div>
              <span className="inline-flex items-center gap-1.5 rounded bg-s3 px-2.5 py-1 font-mono text-[11px] text-t3">
                <span className="[&_svg]:h-[11px] [&_svg]:w-[11px]"><Icons.Settings /></span>
                {t("binding_base_badge")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
