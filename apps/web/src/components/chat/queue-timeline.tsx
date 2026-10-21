import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { brandId, type MessageId } from "@vibe-tavern/domain";
import { selectVariantAction } from "../../stores/api-actions/chat-actions.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useGenerationQueueStore } from "../../stores/generation-queue-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { enqueueGenerateMore, cancelQueueJob, clearQueuePending } from "../../hooks/use-generation-queue.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { AnimatedDisclosure } from "../shared/AnimatedDisclosure.js";
import { Icons } from "../shared/icons.js";
import { useQueueRows, type FinishedQueueRow, type QueueRow } from "./queue-rows.js";
import { VariantStarButton } from "./variants/variant-jump.js";

type QueueTimelineProps = { onClose: () => void };
const EMPTY_JOBS: readonly never[] = [];
const EMPTY_PRESETS: readonly never[] = [];

/** Desktop timeline B for the durable generation batch, deliberately separate from the QS-7 mobile sheet. */
export function QueueTimeline({ onClose }: QueueTimelineProps): ReactNode {
  const { t } = useT();
  const activeChatId = useChatStore((state) => state.activeChatId);
  const batch = useGenerationQueueStore((state) => activeChatId ? state.batchesByChat[activeChatId] ?? null : null);
  const jobs = useGenerationQueueStore((state) => activeChatId ? state.jobsByChat[activeChatId] ?? EMPTY_JOBS : EMPTY_JOBS);
  const message = useSnapshotStore((state) => batch ? state.messagesById[batch.messageId] ?? null : null);
  const rowsResult = useQueueRows({
    chatId: activeChatId,
    variants: message?.variants ?? [],
    selectedVariantIndex: message?.selectedVariantIndex ?? 0,
  });
  const [foldOpen, setFoldOpen] = useState(false);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const runningRef = useRef<HTMLDivElement>(null);
  const runningRow = rowsResult.rows.find((row) => row.kind === "running");
  const runningId = runningRow && "record" in runningRow ? runningRow.record.id : null;

  useEffect(() => {
    if (runningId) runningRef.current?.scrollIntoView({ block: "nearest" });
  }, [runningId]);

  const renderedRows = useMemo(() => {
    const result: Array<QueueRow | { kind: "fold"; rows: FinishedQueueRow[] }> = [];
    if (rowsResult.folded) result.push({ kind: "fold", rows: rowsResult.folded });
    result.push(...rowsResult.rows);
    return result;
  }, [rowsResult.folded, rowsResult.rows]);
  const lastFinished = renderedRows.findLastIndex((row) => row.kind === "finished" || (row.kind === "fold" && (foldOpen || row.rows.length > 0)));
  const accentHeight = lastFinished < 0 ? 0 : ((lastFinished + 1) / Math.max(renderedRows.length, 1)) * 100;
  const hasPending = rowsResult.rows.some((row) => row.kind === "pending");
  const model = useProviderDataStore.getState().profiles.find((profile) => profile.isActive)?.defaultModel
    ?? useProviderStore.getState().connection.model
    ?? null;
  const presetId = useSnapshotStore((state) => state.activeChat?.promptPresetId ?? null);
  const presets = useBootstrapStore((state) => state.data?.promptPresets ?? EMPTY_PRESETS);
  const presetName = presetId ? presets.find((preset) => preset.id === presetId)?.name ?? t("topbar_default") : t("topbar_default");
  const footerMetadata = model ? `${model} · ${presetName}` : presetName;

  if (!batch || !message || !activeChatId) return null;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="shrink-0 whitespace-nowrap font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{t("queue_timeline_title")}</span>
        <span className="shrink-0 whitespace-nowrap text-[calc(var(--ui-fs)-3px)] text-t3">{t("queue_chip_progress", { done: rowsResult.summary.done, total: rowsResult.summary.total })}</span>
        {hasPending && <button type="button" onClick={() => { clearQueuePending(); onClose(); }} className="ml-auto shrink-0 whitespace-nowrap rounded px-2 py-1 text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-danger-text">{t("queue_timeline_clear")}</button>}
      </div>
      <div className="relative max-h-64 overflow-y-auto py-1" data-queue-timeline>
        <div className="absolute bottom-4 left-[19px] top-4 w-0.5 bg-border" aria-hidden="true"><i className="block w-full bg-accent" style={{ height: `${accentHeight}%` }} /></div>
        {renderedRows.map((row) => row.kind === "fold" ? (
          <FoldRow key="fold" rows={row.rows} messageId={batch.messageId} open={foldOpen} onToggle={() => setFoldOpen((open) => !open)} onSelect={selectVariant} />
        ) : row.kind === "finished" ? (
          <FinishedRow key={row.item.variantId} row={row} messageId={batch.messageId} onClose={onClose} onSelect={selectVariant} />
        ) : (
          <RecordRow key={row.record.id} row={row} ref={row.record.id === runningId ? runningRef : undefined} expanded={expandedError === row.record.id} onToggleError={() => setExpandedError((value) => value === row.record.id ? null : row.record.id)} jobId={jobs.find((job) => job.recordId === row.record.id)?.id} />
        ))}
      </div>
      <button type="button" onClick={() => { if (model) enqueueGenerateMore(batch.messageId, model, presetId); }} className="flex w-full min-w-0 items-center gap-1.5 border-t border-border px-3 py-[9px] text-left font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-colors hover:bg-s2">
        <Icons.Plus /><span className="shrink-0 whitespace-nowrap">{t("queue_timeline_one_more")}</span><span className="min-w-0 truncate" title={footerMetadata}>{footerMetadata}</span>
      </button>
    </>
  );

  function selectVariant(row: FinishedQueueRow): void {
    if (!message || !batch || !activeChatId) return;
    const actual = message.variants.find((variant) => variant.id === row.item.variantId);
    if (!actual) return;
    const currentPosition = message.variants.findIndex((variant) => variant.variantIndex === message.selectedVariantIndex);
    const targetPosition = message.variants.findIndex((variant) => variant.id === actual.id);
    const direction = targetPosition > currentPosition ? 1 : -1;
    useSnapshotStore.getState().selectVariant(batch.messageId, actual.variantIndex, direction);
    void selectVariantAction(activeChatId, batch.messageId, actual.variantIndex);
    onClose();
  }
}

