import { cn } from "../../../lib/cn.js";
import { Icons } from "../icons.js";
import { ToolbarSelect } from "../ToolbarSelect.js";
import { DropdownSelect } from "../DropdownSelect.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { useProviderModels } from "../../../hooks/use-provider-models.js";
import { useCopilotModelFavorites } from "../../../hooks/use-copilot-model-favorites.js";
import { useT, type TFunc } from "../../../i18n/context.js";

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
 *
 * AP-26b: `mobile` renders today's phone pills exactly (both pickers as
 * `ToolbarSelect mobile` bottom sheets) for `AgentMobileInputArea` and the
 * phone settings summary; without it, today's desktop pills, byte-identical.
 */
export interface AgentModelPillsProps {
  providerProfileId: string | null;
  model?: string;
  onProviderChange: (profileId: string, model?: string) => void;
  /** Phone variant (the `ToolbarSelect` prop's name): bottom-sheet pickers
   *  with the phone trigger chrome. Absent = the desktop pills. */
  mobile?: boolean;
}

/** One model row of the sections below: data only, no nodes — each variant
 *  maps it onto its own primitive (DropdownSelect groups / ToolbarSelect
 *  items with section labels). */
interface AgentModelSectionOption {
  id: string;
  label: string;
  contextLength: number | null;
  favored: boolean;
}

interface AgentModelSection {
  id: string;
  label?: string;
  options: AgentModelSectionOption[];
}

/**
 * The model list's sections, derived in ONE place for both variants (AP-26b):
 * the favorites section with its label, then all models with theirs when
 * favorites exist. Both variants only render the result.
 *
 * `repeatFavoritesInAll` keeps today's difference as a named parameter: the
 * desktop (`true`) lists a favorite again under «All models» with a filled
 * star; the phone (`false`) leaves it out there and gives favorites a
 * leading star instead. Unifying the two stays the owner's call.
 */
export function buildAgentModelSections(
  models: Array<{ id: string; label: string; contextLength?: number | null }>,
  favorites: Array<{ modelId: string; label: string | null; contextLength: number | null }>,
  isFavorite: (modelId: string) => boolean,
  t: TFunc,
  repeatFavoritesInAll: boolean,
): AgentModelSection[] {
  return [
    ...(favorites.length > 0
      ? [{
          id: "copilot-model-favorites",
          label: t("copilot_model_favorites_section"),
          options: favorites.map((f) => ({
            id: f.modelId,
            label: f.label || f.modelId,
            contextLength: f.contextLength,
            favored: true,
          })),
        }]
      : []),
    {
      id: "copilot-model-all",
      label: favorites.length > 0 ? t("copilot_model_all_section") : undefined,
      options: (repeatFavoritesInAll ? models : models.filter((m) => !isFavorite(m.id))).map((m) => ({
        id: m.id,
        label: m.label,
        contextLength: m.contextLength ?? null,
        favored: isFavorite(m.id),
      })),
    },
  ];
}

export function AgentModelPills(props: AgentModelPillsProps) {
  const { providerProfileId, model, onProviderChange, mobile = false } = props;

  const { t } = useT();

  const profiles = useProviderDataStore((s) => s.profiles);
  const { models } = useProviderModels(providerProfileId);
  const { favorites, isFavorite, toggleFavorite } = useCopilotModelFavorites(providerProfileId);

  const activeProfile = profiles.find((p) => p.id === providerProfileId) ?? null;
  // Phone trigger label (the desktop DropdownSelect renders its own label).
  const activeModelLabel = models.find((m) => m.id === model)?.label ?? model ?? "";

  /** Inline star toggle rendered as every model row's trailing action. Clicking
   * it toggles the copilot-scoped favorite and NEVER selects the model
   * (DropdownSelect stops pointer events on trailing nodes; the ToolbarSelect
   * item contract guarantees the same). */
  const favoriteStar = (modelId: string, label: string, contextLength: number | null, favored: boolean) => (
    mobile ? (
      <button
        type="button"
        data-testid={`copilot-model-star-${modelId}`}
        aria-label={favored ? t("copilot_model_unstar") : t("copilot_model_star")}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-t4 active:bg-s2",
          favored && "text-warning-text",
        )}
        onClick={() => toggleFavorite({ id: modelId, label, contextLength })}
      >
        {favored ? <Icons.starFilled className="h-4 w-4" /> : <Icons.star className="h-4 w-4" />}
      </button>
    ) : (
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
    )
  );

  const sections = buildAgentModelSections(models, favorites, isFavorite, t, /* repeatFavoritesInAll */ !mobile);

  if (mobile) {
    return (
      <>
        {/* Provider picker — controlled via props (bottom sheet). */}
        <ToolbarSelect
          mobile
          title={t("agent_provider")}
          items={profiles.map((p) => ({ value: p.id, label: p.name }))}
          value={providerProfileId}
          onSelect={(profileId) => onProviderChange(profileId)}
          itemTestId={(v) => `copilot-provider-option-${v}`}
          trigger={
            <button
              type="button"
              data-testid="copilot-provider-pill"
              className="flex h-9 min-w-0 items-center gap-1.5 rounded-md bg-s3 px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 active:bg-s2"
            >
              <Icons.Plug className="h-3.5 w-3.5 shrink-0 text-t3" />
              <span className="max-w-[110px] min-w-0 truncate">{activeProfile?.name ?? t("agent_provider")}</span>
              <Icons.Caret direction="d" className="h-3 w-3 shrink-0" />
            </button>
          }
        />

        {/* Model picker — searchable bottom sheet with the profile's
         * copilot-scoped favorites pinned as the top section and an inline
         * star toggle on every row. Variant A: only the CURRENT profile's
         * favorites are shown; switching providers swaps the section. */}
        <ToolbarSelect
          mobile
          searchable
          title={t("agent_model")}
          emptyText={t("agent_no_models")}
          value={model ?? null}
          onSelect={(modelId) => {
            if (providerProfileId) onProviderChange(providerProfileId, modelId);
          }}
          itemTestId={(v) => `copilot-model-option-${v}`}
          items={sections.flatMap((section) =>
            section.options.map((o, i) => ({
              value: o.id,
              label: o.label,
              ...(i === 0 && section.label != null ? { sectionLabel: section.label } : {}),
              ...(o.favored ? { leading: <Icons.starFilled className="h-3.5 w-3.5 shrink-0 text-warning-text" /> } : {}),
              trailing: favoriteStar(o.id, o.label, o.contextLength, o.favored),
            })),
          )}
          trigger={
            <button
              type="button"
              data-testid="copilot-model-pill"
              className="flex h-9 min-w-0 items-center gap-1.5 rounded-md bg-s3 px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 active:bg-s2"
            >
              <Icons.Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-t" />
              <span className="max-w-[110px] min-w-0 truncate">{activeModelLabel || t("agent_model")}</span>
              <Icons.Caret direction="d" className="h-3 w-3 shrink-0" />
            </button>
          }
        />
      </>
    );
  }

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
        groups={sections.map((section) => ({
          id: section.id,
          label: section.label,
          options: section.options.map((o) => ({
            id: o.id,
            label: o.label,
            trailing: favoriteStar(o.id, o.label, o.contextLength, o.favored),
          })),
        }))}
      />
    </>
  );
}
