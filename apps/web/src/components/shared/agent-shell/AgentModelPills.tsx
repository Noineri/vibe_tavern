import { cn } from "../../../lib/cn.js";
import { Icons } from "../icons.js";
import { ToolbarSelect } from "../ToolbarSelect.js";
import { DropdownSelect } from "../DropdownSelect.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useProviderModels } from "../../../hooks/use-provider-models.js";
import { useCopilotModelFavorites } from "../../../hooks/use-copilot-model-favorites.js";
import { useT } from "../../../i18n/context.js";

/**
 * Provider + model pills of the agent composer (AP-26 — extracted verbatim
 * from `AgentInputArea`; invisible move, no behavior change). Renders as a
 * FRAGMENT: the host row owns the layout and spacing, so the composer's DOM
 * shape is byte-identical to the pre-extraction markup.
 *
 * Controlled by the same binding the shell passes the composer: the host owns
 * the selection, this component only renders it. The provider/model picker is
 * the controlled counterpart of the co-author favorites pill: the available
 * PROVIDER list is the global `useProviderDataStore.profiles` (the same source
 * the co-author binding reads), and the MODEL list is `useProviderModels`
 * (all of the provider's models — same source as the co-author picker).
 */
export interface AgentModelPillsProps {
  providerProfileId: string | null;
  model?: string;
  onProviderChange: (profileId: string, model?: string) => void;
}

export function AgentModelPills(props: AgentModelPillsProps) {
  const { providerProfileId, model, onProviderChange } = props;

  const { t } = useT();

  const profiles = useProviderDataStore((s) => s.profiles);
  const { models } = useProviderModels(providerProfileId);
  const { favorites, isFavorite, toggleFavorite } = useCopilotModelFavorites(providerProfileId);

  const activeProfile = profiles.find((p) => p.id === providerProfileId) ?? null;

  /** Inline star toggle rendered as every model row's trailing action. Clicking
   * it toggles the copilot-scoped favorite and NEVER selects the model
   * (DropdownSelect stops pointer events on trailing nodes). */
  const favoriteStar = (modelId: string, label: string, contextLength: number | null, favored: boolean) => (
    <button
      type="button"
      data-testid={`copilot-model-star-${modelId}`}
      title={favored ? t("copilot_model_unstar") : t("copilot_model_star")}
      aria-label={favored ? t("copilot_model_unstar") : t("copilot_model_star")}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:text-t1",
        favored && "text-warning-text",
      )}
      onClick={() => toggleFavorite({ id: modelId, label, contextLength })}
    >
      {favored ? <Icons.starFilled className="h-3.5 w-3.5" /> : <Icons.star className="h-3.5 w-3.5" />}
    </button>
  );

  return (
    <>
      {/* Provider picker — controlled via props. */}
      <ToolbarSelect
        title={t("agent_provider")}
        triggerTooltip={t("agent_provider")}
        contentWidth={220}
        items={profiles.map((p) => ({ value: p.id, label: p.name }))}
        value={providerProfileId}
        onSelect={(profileId) => onProviderChange(profileId)}
        itemTestId={(v) => `copilot-provider-option-${v}`}
        trigger={
          <button
            type="button"
            data-testid="copilot-provider-pill"
            className="flex h-8 min-w-0 max-w-[120px] items-center gap-1.5 rounded-[5px] bg-s2 px-2.5 font-ui text-[12.5px] text-t1 transition-colors hover:bg-s3"
          >
            <Icons.Plug className="h-3.5 w-3.5 shrink-0 text-t3" />
            <span className="min-w-0 truncate">{activeProfile?.name ?? t("agent_provider_select")}</span>
            <Icons.Caret direction="d" className="h-3 w-3 shrink-0 text-t3" />
          </button>
        }
      />

      {/* Model picker — searchable (DropdownSelect/cmdk) with the profile's
       * copilot-scoped favorites pinned as the top section and an inline
       * star toggle on every row. Variant A: only the CURRENT profile's
       * favorites are shown; switching providers swaps the section. */}
      <DropdownSelect
        value={model ?? ""}
        onChange={(modelId) => {
          if (providerProfileId) onProviderChange(providerProfileId, modelId);
        }}
        side="top"
        searchPlaceholder={t("search_models")}
        placeholder={t("agent_model_select")}
        triggerTestId="copilot-model-pill"
        contentWidth={320}
        triggerLeading={<Icons.Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-t" />}
        triggerClassName={cn(
          "h-8 w-[240px] shrink rounded-[5px] bg-s2 px-2.5 text-[12.5px] text-t1 transition-colors hover:bg-s3",
          model ? "" : "text-t3",
        )}
        options={models.map((m) => ({ id: m.id, label: m.label }))}
        groups={[
          ...(favorites.length > 0
            ? [{
                id: "copilot-model-favorites",
                label: t("copilot_model_favorites_section"),
                options: favorites.map((f) => ({
                  id: f.modelId,
                  label: f.label || f.modelId,
                  trailing: favoriteStar(f.modelId, f.label || f.modelId, f.contextLength, true),
                })),
              }]
            : []),
          {
            id: "copilot-model-all",
            label: favorites.length > 0 ? t("copilot_model_all_section") : undefined,
            options: models.map((m) => ({
              id: m.id,
              label: m.label,
              trailing: favoriteStar(m.id, m.label, m.contextLength ?? null, isFavorite(m.id)),
            })),
          },
        ]}
      />
    </>
  );
}
