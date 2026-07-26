import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import type { FormState } from "../../modals/ProviderModal.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { Toggle } from "../../shared/Toggle.js";
import { isFreeModel } from "../../../lib/provider-model-capabilities.js";
import { ProviderModelList, type ProviderModelListOption } from "./ProviderModelList.js";

const labelCls = "block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3";
const inputCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent px-[13px]";

type LocalConnectionStatus = "unknown" | "checking" | "online" | "offline";

interface ProviderModelSelectorProps {
  form: FormState;
  models: ProviderModelListOption[];
  filteredModels: ProviderModelListOption[];
  fetching: boolean;
  fetchError: string | null;
  modelSearch: string;
  modelListOpen: boolean;
  favoriteModels: Array<{ modelId: string; label: string | null; contextLength: number | null }>;
  updateForm: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onFetchModels: () => void;
  setModelSearch: (value: string) => void;
  setModelListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onToggleFavoriteModel: (model: ProviderModelListOption) => void;
  requiresAuthForModels?: boolean;
  isLocalProvider?: boolean;
  localEndpoint?: string;
  localConnectionStatus?: LocalConnectionStatus;
  modelKey?: keyof FormState;
  labelOverride?: string;
  placeholderOverride?: string;
  showRefreshButton?: boolean;
  showContextLength?: boolean;
  syncContextBudget?: boolean;
}

