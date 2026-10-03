/**
 * fork #2 of ProviderModelSelector.tsx.
 *
 * Correspondence: section/title, selected-model label, dropdown/popover,
 * custom-ID fallback, refresh row, model-list and Co-Author favorites match
 * the RP selector. The RP-only display-preference toggles are omitted because
 * they have no Co-Author settings storage field.
 */

import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { COAUTHOR_UNKNOWN_CONTEXT_BUDGET } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { resolveModelContextBudget } from "../../../lib/context-autofill.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { ProviderModelList, type ProviderModelListOption } from "./ProviderModelList.js";
import { TextInput } from "../../shared/text-input.js";
import { lblCls } from "../../../lib/field-tokens.js";

export interface CoauthorModelSelectorValues {
  model: string;
  contextBudget: number;
  pinContextBudget: boolean;
}

interface CoauthorModelSelectorProps {
  values: CoauthorModelSelectorValues;
  models: ProviderModelListOption[];
  fetching: boolean;
  fetchError: string | null;
  modelSearch: string;
  modelListOpen: boolean;
  favoriteModels: Array<{ modelId: string; label: string | null; contextLength: number | null }>;
  onChange: (key: "model" | "contextBudget", value: string | number) => void;
  onFetchModels: () => void;
  setModelSearch: (value: string) => void;
  setModelListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onToggleFavoriteModel: (model: ProviderModelListOption) => void;
}

/** Co-Author-owned model selection and context auto-fill. */
export function CoauthorModelSelector({
  values, models, fetching, fetchError, modelSearch, modelListOpen, favoriteModels,
  onChange, onFetchModels, setModelSearch, setModelListOpen, onToggleFavoriteModel,
}: CoauthorModelSelectorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const selectedModel = models.find((model) => model.id === values.model);
  const listModels = selectedModel || !values.model
    ? models
    : [{ id: values.model, label: values.model, toolSupport: "unknown" as const }, ...models];
  const portalContainer = getModalPortal() ?? undefined;

  const formatContext = (contextLength?: number) => {
    if (contextLength == null || !Number.isFinite(contextLength)) return null;
    return contextLength >= 1000
      ? `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}k ctx`
      : `${contextLength} ctx`;
  };
  const selectModel = (model: ProviderModelListOption) => {
    onChange("model", model.id);
    const contextBudget = resolveModelContextBudget({
      pinned: values.pinContextBudget,
      contextLength: model.contextLength,
      currentBudget: values.contextBudget,
      unknownContextBudget: COAUTHOR_UNKNOWN_CONTEXT_BUDGET,
    });
    if (contextBudget !== undefined) onChange("contextBudget", contextBudget);
    setModelListOpen(false);
    setModelSearch("");
  };
  const useCustomSlug = (slug: string) => {
    onChange("model", slug);
    const contextBudget = resolveModelContextBudget({
      pinned: values.pinContextBudget,
      contextLength: undefined,
      currentBudget: values.contextBudget,
      unknownContextBudget: COAUTHOR_UNKNOWN_CONTEXT_BUDGET,
    });
    if (contextBudget !== undefined) onChange("contextBudget", contextBudget);
    setModelListOpen(false);
    setModelSearch("");
  };

  return <div className="my-4">
    <div className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1">{t("coauthor.provider.model_label")}</div>
    <div className="flex-1 min-w-0"><label className={lblCls}>{t("selected_model_label")}</label>
      <div className="flex items-end gap-3">
        {models.length > 0 ? <div className="relative min-w-0 flex-1"><Popover.Root open={modelListOpen} onOpenChange={setModelListOpen}><Popover.Trigger asChild><button type="button" className="flex w-full items-center justify-between rounded-md border border-border bg-s2 px-3 py-[6px] font-ui text-[13px] text-t1 transition-colors hover:border-accent"><span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">{selectedModel?.label || values.model || t("select_model")}{formatContext(selectedModel?.contextLength) && <span className="ml-2 text-[11px] font-medium text-t2">{formatContext(selectedModel?.contextLength)}</span>}</span><span className="text-t3"><Icons.Caret direction="d" /></span></button></Popover.Trigger><Popover.Portal container={portalContainer}><Popover.Content sideOffset={4} align="start" onCloseAutoFocus={(event) => event.preventDefault()} className="glass-blur z-[600] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]" style={{ width: "var(--radix-popover-trigger-width)", maxHeight: 260 }}><Command shouldFilter={false} loop className="flex flex-col outline-none"><div className="border-b border-border2 bg-s2 p-2"><Command.Input placeholder={t("search_models")} value={modelSearch} onValueChange={setModelSearch} className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent" /></div><ProviderModelList models={listModels} selectedId={values.model} search={modelSearch} favorites={favoriteModels} onSelect={selectModel} onToggleFavorite={onToggleFavoriteModel} onUseCustomSlug={useCustomSlug} /></Command></Popover.Content></Popover.Portal></Popover.Root></div> : <div className="min-w-0 flex-1"><TextInput value={values.model} onChange={(event) => onChange("model", event.target.value)} placeholder={t("custom_model_id_placeholder")} /></div>}
        <button type="button" data-testid="coauthor-models-refresh" onClick={() => void onFetchModels()} disabled={fetching} className={cn("shrink-0 items-center gap-2 rounded-md border border-border bg-s2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50", isMobile ? "flex w-[34px] min-h-[33.5px] justify-center px-0 py-[6px]" : "flex px-4 py-[6px] font-ui text-[13px] font-medium text-t2")} title={t("refresh_models")}>{fetching ? <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle"><span className="h-1 w-1 rounded-full bg-accent animate-genp" /><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]" /><span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]" /></span> : <Icons.Regen />}{!isMobile && <> {t("refresh_models")}</>}</button>
      </div>
      {models.length > 0 && !selectedModel && values.model && <div className="mt-2 font-ui text-[12px] font-medium text-accent">{t("custom_model", { name: values.model })}</div>}
    </div>
    {fetchError && <div className="mt-3"><span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger"><Icons.Close />{fetchError}</span></div>}
  </div>;
}
