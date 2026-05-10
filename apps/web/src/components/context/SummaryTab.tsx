import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { TokenCounter } from "../shared/TokenCounter.js";

const textareaCls = "w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent resize-none";
const labelCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3";
const selectCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent";

export interface SavedSummary {
  id: string;
  label: string;
  text: string;
  turn: number;
  timestamp: string;
}

export function SummaryTab({
  summaryText,
  onSummaryTextChange,
  msgCount,
  onMsgCountChange,
  maxMsgCount,
  selectedProviderId,
  onProviderChange,
  providers,
  onSummarize,
  isSummarizing,
  savedSummaries,
  activeSummaryId,
  onSelectSummary,
  onDeleteSummary,
  disabled,
  error,
  t = (k) => k,
}: {
  summaryText: string;
  onSummaryTextChange: (v: string) => void;
  msgCount: number;
  onMsgCountChange: (n: number) => void;
  maxMsgCount: number;
  selectedProviderId: string;
  onProviderChange: (id: string) => void;
  providers: { id: string; name: string }[];
  onSummarize: () => void;
  isSummarizing: boolean;
  savedSummaries: SavedSummary[];
  activeSummaryId: string | null;
  onSelectSummary: (id: string) => void;
  onDeleteSummary: (id: string) => void;
  disabled?: boolean;
  error?: string;
  t?: (k: string) => string;
}) {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-[180px] shrink-0 flex-col border-r border-border" style={{padding:'10px 0'}}>
        <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.08em] text-t3" style={{padding:'4px 13px 8px'}}>{t('saved_summaries_label')}</div>
        <div className="flex-1 overflow-y-auto">
          {savedSummaries.length === 0 && (
            <div className="text-center font-ui text-[11px] text-t4" style={{padding:'16px 12px'}}>{t('no_saved_summaries')}</div>
          )}
          {savedSummaries.map(s => (
            <div
              key={s.id}
              className={cn(
                "group flex cursor-pointer items-center gap-1 border-l-2 border-l-transparent transition-colors hover:bg-s2",
                activeSummaryId === s.id && "border-l-accent bg-accent-dim",
              )}
              style={{padding:'7px 2.5px 7px 13px'}}
              onClick={() => onSelectSummary(s.id)}
            >
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
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{padding:20}}>
        <div className="flex min-h-0 flex-1 flex-col">
          <label className={labelCls}>{t('summary_text_label')}</label>
          <textarea
            className={cn(textareaCls, "flex-1 min-h-0")}
            style={{padding:'9px 13px'}}
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
            <input
              type="range"
              min={1}
              max={maxMsgCount}
              value={msgCount}
              disabled={disabled || isSummarizing}
              onChange={e => onMsgCountChange(Number(e.target.value))}
              className="accent-accent h-2 flex-1 cursor-pointer appearance-none rounded-full bg-s3"
            />
            <input
              type="number"
              min={1}
              max={maxMsgCount}
              value={msgCount}
              disabled={disabled || isSummarizing}
              onChange={e => onMsgCountChange(Math.max(1, Math.min(maxMsgCount, Number(e.target.value) || 1)))}
              className="h-[34px] w-[70px] rounded-md border border-border bg-s2 text-center font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none focus:border-accent"
              style={{padding:'0 8px'}}
            />
          </div>
        </div>

        <div className="shrink-0 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 mt-4">
          <div className="min-w-0">
            <label className={labelCls}>{t('summarize_provider_label')}</label>
            <select
              value={selectedProviderId}
              disabled={disabled || isSummarizing}
              onChange={e => onProviderChange(e.target.value)}
              className={selectCls}
              style={{padding:'0 34px 0 13px'}}
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <button
            className="h-[38px] shrink-0 cursor-pointer whitespace-nowrap rounded-md border-0 bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-40"
            style={{padding:'0 14px'}}
            disabled={disabled || isSummarizing || !selectedProviderId}
            onClick={onSummarize}
          >
            {isSummarizing ? t('summarizing_btn') : t('summarize_btn')}
          </button>
        </div>
        {error && (
          <div style={{ marginTop: 12 }}>
            <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 font-ui text-[12px] text-danger" style={{ padding: '4px 10px' }}>
              <Icons.Close />
              {error}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
