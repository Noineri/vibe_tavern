import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { TokenCounter } from "../shared/TokenCounter.js";
import { useT } from "../../i18n/context.js";

const textareaCls = "w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent resize-none";
const labelCls = "block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3 mb-[7px]";
const selectCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent disabled:opacity-60 pl-[13px] pr-[34px]";

export interface SavedSummary {
  id: string;
  label: string;
  text: string;
  turn: number;
  timestamp: string;
  includeInContext?: boolean;
}

export function SummaryTab({
  summaryText,
  onSummaryTextChange,
  msgCount,
  onMsgCountChange,
  maxMsgCount,
  selectedProviderId,
  selectedModel,
  onProviderChange,
  onModelChange,
  providers,
  models,
  isLoadingModels,
  onSummarize,
  isSummarizing,
  savedSummaries,
  activeSummaryId,
  onSelectSummary,
  onDeleteSummary,
  onToggleContext,
  onNewSummary,
  disabled,
  error,
}: {
  summaryText: string;
  onSummaryTextChange: (v: string) => void;
  msgCount: number;
  onMsgCountChange: (n: number) => void;
  maxMsgCount: number;
  selectedProviderId: string;
  selectedModel: string;
  onProviderChange: (id: string) => void;
  onModelChange: (model: string) => void;
  providers: { id: string; name: string; defaultModel?: string }[];
  models: { id: string; label: string; contextLength?: number }[];
  isLoadingModels: boolean;
  onSummarize: () => void;
  isSummarizing: boolean;
  savedSummaries: SavedSummary[];
  activeSummaryId: string | null;
  onSelectSummary: (id: string) => void;
  onDeleteSummary: (id: string) => void;
  onToggleContext?: (id: string) => void;
  onNewSummary: () => void;
  disabled?: boolean;
  error?: string;
}) {
  const { t } = useT();
  const [modelListOpen, setModelListOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const sliderPct = maxMsgCount > 1 ? Math.round(((msgCount - 1) / (maxMsgCount - 1)) * 100) : 0;
  const selectedModelRecord = models.find((model) => model.id === selectedModel);
  const selectedModelLabel = selectedModelRecord?.label || selectedModel;
  const formatContext = (contextLength?: number) => {
    if (contextLength == null || !Number.isFinite(contextLength)) return null;
    if (contextLength >= 1000) return `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}k ctx`;
    return `${contextLength} ctx`;
  };
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(query));
  }, [modelSearch, models]);

  useEffect(() => {
    if (!modelListOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setModelListOpen(false);
        setModelSearch("");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [modelListOpen]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-[210px] shrink-0 flex-col border-r border-border py-2.5">
        <div className="px-[13px] pt-1 pb-2 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.08em] text-t3">{t('saved_summaries_label')}</div>
        <div className="flex-1 overflow-y-auto">
          {savedSummaries.length === 0 && (
            <div className="px-3 py-4 text-center font-ui text-[11px] text-t4">{t('no_saved_summaries')}</div>
          )}
          {savedSummaries.map(s => (
            <div
              key={s.id}
              className={cn(
                "group flex cursor-pointer items-center gap-1 border-l-2 border-l-transparent py-[7px] pr-[2.5px] pl-[13px] transition-colors hover:bg-s2",
                activeSummaryId === s.id && "border-l-accent bg-accent-dim",
              )}
              onClick={() => onSelectSummary(s.id)}
            >
              {/* Context toggle checkbox */}
              {onToggleContext && (
                <button
                  className={cn(
                    "flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded border transition-colors mr-1",
                    s.includeInContext
                      ? "border-accent bg-accent text-white"
                      : "border-border2 bg-transparent hover:border-t3",
                  )}
                  title={t('toggle_context_summary')}
                  onClick={e => { e.stopPropagation(); onToggleContext(s.id); }}
                >
                  {s.includeInContext && <Icons.Check />}
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className={cn("truncate font-ui text-[12px]", activeSummaryId === s.id ? "font-medium text-accent-t" : "text-t2")}>{s.label}</div>
                <div className="truncate font-ui text-[10px] text-t4">{s.timestamp}</div>
              </div>
              <button
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 opacity-0 transition-all hover:bg-danger-dim hover:text-danger group-hover:opacity-100"
                title={t('delete_summary')}
                onClick={e => { e.stopPropagation(); onDeleteSummary(s.id); }}
              >
                <Icons.Close />
              </button>
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t border-border px-3 pt-3">
          <button
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
            disabled={disabled}
            onClick={onNewSummary}
            type="button"
          >
            <Icons.Plus /> {t('new_summary_entry')}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-5">
        <div className="flex min-h-0 flex-1 flex-col">
          <label className={labelCls}>{t('summary_text_label')}</label>
          <textarea
            className={cn(textareaCls, "flex-1 min-h-0 px-[13px] py-[9px]")}
            placeholder={t('summary_placeholder')}
            value={summaryText}
            disabled={disabled}
            onChange={e => onSummaryTextChange(e.target.value)}
          />
          <TokenCounter text={summaryText} />
        </div>

        <div className="shrink-0 mt-4">
          <label className={labelCls}>{t('msg_to_summarize_label')}</label>
          <div className="mb-2 font-ui text-[11px] text-t4">{t('msg_to_summarize_hint')}</div>
          <div className="flex items-center gap-3">
            {/* DYNAMIC: background uses sliderPct computed from state */}
            <input
              type="range"
              min={1}
              max={maxMsgCount}
              value={msgCount}
              disabled={disabled || isSummarizing}
              onChange={e => onMsgCountChange(Number(e.target.value))}
              className="accent-accent h-2 flex-1 cursor-pointer appearance-none rounded-full bg-s3"
              style={{ background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${sliderPct}%, var(--s3) ${sliderPct}%, var(--s3) 100%)` }}
            />
            <input
              type="number"
              min={1}
              max={maxMsgCount}
              value={msgCount}
              disabled={disabled || isSummarizing}
              onChange={e => onMsgCountChange(Math.max(1, Math.min(maxMsgCount, Number(e.target.value) || 1)))}
              className="h-[34px] w-[70px] rounded-md border border-border bg-s2 px-2 text-center font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="relative z-20 shrink-0 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3 mt-4">
          <div className="min-w-0">
            <label className={labelCls}>{t('summarize_provider_label')}</label>
            <select
              value={selectedProviderId}
              disabled={disabled || isSummarizing}
              onChange={e => onProviderChange(e.target.value)}
              className={selectCls}
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="min-w-0" ref={modelDropdownRef}>
            <label className={labelCls}>{t('summarize_model_label')}</label>
            <div className="relative">
              <button
                type="button"
                disabled={disabled || isSummarizing || isLoadingModels || models.length === 0}
                onClick={() => setModelListOpen((v) => !v)}
                className="flex h-[38px] w-full items-center justify-between rounded-md border border-border bg-s2 px-3 py-[7px] font-ui text-[13px] text-t1 transition-colors hover:border-accent disabled:cursor-default disabled:opacity-60"
              >
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                  {isLoadingModels ? t('loading_models') : selectedModelLabel || t('model_placeholder')}
                  {formatContext(selectedModelRecord?.contextLength) && (
                    <span className="ml-2 text-[11px] font-medium text-t2">{formatContext(selectedModelRecord?.contextLength)}</span>
                  )}
                </span>
                <span className="shrink-0 text-t3">
                  <Icons.Caret direction="d" />
                </span>
              </button>
              {modelListOpen && (
                <div className="absolute left-0 right-0 bottom-full z-[1000] mb-1 overflow-hidden rounded-md border border-border shadow-[0_8px_30px_rgba(0,0,0,0.6)]">
                  <div className="border-b border-border2 bg-s2 p-2">
                    <input
                      type="text"
                      placeholder={t('search_models')}
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      autoFocus
                      className="w-full rounded border border-border bg-surface px-2 py-[5px] font-ui text-[12px] text-t1 outline-none focus:border-accent"
                    />
                  </div>
                  <div className="max-h-[200px] overflow-y-auto bg-surface p-1">
                    {filteredModels.map((model) => (
                      <div
                        key={model.id}
                        onClick={() => {
                          onModelChange(model.id);
                          setModelListOpen(false);
                          setModelSearch('');
                        }}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 font-ui text-[12px] transition-colors',
                          model.id === selectedModel
                            ? 'bg-accent-dim font-medium text-accent-t'
                            : 'text-t2 hover:bg-s2 hover:text-t1',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t1">
                              {model.label || model.id}
                            </span>
                            {formatContext(model.contextLength) && (
                              <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 text-[10px] font-medium text-t2">
                                {formatContext(model.contextLength)}
                              </span>
                            )}
                          </div>
                          {model.label && model.label !== model.id && (
                            <div className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-t4">
                              {model.id}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {filteredModels.length === 0 && (
                      <div className="px-2.5 py-1.5 text-center font-ui text-[11px] text-t4">
                        {t('no_models_found')}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <button
            className="h-[38px] shrink-0 cursor-pointer whitespace-nowrap rounded-md border-0 bg-accent px-3.5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-40"
            disabled={disabled || isSummarizing || !selectedProviderId || !selectedModel.trim()}
            onClick={onSummarize}
          >
            {isSummarizing ? t('summarizing_btn') : t('summarize_btn')}
          </button>
        </div>
        {error && (
          <div className="mt-3">
            <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
              <Icons.Close />
              {error}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