/** FormState/Popover adapter around the shared, controlled ProviderModelList. */
export function ProviderModelSelector({
  form, models, filteredModels, fetching, fetchError, modelSearch, modelListOpen,
  favoriteModels, updateForm, onFetchModels, setModelSearch, setModelListOpen,
  onToggleFavoriteModel, requiresAuthForModels, isLocalProvider = false, localEndpoint = "",
  localConnectionStatus = "unknown", modelKey = "model" as keyof FormState,
  labelOverride, placeholderOverride, showRefreshButton = true, showContextLength = true,
  syncContextBudget = true,
}: ProviderModelSelectorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const currentValue = (form[modelKey] as string) || "";
  const selectedModel = models.find((model) => model.id === currentValue);
  // "Free only" narrows the text-searched list further (computed live each render
  // against fetched pricing — never stored as a tag). The selected model is
  // always kept visible even when it isn't free, so the user sees what's picked.
  const freeFiltered = form.modelFreeOnly ? filteredModels.filter((m) => isFreeModel(m)) : filteredModels;
  const listModels = selectedModel || !currentValue
    ? freeFiltered
    : [{ id: currentValue, label: currentValue, toolSupport: "unknown" as const }, ...freeFiltered];
  const portalContainer = getModalPortal() ?? undefined;
  const localStatus = {
    unknown: { label: t("local_connection_unknown"), className: "border-border2 bg-s2 text-t3", dotClassName: "bg-t4" },
    checking: { label: t("local_connection_checking"), className: "border-accent/30 bg-accent/10 text-accent-t", dotClassName: "bg-accent animate-pulse" },
    online: { label: t("local_connection_online"), className: "border-success/30 bg-success/10 text-success", dotClassName: "bg-success" },
    offline: { label: t("local_connection_offline"), className: "border-danger/30 bg-danger/10 text-danger", dotClassName: "bg-danger" },
  }[localConnectionStatus];

  const formatContext = (contextLength?: number) => {
    if (contextLength == null || !Number.isFinite(contextLength)) return null;
    return contextLength >= 1000
      ? `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}k ctx`
      : `${contextLength} ctx`;
  };
  const selectModel = (model: ProviderModelListOption) => {
    updateForm(modelKey, model.id as FormState[typeof modelKey]);
    if (syncContextBudget && modelKey === "model" && !form.pinContextBudget) {
      updateForm("contextBudget", (model.contextLength != null && model.contextLength > 0 ? model.contextLength : 16_000) as FormState["contextBudget"]);
    }
    setModelListOpen(false);
    setModelSearch("");
  };
  const useCustomSlug = (slug: string) => {
    updateForm(modelKey, slug as FormState[typeof modelKey]);
    setModelListOpen(false);
    setModelSearch("");
  };

  return (
    <div className="my-4">
      <div className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1">{labelOverride || t("model_label")}</div>
      {models.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <div className="flex items-center gap-2">
            <Toggle checked={form.modelFreeOnly} onChange={(v) => updateForm("modelFreeOnly", v)} className="!mb-0 !inline-flex" />
            <span className="font-ui text-[12px] text-t2">{t("filter_free_only")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Toggle checked={form.modelGroupByOwner} onChange={(v) => updateForm("modelGroupByOwner", v)} className="!mb-0 !inline-flex" />
            <span className="font-ui text-[12px] text-t2">{t("filter_group_by_owner")}</span>
          </div>
        </div>
      )}
      {isLocalProvider && <div className={cn("mb-2.5 flex flex-col gap-1.5 rounded-md border px-3 py-2 font-ui text-[12px] sm:flex-row sm:items-center sm:justify-between", localStatus.className)}>
        <span className="inline-flex min-w-0 items-center gap-2"><span className={cn("h-2 w-2 shrink-0 rounded-full", localStatus.dotClassName)} /><span className="shrink-0 font-medium">{localStatus.label}</span>{localEndpoint && <span className="min-w-0 truncate text-t3">{t("local_connection_endpoint", { url: localEndpoint })}</span>}</span>
        {showRefreshButton && <button type="button" onClick={() => void onFetchModels()} disabled={fetching} className="self-start rounded border border-current/20 px-2 py-0.5 font-ui text-[11px] font-medium opacity-80 transition-opacity hover:opacity-100 disabled:opacity-50 sm:self-auto">{fetching ? t("testing") : t("refresh_models")}</button>}
      </div>}
      <div className="flex items-end gap-3"><div className="flex-1"><label className={`${labelCls} mb-[6px]`}>{t("selected_model_label")}</label>
        {models.length > 0 ? <div className="relative"><Popover.Root open={modelListOpen} onOpenChange={setModelListOpen}><Popover.Trigger asChild><button type="button" className="flex w-full items-center justify-between rounded-md border border-border bg-s2 px-3 py-[6px] font-ui text-[13px] text-t1 transition-colors hover:border-accent"><span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">{selectedModel?.label || currentValue || placeholderOverride || t("select_model")}{showContextLength && formatContext(selectedModel?.contextLength) && <span className="ml-2 text-[11px] font-medium text-t2">{formatContext(selectedModel?.contextLength)}</span>}</span><span className="text-t3"><Icons.Caret direction="d" /></span></button></Popover.Trigger><Popover.Portal container={portalContainer}><Popover.Content sideOffset={4} align="start" onCloseAutoFocus={(event) => event.preventDefault()} className="glass-blur z-[600] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]" style={{ width: "var(--radix-popover-trigger-width)", maxHeight: 260 }}><Command shouldFilter={false} loop className="flex flex-col outline-none"><div className="border-b border-border2 bg-s2 p-2"><Command.Input placeholder={t("search_models")} value={modelSearch} onValueChange={setModelSearch} className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent" /></div><ProviderModelList models={listModels} selectedId={currentValue} search={modelSearch} favorites={favoriteModels} onSelect={selectModel} onToggleFavorite={onToggleFavoriteModel} onUseCustomSlug={useCustomSlug} groupByOwner={form.modelGroupByOwner} showContextLength={showContextLength} /></Command></Popover.Content></Popover.Portal></Popover.Root>{!selectedModel && currentValue && <div className="mt-2 font-ui text-[12px] font-medium text-accent">{t("custom_model", { name: currentValue })}</div>}</div> : <input type="text" value={currentValue} onChange={(event) => updateForm(modelKey, event.target.value as FormState[typeof modelKey])} placeholder={t("custom_model_id_placeholder")} className={inputCls} />}
      </div>{showRefreshButton && <button type="button" onClick={() => void onFetchModels()} disabled={fetching} className={cn("shrink-0 items-center gap-2 rounded-md border border-border bg-s2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50", isMobile ? "flex w-[34px] justify-center px-0 py-[6px]" : "flex px-4 py-[6px] font-ui text-[13px] font-medium text-t2")} title={t("refresh_models")}>{fetching ? <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle"><span className="h-1 w-1 rounded-full bg-accent animate-genp" /><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]" /><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]" /></span> : <Icons.Regen />}{!isMobile && <> {t("refresh_models")}</>}</button>}</div>
      {fetchError && <div className="mt-3"><span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close />{fetchError}</span></div>}
      {!fetchError && requiresAuthForModels && models.length === 0 && !fetching && <div className="mt-3"><span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close />{t("enter_api_key_for_models")}</span></div>}
    </div>
  );
}
