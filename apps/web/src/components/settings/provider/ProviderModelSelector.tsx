/**
 * forks: 2 — tts/TtsModelPicker.tsx lineage, CoauthorModelSelector.tsx.
 */

import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { Toggle } from "../../shared/Toggle.js";
import { isFreeModel } from "../../../lib/provider-model-capabilities.js";
import { ProviderModelList, type ProviderModelListOption } from "./ProviderModelList.js";
import { TextInput } from "../../shared/text-input.js";
import { LocalConnectionStatusChip, type LocalConnectionStatus } from "../../shared/LocalConnectionStatus.js";
import { lblCls } from "../../../lib/field-tokens.js";

interface ToggleAffordance {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface LocalConnectionAffordance {
  endpoint: string;
  status: LocalConnectionStatus;
}

export interface ProviderModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options: ProviderModelListOption[];
  fetching: boolean;
  fetchError: string | null;
  onRefreshOptions?: () => void;
  favoriteModels?: Array<{ modelId: string; label: string | null; contextLength: number | null }>;
  onToggleFavoriteModel?: (model: ProviderModelListOption) => void;
  /** Runs after a catalog option changes the value, not for a custom ID. */
  onOptionSelected?: (model: ProviderModelListOption) => void;
  freeOnly?: ToggleAffordance;
  groupByOwner?: ToggleAffordance;
  localConnection?: LocalConnectionAffordance;
  label?: string;
  placeholder?: string;
  showRefreshButton?: boolean;
  showContextLength?: boolean;
  renderRowBadges?: (model: ProviderModelListOption) => ReactNode;
  renderRowDescription?: (model: ProviderModelListOption) => ReactNode;
  requiresAuthForModels?: boolean;
}

