import React from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../../i18n/context.js';
import { useIsMobile } from '../../../hooks/use-mobile.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { Icons } from '../../shared/icons.js';
import { cn } from '../../../lib/cn.js';
import { CustomTooltip } from '../../shared/Tooltip.js';

const labelCls =
  'block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3';
const inputCls =
  'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent px-[13px]';

interface ModelOption {
  id: string;
  label: string;
  contextLength?: number;
  capabilities?: { vision?: boolean; reasoning?: boolean; tools?: boolean; webSearch?: boolean; premium?: boolean };
  pricing?: { input?: number; output?: number };
  description?: string;
}
interface FavoriteModelOption { modelId: string; label: string | null; contextLength: number | null; }

type LocalConnectionStatus = "unknown" | "checking" | "online" | "offline";

interface ProviderModelSelectorProps {
  form: FormState;
  models: ModelOption[];
  filteredModels: ModelOption[];
  fetching: boolean;
  fetchError: string | null;
  modelSearch: string;
  modelListOpen: boolean;
  favoriteModels: FavoriteModelOption[];
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  onFetchModels: () => void;
  setModelSearch: (v: string) => void;
  setModelListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  onToggleFavoriteModel: (model: ModelOption) => void;
  requiresAuthForModels?: boolean;
  isLocalProvider?: boolean;
  localEndpoint?: string;
  localConnectionStatus?: LocalConnectionStatus;
}

