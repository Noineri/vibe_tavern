import { useState } from "react";
import { cn } from "../../../../lib/cn.js";
import { Icons } from "../../../shared/icons.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { ToolbarSelect } from "../../../shared/ToolbarSelect.js";
import { DropdownSelect } from "../../../shared/DropdownSelect.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useProviderModels } from "../../../../hooks/use-provider-models.js";
import { useCopilotModelFavorites } from "../../../../hooks/use-copilot-model-favorites.js";
import { useT } from "../../../../i18n/context.js";

/**
 * Experience-copilot input area (ER-11c, desktop). Props-driven and CONTROLLED:
 * the shell (ER-11d) owns the provider/model selection and the send/cancel
 * wiring; this component owns only the local draft text state.
 *
 * Fork of `CoauthorInputArea`, stripped of the co-author-only module switch,
 * context token counter, and (RP) chat-pipeline send. The provider/model picker
 * is the controlled counterpart of the co-author favorites pill: the available
 * PROVIDER list is the global `useProviderDataStore.profiles` (the same source
 * the co-author binding reads), and the MODEL list is `useProviderModels`
 * (all of the provider's models — same source as the co-author picker).
 */
export interface ExperienceCopilotInputAreaProps {
  isSending: boolean;
  onSend: (content: string) => void;
  onCancel: () => void;
  providerProfileId: string | null;
  model?: string;
  onProviderChange: (profileId: string, model?: string) => void;
}

export function ExperienceCopilotInputArea(props: ExperienceCopilotInputAreaProps) {
  const { isSending, onSend, onCancel, providerProfileId, model, onProviderChange } = props;

  const [draft, setDraft] = useState("");

  const { t } = useT();

  const profiles = useProviderDataStore((s) => s.profiles);
  const { models } = useProviderModels(providerProfileId);
  const { favorites, isFavorite, toggleFavorite } = useCopilotModelFavorites(providerProfileId);

  const activeProfile = profiles.find((p) => p.id === providerProfileId) ?? null;
  const activeModelLabel = models.find((m) => m.id === model)?.label ?? model ?? "";

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

  const canSend = draft.trim().length > 0 && !isSending;

  const handleSend = () => {
    const content = draft.trim();
    if (!content || isSending) return;
    setDraft("");
    onSend(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="relative z-10 shrink-0 border-t border-border bg-surface px-4 pt-2.5 pb-3.5">
      <div className="relative rounded-lg border border-border bg-input-bg transition-colors duration-150 focus-within:border-border2">
        <AutoTextarea
          className="min-h-[55px] w-full resize-none border-0 bg-transparent px-4 pt-[13px] pb-2 font-body text-[15.5px] leading-tight text-t1 outline-none placeholder:text-t4"
          maxRows={12}
          minRows={3}
          placeholder={t("experience_copilot_input_placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="relative flex items-center gap-2 pt-1.5 pb-[9px] pl-3 pr-3">
          {/* Provider picker — controlled via props. */}
          <ToolbarSelect
            title={t("experience_copilot_provider")}
            triggerTooltip={t("experience_copilot_provider")}
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
                <span className="min-w-0 truncate">{activeProfile?.name ?? t("experience_copilot_provider_select")}</span>
                <Icons.Caret direction="d" className="h-3 w-3 shrink-0 text-t3" />
              </button>
            }
          />

          {/* Model picker — searchable (DropdownSelect/cmdk) with the profile's
           * copilot-scoped favorites pinned as the top section and an inline
           * star toggle on every row. Variant A: only the CURRENT profile's
           * favorites are shown; switching profiles swaps the section. */}
          <DropdownSelect
            value={model ?? ""}
            onChange={(modelId) => {
              if (providerProfileId) onProviderChange(providerProfileId, modelId);
            }}
            side="top"
            searchPlaceholder={t("search_models")}
            placeholder={t("experience_copilot_model_select")}
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

          <div className="ml-auto flex items-center gap-[9px]">
            {isSending ? (
              <CustomTooltip content={t("experience_copilot_cancel")}>
                <button
                  type="button"
                  data-testid="copilot-cancel-btn"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[5px] border border-danger text-danger-text transition-colors duration-150 hover:bg-danger-dim"
                  onClick={onCancel}
                  aria-label={t("experience_copilot_cancel")}
                >
                  <Icons.close />
                </button>
              </CustomTooltip>
            ) : (
              <CustomTooltip content={t("experience_copilot_send")}>
                <button
                  type="button"
                  data-testid="copilot-send-btn"
                  className={cn(
                    "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[5px] bg-accent text-on-accent transition-all duration-150 hover:brightness-110",
                    "disabled:cursor-default disabled:opacity-45 disabled:filter-none",
                  )}
                  disabled={!canSend}
                  onClick={handleSend}
                  aria-label={t("experience_copilot_send")}
                >
                  <Icons.Caret direction="r" />
                </button>
              </CustomTooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
