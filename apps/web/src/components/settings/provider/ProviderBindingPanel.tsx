import { useT } from "../../../i18n/context.js";
import type { FavoriteProviderModelRecord } from "../../../app-client.js";
import type { FormState } from "../../modals/ProviderModal.js";
import { Icons } from "../../shared/icons.js";
import { Toggle } from "../../shared/Toggle.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";

const labelCls =
  "block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3";

interface ProviderBindingPanelProps {
  form: FormState;
  /** Starred models for this profile (drives the binding-target dropdown). */
  favorites: FavoriteProviderModelRecord[];
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  /** Fired when the user picks a model in the binding dropdown. The modal
   *  re-hydrates the form's sampler/context fields from that model's overlay
   *  (merged over the persisted base profile) and sets `editingModelId`. */
  onSelectBindingModel: (modelId: string) => Promise<void>;
}

/**
 * Per-model binding control. Renders the profile-level "bind settings per
 * model" toggle and, when ON, a favorites dropdown to pick WHICH model's
 * overlay to edit + an "Editing: <model>" badge.
 *
 * The toggle is profile-level (persisted as `bindPerModel` on the profile).
 * The dropdown selection is UI-only state (`editingModelId` on the form) — it
 * routes saves to that model's overlay (see Wave 4 save routing) and
 * re-hydrates the form to show that model's effective settings.
 *
 * When binding is OFF, the dropdown is hidden (toggle collapsed) and
 * `editingModelId` is preserved (not cleared) so re-enabling restores the
 * selection — per plan §102.
 */
export function ProviderBindingPanel({
  form,
  favorites,
  updateForm,
  onSelectBindingModel,
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

      {/* Dropdown + badge — only when binding is ON */}
      {form.bindPerModel && (
        <div className="mt-3">
          {favorites.length === 0 ? (
            <div className="flex items-center gap-1.5 font-ui text-[12px] text-t3 italic">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Alert /></span>
              {t("binding_no_favorites_hint")}
            </div>
          ) : (
            <>
              <label className={labelCls + " mb-[6px]"}>{t("binding_dropdown_label")}</label>
              <DropdownSelect
                value={form.editingModelId ?? ""}
                options={favorites.map((f) => ({
                  id: f.modelId,
                  label: f.label?.trim() || f.modelId,
                  detail: f.contextLength != null ? `${f.contextLength.toLocaleString()} ctx` : undefined,
                }))}
                placeholder={t("binding_dropdown_placeholder")}
                searchable
                onChange={(modelId) => {
                  if (modelId) void onSelectBindingModel(modelId);
                }}
              />
              {form.editingModelId && (
                <div className="mt-2">
                  <span className="inline-flex items-center gap-1.5 rounded bg-accent/10 px-2.5 py-1 font-mono text-[11px] text-accent">
                    <span className="[&_svg]:h-[11px] [&_svg]:w-[11px]"><Icons.Edit /></span>
                    {t("editing_model_badge").replace("{{model}}", form.editingModelId)}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