function FoldRow({ rows, messageId, open, onToggle, onSelect }: { rows: FinishedQueueRow[]; messageId: string; open: boolean; onToggle: () => void; onSelect: (row: FinishedQueueRow) => void }): ReactNode {
  const { t, tDynamic } = useT();
  return <><button type="button" onClick={onToggle} aria-label={t("queue_timeline_fold_aria")} className="relative flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-[calc(var(--ui-fs)-3px)] text-t2 hover:bg-s2"><span className="z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-glass-bg text-[9px] text-accent">{rows.length}</span><span className="min-w-0 flex-1">{tDynamic("queue_timeline_folded", { count: rows.length })}</span><span className="flex h-6 w-6 shrink-0 items-center justify-center text-t3"><Icons.Caret direction={open ? "u" : "d"} /></span></button><AnimatedDisclosure open={open}><div>{rows.map((row) => <FinishedRow key={row.item.variantId} row={row} messageId={messageId} onClose={() => undefined} onSelect={onSelect} />)}</div></AnimatedDisclosure></>;
}

function FinishedRow({ row, messageId, onClose, onSelect }: { row: FinishedQueueRow; messageId: string; onClose: () => void; onSelect: (row: FinishedQueueRow) => void }): ReactNode {
  const { t } = useT();
  const metadata = row.item.presetName ? `${row.item.modelLabel} · ${row.item.presetName}` : row.item.modelLabel;
  return <div className="relative flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-[calc(var(--ui-fs)-3px)]"><button type="button" onClick={() => onSelect(row)} className={cn("flex min-w-0 flex-1 items-center gap-2.5 text-left", row.selected ? "text-accent-t" : "text-t2")}><span className="z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"><Icons.check /></span><span className="min-w-0 flex-1 overflow-hidden"><span className="block whitespace-nowrap">{t("queue_timeline_variant", { n: row.item.displayIndex })}</span><span className="block truncate text-t3" title={metadata}>{metadata}</span></span></button>{messageId && <VariantStarButton messageId={brandId<MessageId>(messageId)} variantId={row.item.variantId} displayIndex={row.item.displayIndex} className="h-6 w-6" />}</div>;
}

function RecordRow({ row, expanded, onToggleError, jobId, ref }: { row: Exclude<QueueRow, FinishedQueueRow>; expanded: boolean; onToggleError: () => void; jobId?: string; ref?: React.Ref<HTMLDivElement> }): ReactNode {
  const { t } = useT();
  const record = row.record;
  const metadata = `${record.model ?? ""}${record.presetName ? ` · ${record.presetName}` : ""}`;
  const cancel = () => { if (jobId) cancelQueueJob(jobId); else if (record.status === "running") useChatStore.getState().abortGeneration(useChatStore.getState().activeChatId!); };
  const label = record.status === "failed" ? t("queue_timeline_error") : record.status === "running" ? t("queue_timeline_writing") : t("queue_timeline_waiting");
  return <div ref={ref}><div className="relative flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-[calc(var(--ui-fs)-3px)]"><span className={cn("z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-glass-bg", record.status === "failed" ? "border-2 border-danger-text text-[10px] text-danger-text" : record.status === "running" ? "border-2 border-border border-t-accent animate-spin-slow" : "border-2 border-t4")}>{record.status === "failed" && "!"}</span><span className={cn("min-w-0 flex-1", record.status === "failed" && "text-danger-text", record.status === "running" && "text-accent-t")}><span className="block whitespace-nowrap">{label}</span><span className="block truncate text-t3" title={metadata}>{metadata}</span></span>{record.status === "failed" ? <button type="button" onClick={onToggleError} aria-label={t("queue_timeline_error_detail_aria")} className="flex h-6 w-6 shrink-0 items-center justify-center text-t3"><Icons.Caret direction={expanded ? "u" : "d"} /></button> : <button type="button" onClick={cancel} aria-label={t("queue_timeline_cancel_aria")} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-t3 hover:bg-s2 hover:text-danger-text"><Icons.Close /></button>}</div>{record.status === "failed" && <AnimatedDisclosure open={expanded}><div className="px-3 pb-2 pl-[38px] text-[calc(var(--ui-fs)-3px)] leading-snug text-danger-text">{record.error}</div></AnimatedDisclosure>}</div>;
}