/** Controlled model-selector family source. Family-specific behavior enters through props. */
export function ProviderModelSelector({
  value,
  onChange,
  options,
  fetching,
  fetchError,
  onRefreshOptions,
  favoriteModels = [],
  onToggleFavoriteModel,
  onOptionSelected,
  freeOnly,
  groupByOwner,
  localConnection,
  label,
  placeholder,
  showRefreshButton = true,
  showContextLength = true,
  renderRowBadges,
  renderRowDescription,
  requiresAuthForModels,
}: ProviderModelSelectorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [modelSearch, setModelSearch] = useState("");
  const [modelListOpen, setModelListOpen] = useState(false);
  const selectedModel = options.find((model) => model.id === value);
  // "Free only" narrows the text-searched list further (computed live each render
  // against fetched pricing — never stored as a tag). The selected model is
  // always kept visible even when it isn't free, so the user sees what's picked.
  const textFiltered = modelSearch.trim()
    ? options.filter((model) => model.label.toLowerCase().includes(modelSearch.toLowerCase()) || model.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : options;
  const freeFiltered = freeOnly?.checked ? textFiltered.filter((model) => isFreeModel(model)) : textFiltered;
  const listModels = selectedModel || !value
    ? freeFiltered
    : [{ id: value, label: value, toolSupport: "unknown" as const }, ...freeFiltered];
  const portalContainer = getModalPortal() ?? undefined;

  const formatContext = (contextLength?: number) => {
    if (contextLength == null || !Number.isFinite(contextLength)) return null;
    return contextLength >= 1000
      ? `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}k ctx`
      : `${contextLength} ctx`;
  };
  const selectModel = (model: ProviderModelListOption) => {
    onChange(model.id);
    onOptionSelected?.(model);
    setModelListOpen(false);
    setModelSearch("");
  };
  const useCustomSlug = (slug: string) => {
    onChange(slug);
    setModelListOpen(false);
    setModelSearch("");
  };
  const refreshOptions = () => {
    if (onRefreshOptions) void onRefreshOptions();
  };

  return (
    <div className="my-4">
      <div className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1">{label || t("model_label")}</div>
      {options.length > 0 && (freeOnly || groupByOwner) && (
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {freeOnly && (
            <div className="flex items-center gap-2">
              <Toggle checked={freeOnly.checked} onChange={freeOnly.onChange} className="!mb-0 !inline-flex" />
              <span className="font-ui text-[12px] text-t2">{t("filter_free_only")}</span>
            </div>
          )}
          {groupByOwner && (
            <div className="flex items-center gap-2">
              <Toggle checked={groupByOwner.checked} onChange={groupByOwner.onChange} className="!mb-0 !inline-flex" />
              <span className="font-ui text-[12px] text-t2">{t("filter_group_by_owner")}</span>
            </div>
          )}
        </div>
      )}
      {localConnection && <LocalConnectionStatusChip
        status={localConnection.status}
        endpoint={localConnection.endpoint}
        onRefresh={showRefreshButton && onRefreshOptions ? refreshOptions : undefined}
        refreshing={fetching}
        refreshLabel={t("refresh_models")}
        className="mb-2.5"
      />}
      <div className="flex-1 min-w-0"><label className={lblCls}>{t("selected_model_label")}</label>
        {/* The refresh button rides the DROPDOWN's row (not a sibling of the
            whole field column): the custom-model hint renders below the row,
            so its appearance can no longer drop the button to a different
            height (owner 2026-09-22; same fix in the STT/TTS/image-gen model
            pickers). */}
        <div className="flex items-end gap-3">
        {options.length > 0 ? <div className="relative min-w-0 flex-1"><Popover.Root open={modelListOpen} onOpenChange={setModelListOpen}><Popover.Trigger asChild><button type="button" className="flex w-full items-center justify-between rounded-md border border-border bg-s2 px-3 py-[6px] font-ui text-[13px] text-t1 transition-colors hover:border-accent"><span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">{selectedModel?.label || value || placeholder || t("select_model")}{showContextLength && formatContext(selectedModel?.contextLength) && <span className="ml-2 text-[11px] font-medium text-t2">{formatContext(selectedModel?.contextLength)}</span>}</span><span className="text-t3"><Icons.Caret direction="d" /></span></button></Popover.Trigger><Popover.Portal container={portalContainer}><Popover.Content sideOffset={4} align="start" onCloseAutoFocus={(event) => event.preventDefault()} className="glass-blur z-[600] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]" style={{ width: "var(--radix-popover-trigger-width)", maxHeight: 260 }}><Command shouldFilter={false} loop className="flex flex-col outline-none"><div className="border-b border-border2 bg-s2 p-2"><Command.Input placeholder={t("search_models")} value={modelSearch} onValueChange={setModelSearch} className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent" /></div><ProviderModelList models={listModels} selectedId={value} search={modelSearch} favorites={favoriteModels} onSelect={selectModel} onToggleFavorite={onToggleFavoriteModel} onUseCustomSlug={useCustomSlug} groupByOwner={groupByOwner?.checked} showContextLength={showContextLength} renderRowBadges={renderRowBadges} renderRowDescription={renderRowDescription} /></Command></Popover.Content></Popover.Portal></Popover.Root></div> : <div className="min-w-0 flex-1"><TextInput value={value} onChange={(event) => onChange(event.target.value)} placeholder={t("custom_model_id_placeholder")} /></div>}
        {showRefreshButton && onRefreshOptions && <button type="button" data-testid="provider-models-refresh" onClick={refreshOptions} disabled={fetching} className={cn(
        "shrink-0 items-center gap-2 rounded-md border border-border bg-s2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50",
        // Mobile stays the icon-only 34px shape but must match the closed
        // dropdown's height: 2px borders + 2×6px py + 13px×1.5 line box
        // (Tailwind preflight html line-height) = 33.5px. The row is
        // items-end, so a shorter button would leave the row top edges
        // misaligned (MOBILE_UI_DEFECTS_REPORT step 5).
        isMobile ? "flex w-[34px] min-h-[33.5px] justify-center px-0 py-[6px]" : "flex px-4 py-[6px] font-ui text-[13px] font-medium text-t2"
      )} title={t("refresh_models")}>{fetching ? <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle"><span className="h-1 w-1 rounded-full bg-accent animate-genp" /><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]" /><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]" /></span> : <Icons.Regen />}{!isMobile && <> {t("refresh_models")}</>}</button>}
        </div>
        {options.length > 0 && !selectedModel && value && <div className="mt-2 font-ui text-[12px] font-medium text-accent">{t("custom_model", { name: value })}</div>}
      </div>
      {fetchError && <div className="mt-3"><span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close />{fetchError}</span></div>}
      {!fetchError && requiresAuthForModels && options.length === 0 && !fetching && <div className="mt-3"><span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close />{t("enter_api_key_for_models")}</span></div>}
    </div>
  );
}
