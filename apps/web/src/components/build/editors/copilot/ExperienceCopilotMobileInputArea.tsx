import { useState } from "react";
import { cn } from "../../../../lib/cn.js";
import { Icons } from "../../../shared/icons.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { ToolbarSelect } from "../../../shared/ToolbarSelect.js";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useProviderModels } from "../../../../hooks/use-provider-models.js";
import { useCopilotModelFavorites } from "../../../../hooks/use-copilot-model-favorites.js";
import { useT } from "../../../../i18n/context.js";
import type { ExperienceCopilotInputAreaProps } from "./ExperienceCopilotInputArea.js";

/**
 * Experience-copilot input area (ER-11c, mobile). Same props + controlled
 * contract as `ExperienceCopilotInputArea`; only the chrome differs (compact
 * two-row surface: provider/model pills, then the textarea + send/cancel).
 *
 * Fork of `CoauthorMobileInputArea`, with the auto-grow textarea moved onto the
 * shared `AutoTextarea` (the co-author mobile hand-rolled `<textarea rows={1}>`
 * + manual height adjustment is exactly the §9 pattern this surface must NOT
 * repeat).
 */
export function ExperienceCopilotMobileInputArea(props: ExperienceCopilotInputAreaProps) {
  const { isSending, onSend, onCancel, providerProfileId, model, onProviderChange } = props;

  const [draft, setDraft] = useState("");

  const { t } = useT();

  const profiles = useProviderDataStore((s) => s.profiles);
  const { models } = useProviderModels(providerProfileId);
  const { favorites, isFavorite, toggleFavorite } = useCopilotModelFavorites(providerProfileId);

  /** Inline star toggle — the mobile sheet's per-row trailing action. Tapping
   * it toggles the copilot-scoped favorite without selecting the row. */
  const favoriteStar = (modelId: string, label: string, contextLength: number | null, favored: boolean) => (
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
  );

  const activeProfile = profiles.find((p) => p.id === providerProfileId) ?? null;
  const activeModelLabel = models.find((m) => m.id === model)?.label ?? model ?? "";

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
    <div className="relative z-10 shrink-0 border-t border-border bg-surface px-1.5 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2">
      <div className="flex flex-col gap-1.5 rounded-xl bg-s2 p-1.5">
        {/* Toolbar row: provider + model pills (mobile → BottomSheet via ToolbarSelect). */}
        <div className="flex flex-wrap items-center gap-2">
          <ToolbarSelect
            mobile
            title={t("experience_copilot_provider")}
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
                <span className="max-w-[110px] min-w-0 truncate">{activeProfile?.name ?? t("experience_copilot_provider")}</span>
                <Icons.Caret direction="d" className="h-3 w-3 shrink-0" />
              </button>
            }
          />

          <ToolbarSelect
            mobile
            searchable
            title={t("experience_copilot_model")}
            emptyText={t("experience_copilot_no_models")}
            value={model ?? null}
            onSelect={(modelId) => {
              if (providerProfileId) onProviderChange(providerProfileId, modelId);
            }}
            itemTestId={(v) => `copilot-model-option-${v}`}
            items={[
              ...favorites.map((f, i) => ({
                value: f.modelId,
                label: f.label || f.modelId,
                ...(i === 0 ? { sectionLabel: t("copilot_model_favorites_section") } : {}),
                leading: <Icons.starFilled className="h-3.5 w-3.5 shrink-0 text-warning-text" />,
                trailing: favoriteStar(f.modelId, f.label || f.modelId, f.contextLength, true),
              })),
              ...models
                .filter((m) => !isFavorite(m.id))
                .map((m, i) => ({
                  value: m.id,
                  label: m.label,
                  ...(favorites.length > 0 && i === 0 ? { sectionLabel: t("copilot_model_all_section") } : {}),
                  trailing: favoriteStar(m.id, m.label, m.contextLength ?? null, false),
                })),
            ]}
            trigger={
              <button
                type="button"
                data-testid="copilot-model-pill"
                className="flex h-9 min-w-0 items-center gap-1.5 rounded-md bg-s3 px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 active:bg-s2"
              >
                <Icons.Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-t" />
                <span className="max-w-[110px] min-w-0 truncate">{activeModelLabel || t("experience_copilot_model")}</span>
                <Icons.Caret direction="d" className="h-3 w-3 shrink-0" />
              </button>
            }
          />
        </div>

        {/* Input row. */}
        <div className="flex items-end gap-2">
          <AutoTextarea
            className="max-h-[40vh] min-h-[44px] flex-1 resize-none border-0 bg-transparent py-2 pr-1 font-body text-[15px] leading-[1.4] text-t1 outline-none placeholder:text-t4"
            minRows={1}
            maxRows={6}
            placeholder={t("experience_copilot_input_placeholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="flex shrink-0 items-center">
            {isSending ? (
              <button
                type="button"
                data-testid="copilot-cancel-btn"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger text-danger-text active:bg-danger/10"
                onClick={onCancel}
              >
                <span className="text-[11px] font-bold">✕</span>
              </button>
            ) : (
              <button
                type="button"
                data-testid="copilot-send-btn"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent active:scale-95",
                  "disabled:opacity-45",
                )}
                disabled={!canSend}
                onClick={handleSend}
              >
                <Icons.Caret direction="r" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