export function ProviderModelSelector({
  form,
  models,
  filteredModels,
  fetching,
  fetchError,
  modelSearch,
  modelListOpen,
  favoriteModels,
  updateForm,
  onFetchModels,
  setModelSearch,
  setModelListOpen,
  dropdownRef,
  onToggleFavoriteModel,
  requiresAuthForModels,
  isLocalProvider = false,
  localEndpoint = "",
  localConnectionStatus = "unknown",
}: ProviderModelSelectorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const favoriteIds = new Set(favoriteModels.map((model) => model.modelId));
  const selectedModel = models.find((model) => model.id === form.model);
  const formatContext = (contextLength?: number) => {
    if (contextLength == null || !Number.isFinite(contextLength)) return null;
    if (contextLength >= 1000) return `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}k ctx`;
    return `${contextLength} ctx`;
  };
  const formatPrice = (pricing?: { input?: number; output?: number }) => {
    if (!pricing || pricing.input === undefined || pricing.output === undefined) return null;
    return `$${pricing.input}/$${pricing.output} in/out Mtok`;
  };
  const statusMeta: Record<LocalConnectionStatus, { label: string; className: string; dotClassName: string }> = {
    unknown: { label: t("local_connection_unknown"), className: "border-border2 bg-s2 text-t3", dotClassName: "bg-t4" },
    checking: { label: t("local_connection_checking"), className: "border-accent/30 bg-accent/10 text-accent-t", dotClassName: "bg-accent animate-pulse" },
    online: { label: t("local_connection_online"), className: "border-success/30 bg-success/10 text-success", dotClassName: "bg-success" },
    offline: { label: t("local_connection_offline"), className: "border-danger/30 bg-danger/10 text-danger", dotClassName: "bg-danger" },
  };
  const localStatus = statusMeta[localConnectionStatus];

  const sortedModels = [...filteredModels].sort((a, b) => {
    const aFav = favoriteIds.has(a.id);
    const bFav = favoriteIds.has(b.id);
    if (aFav !== bFav) return aFav ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return (
    <div className="my-4">
      <div
        className="mb-3 border-b border-border2 pb-2 font-ui text-[14px] font-semibold text-t1"
      >
        {t("model_label")}
      </div>
      {isLocalProvider && (
        <div className={cn("mb-2.5 flex flex-col gap-1.5 rounded-md border px-3 py-2 font-ui text-[12px] sm:flex-row sm:items-center sm:justify-between", localStatus.className)}>
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", localStatus.dotClassName)} />
            <span className="shrink-0 font-medium">{localStatus.label}</span>
            {localEndpoint && (
              <span className="min-w-0 truncate text-t3">
                {t("local_connection_endpoint").replace("{url}", localEndpoint)}
              </span>
            )}
          </span>
          <button type="button" onClick={() => void onFetchModels()} disabled={fetching} className="self-start rounded border border-current/20 px-2 py-0.5 font-ui text-[11px] font-medium opacity-80 transition-opacity hover:opacity-100 disabled:opacity-50 sm:self-auto">
            {fetching ? t("testing") : t("refresh_models")}
          </button>
        </div>
      )}
      <div className="flex items-end gap-3">
        <div className="flex-1" ref={dropdownRef}>
          <label className={labelCls + " mb-[6px]"}>{t("selected_model_label")}</label>
          {models.length > 0 ? (
            <div className="relative">
              <button type="button"
                onClick={() => setModelListOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-md border border-border bg-s2 px-3 py-[6px] font-ui text-[13px] text-t1 transition-colors hover:border-accent"
              >
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                  {selectedModel?.label || form.model || t("select_model")}
                  {formatContext(selectedModel?.contextLength) && (
                    <span className="ml-2 text-[11px] font-medium text-t2">{formatContext(selectedModel?.contextLength)}</span>
                  )}
                </span>
                <span className="text-t3">
                  <Icons.Caret direction="d" />
                </span>
              </button>
              {modelListOpen && (() => {
                const rect = dropdownRef.current?.getBoundingClientRect();
                const portal = document.getElementById('modal-portal');
                const content = (
                  <div
                    className="fixed z-[600] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
                    style={{
                      top: rect ? rect.bottom + 4 : 0,
                      left: rect ? rect.left : 0,
                      width: rect ? rect.width : 300,
                    }}
                  >
                  <div
                    className="border-b border-border2 bg-s2 p-2"
                  >
                    <input
                      type="text"
                      placeholder={t("search_models")}
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      autoFocus
                      className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent"
                    />
                  </div>
                  <div
                    className="max-h-[200px] overflow-y-auto bg-surface p-1"
                  >
                    {sortedModels.map((m) => {
                      const isFavorite = favoriteIds.has(m.id);
                      return (
                        <div
                          key={m.id}
                          onClick={() => {
                            console.log('[MODEL-SELECT]', { modelId: m.id, contextLength: m.contextLength, pinContextBudget: form.pinContextBudget, willSet: m.contextLength ?? 16000 });
                            updateForm('model', m.id);
                            if (!form.pinContextBudget) {
                              if (m.contextLength != null && m.contextLength > 0) {
                                updateForm('contextBudget', m.contextLength);
                              } else {
                                updateForm('contextBudget', 16000);
                              }
                            }
                            setModelListOpen(false);
                            setModelSearch('');
                          }}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 font-ui text-[12px] transition-colors',
                            m.id === form.model
                              ? 'bg-accent-dim font-medium text-accent-t'
                              : 'text-t2 hover:bg-s2 hover:text-t1'
                          )}
                        >
                          <CustomTooltip content={isFavorite ? t("remove_from_favorites") : t("add_to_favorites")}>
                          <button type="button"
                            className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-warning-text', isFavorite && 'text-warning-text')}
                            onClick={(event) => {
                              event.stopPropagation();
                              onToggleFavoriteModel(m);
                            }}
                          >
                            {isFavorite ? <Icons.StarFilled /> : <Icons.Star />}
                          </button>
                          </CustomTooltip>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t1">
                                {m.label || m.id}
                              </span>
                              {m.capabilities?.vision && (
                                <CustomTooltip content={t('cap_vision')}>
                                <span className="shrink-0 text-t3">
                                  <Icons.Eye />
                                </span>
                                </CustomTooltip>
                              )}
                              {m.capabilities?.premium && (
                                <CustomTooltip content={t('cap_premium')}>
                                <span className="shrink-0 text-t3">
                                  <Icons.Crown />
                                </span>
                                </CustomTooltip>
                              )}
                              {m.capabilities?.reasoning && (
                                <CustomTooltip content={t('cap_reasoning')}>
                                <span className="shrink-0 text-t3">
                                  <Icons.Brain />
                                </span>
                                </CustomTooltip>
                              )}
                              {m.capabilities?.tools && (
                                <CustomTooltip content={t('cap_tools')}>
                                <span className="shrink-0 text-t3">
                                  <Icons.Wrench />
                                </span>
                                </CustomTooltip>
                              )}
                              {formatContext(m.contextLength) && (
                                <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 text-[10px] font-medium text-t2">
                                  {formatContext(m.contextLength)}
                                </span>
                              )}
                            </div>
                            {((m.label && m.label !== m.id) || formatPrice(m.pricing)) && (
                              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-t4">
                                {m.label && m.label !== m.id && (
                                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                                    {m.id}
                                  </span>
                                )}
                                {formatPrice(m.pricing) && (
                                  <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-medium text-t4">
                                    {formatPrice(m.pricing)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {sortedModels.length === 0 && (
                      <div
                        className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4"
                      >
                        {t("no_models_found")}
                      </div>
                    )}
                  </div>
                  </div>
                );
                if (portal && rect) return createPortal(content, portal);
                return content;
              })()}
              {!models.find((m) => m.id === form.model) && form.model && (
                <div className="mt-2 font-ui text-[12px] font-medium text-accent">
                  {t("custom_model").replace("{name}", form.model)}
                </div>
              )}
            </div>
          ) : (
            <input
              type="text"
              value={form.model}
              onChange={(e) => updateForm('model', e.target.value)}
              placeholder={t("custom_model_id_placeholder")}
              className={inputCls}
            />
          )}
        </div>
        <button type="button"
          onClick={() => void onFetchModels()}
          disabled={fetching}
          className={cn(
            "shrink-0 items-center gap-2 rounded-md border border-border bg-s2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50",
            isMobile ? "flex w-[34px] justify-center px-0 py-[6px]" : "flex px-4 py-[6px] font-ui text-[13px] font-medium text-t2"
          )}
          title={t("refresh_models")}
        >
          {fetching ? (
            <span className="inline-flex items-center gap-[3px] ml-[3px] align-middle">
              <span className="h-1 w-1 rounded-full bg-accent animate-genp" />
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.18s]" />
              <span className="h-1 w-1 rounded-full bg-accent animate-genp [animation-delay:0.36s]" />
            </span>
          ) : (
            <Icons.Regen />
          )}
          {!isMobile && <> {t("refresh_models")}</>}
        </button>
      </div>
      {fetchError && (
        <div className="mt-3">
          <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
            <Icons.Close />
            {fetchError}
          </span>
        </div>
      )}
      {!fetchError && requiresAuthForModels && models.length === 0 && !fetching && (
        <div className="mt-3">
          <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
            <Icons.Close />
            {t("enter_api_key_for_models")}
          </span>
        </div>
      )}
    </div>
  );
}
