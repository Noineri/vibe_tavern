import { Command } from "cmdk";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import type { ProviderModelOption } from "../../../api/types.js";
import { Icons } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import type { ToolSupport } from "../../../lib/provider-model-capabilities.js";

export type ProviderModelListOption = ProviderModelOption & { toolSupport?: ToolSupport };

interface ProviderModelListProps {
  models: ProviderModelListOption[];
  selectedId: string;
  search: string;
  favorites: Array<{ modelId: string }>;
  onSelect: (model: ProviderModelListOption) => void;
  onToggleFavorite: (model: ProviderModelListOption) => void;
  onUseCustomSlug: (slug: string) => void;
  toolFilter?: ToolSupport;
  showContextLength?: boolean;
  showPricing?: boolean;
  listClassName?: string;
}

export function ProviderModelList({
  models,
  selectedId,
  search,
  favorites,
  onSelect,
  onToggleFavorite,
  onUseCustomSlug,
  toolFilter,
  showContextLength = true,
  showPricing = true,
  listClassName,
}: ProviderModelListProps) {
  const { t } = useT();
  const favoriteIds = new Set(favorites.map((model) => model.modelId));
  const query = search.trim().toLowerCase();
  const visible = models
    .filter((model) => !toolFilter || model.toolSupport === toolFilter)
    .sort((a, b) => {
      const favoriteOrder = Number(favoriteIds.has(b.id)) - Number(favoriteIds.has(a.id));
      return favoriteOrder || a.label.localeCompare(b.label);
    });
  const customSlug = search.trim();
  const hasExactMatch = models.some((model) => model.id === customSlug);

  const formatContext = (contextLength?: number) => {
    if (contextLength == null || !Number.isFinite(contextLength)) return null;
    return contextLength >= 1000
      ? `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}k ctx`
      : `${contextLength} ctx`;
  };
  const formatPrice = (pricing?: { input?: number; output?: number }) => (
    pricing?.input === undefined || pricing.output === undefined ? null : `$${pricing.input}/$${pricing.output} in/out Mtok`
  );

  return (
    <Command.List className={cn("max-h-[200px] overflow-y-auto bg-surface p-1", listClassName)}>
      {visible.map((model) => {
        const favorite = favoriteIds.has(model.id);
        return (
          <Command.Item
            key={model.id}
            value={model.id}
            onSelect={() => onSelect(model)}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 font-ui text-[12px] outline-none transition-colors",
              model.id === selectedId
                ? "bg-accent-dim font-medium text-accent-t"
                : "text-t2 hover:bg-s2 hover:text-t1 data-[selected=true]:bg-s2 data-[selected=true]:text-t1",
            )}
          >
            <CustomTooltip content={favorite ? t("remove_from_favorites") : t("add_to_favorites")}>
              <button
                type="button"
                className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-warning-text", favorite && "text-warning-text")}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleFavorite(model);
                }}
              >
                {favorite ? <Icons.StarFilled /> : <Icons.Star />}
              </button>
            </CustomTooltip>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t1">{model.label || model.id}</span>
                {model.capabilities?.vision && <CustomTooltip content={t("cap_vision")}><span className="shrink-0 text-t3"><Icons.Eye /></span></CustomTooltip>}
                {model.capabilities?.premium && <CustomTooltip content={t("cap_premium")}><span className="shrink-0 text-t3"><Icons.Crown /></span></CustomTooltip>}
                {model.capabilities?.reasoning && <CustomTooltip content={t("cap_reasoning")}><span className="shrink-0 text-t3"><Icons.Brain /></span></CustomTooltip>}
                {model.capabilities?.tools && <CustomTooltip content={t("cap_tools")}><span className="shrink-0 text-t3"><Icons.Wrench /></span></CustomTooltip>}
                {showContextLength && formatContext(model.contextLength) && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 text-[10px] font-medium text-t2">{formatContext(model.contextLength)}</span>}
              </div>
              {((model.label && model.label !== model.id) || (showPricing && formatPrice(model.pricing))) && (
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-t4">
                  {model.label && model.label !== model.id && <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{model.id}</span>}
                  {showPricing && formatPrice(model.pricing) && <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-medium text-t4">{formatPrice(model.pricing)}</span>}
                </div>
              )}
            </div>
          </Command.Item>
        );
      })}
      {customSlug && !hasExactMatch && (
        <Command.Item data-testid="use-custom-model" value={`use-${customSlug}`} onSelect={() => onUseCustomSlug(customSlug)} className="cursor-pointer rounded px-2.5 py-1.5 font-ui text-[12px] text-accent-t data-[selected=true]:bg-s2">
          {t("use_custom_model_id", { id: customSlug })}
        </Command.Item>
      )}
      {visible.length === 0 && !customSlug && <div className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4">{t("no_models_found")}</div>}
    </Command.List>
  );
}
