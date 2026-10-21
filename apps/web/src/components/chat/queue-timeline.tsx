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
import { resolveModelLabel } from "../../lib/model-resolve.js";
import { AnimatedDisclosure } from "../shared/AnimatedDisclosure.js";
import { Icons } from "../shared/icons.js";
import { QueueProgressRing } from "./queue-progress-ring.js";
import { useQueueRows, type FinishedQueueRow, type QueueRow } from "./queue-rows.js";
import { VariantStarButton } from "./variants/variant-jump.js";

type QueueTimelineProps = { onClose: () => void };
type TimelineFoldRow = { kind: "fold"; rows: FinishedQueueRow[] };
const EMPTY_JOBS: readonly never[] = [];
const EMPTY_PRESETS: readonly never[] = [];

/** Desktop timeline B for the durable generation batch, deliberately separate from the QS-7 mobile sheet. */
export function QueueTimeline({ onClose }: QueueTimelineProps): ReactNode {
  const { t } = useT();
  const activeChatId = useChatStore((state) => state.activeChatId);
  const batch = useGenerationQueueStore((state) => activeChatId ? state.batchesByChat[activeChatId] ?? null : null);
  const jobs = useGenerationQueueStore((state) => activeChatId ? state.jobsByChat[activeChatId] ?? EMPTY_JOBS : EMPTY_JOBS);
  const message = useSnapshotStore((state) => batch ? state.messagesById[batch.messageId] ?? null : null);
  const selectedVariantPosition = useMemo(() => {
    const variants = message?.variants ?? [];
    if (variants.length === 0) return 0;
    const persistedPosition = message?.selectedVariantIndex === null || message?.selectedVariantIndex === undefined
      ? -1
      : variants.findIndex((variant) => variant.variantIndex === message.selectedVariantIndex);
    if (persistedPosition >= 0) return persistedPosition;
    const selectedFlagPosition = variants.findIndex((variant) => variant.isSelected);
    return selectedFlagPosition >= 0 ? selectedFlagPosition : 0;
  }, [message?.selectedVariantIndex, message?.variants]);
  const rowsResult = useQueueRows({ chatId: activeChatId, variants: message?.variants ?? [], selectedVariantIndex: selectedVariantPosition });
  const activeProfileModel = useProviderDataStore((state) => state.profiles.find((profile) => profile.isActive)?.defaultModel ?? null);
  const connectionModel = useProviderStore((state) => state.connection.model);
  const presetId = useSnapshotStore((state) => state.activeChat?.promptPresetId ?? null);
  const presets = useBootstrapStore((state) => state.data?.promptPresets ?? EMPTY_PRESETS);
  const [foldOpen, setFoldOpen] = useState(false);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const runningRef = useRef<HTMLDivElement>(null);
  const runningRow = rowsResult.rows.find((row) => row.kind === "running");
  const runningId = runningRow && "record" in runningRow ? runningRow.record.id : null;
  const model = activeProfileModel ?? connectionModel ?? null;
  const presetName = presetId ? presets.find((preset) => preset.id === presetId)?.name ?? t("topbar_default") : t("topbar_default");
  const footerLabel = model ? `${resolveModelLabel(model)} · ${presetName}` : presetName;

  useEffect(() => {
    if (runningId) runningRef.current?.scrollIntoView({ block: "nearest" });
  }, [runningId]);

  const renderedRows = useMemo(() => {
    const result: Array<QueueRow | TimelineFoldRow> = [];
    if (rowsResult.folded) result.push({ kind: "fold", rows: rowsResult.folded });
    result.push(...rowsResult.rows);
    return result;
  }, [rowsResult.folded, rowsResult.rows]);
  const displayedNodeCount = renderedRows.length + (foldOpen ? rowsResult.folded?.length ?? 0 : 0);
  const lastFinishedNode = renderedRows.findLastIndex((row) => row.kind === "finished" || row.kind === "fold")
    + (foldOpen ? rowsResult.folded?.length ?? 0 : 0);
  const accentHeight = displayedNodeCount > 1 && lastFinishedNode >= 0
    ? (lastFinishedNode / (displayedNodeCount - 1)) * 100
    : 0;
  const hasPending = rowsResult.rows.some((row) => row.kind === "pending");

  if (!batch || !message || !activeChatId) return null;
  const timelineBatch = batch;
  const timelineChatId = activeChatId;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5" data-queue-timeline-header>
        <span className="shrink-0 whitespace-nowrap font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{t("queue_timeline_title")}</span>
        <span className="shrink-0 whitespace-nowrap text-[calc(var(--ui-fs)-3px)] text-t3">{t("queue_chip_progress", { done: rowsResult.summary.done, total: rowsResult.summary.total })}</span>
        {hasPending && <button type="button" onClick={() => { clearQueuePending(); onClose(); }} className="ml-auto shrink-0 whitespace-nowrap rounded px-2 py-1 text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-danger-text">{t("queue_timeline_clear")}</button>}
      </div>
      <div className="relative max-h-64 overflow-y-auto py-1" data-queue-timeline>
        <div className="absolute bottom-4 left-[19px] top-4 w-0.5 bg-border" aria-hidden="true" data-queue-timeline-track><i className="block w-full bg-accent" data-queue-timeline-accent data-last-finished-node={lastFinishedNode} data-displayed-node-count={displayedNodeCount} style={{ height: `${accentHeight}%` }} /></div>
        {renderedRows.map((row) => row.kind === "fold" ? (
          <FoldRow key="fold" rows={row.rows} messageId={timelineBatch.messageId} open={foldOpen} onToggle={() => setFoldOpen((open) => !open)} onSelect={selectVariant} />
        ) : row.kind === "finished" ? (
          <FinishedRow key={row.item.variantId} row={row} messageId={timelineBatch.messageId} onSelect={selectVariant} />
        ) : (
          <RecordRow key={row.record.id} row={row} ref={row.record.id === runningId ? runningRef : undefined} expanded={expandedError === row.record.id} onToggleError={() => setExpandedError((value) => value === row.record.id ? null : row.record.id)} jobId={jobs.find((job) => job.recordId === row.record.id)?.id} />
        ))}
      </div>
      <button type="button" onClick={addCurrent} className="flex w-full min-w-0 items-center gap-1.5 border-t border-border px-3 py-[9px] text-left font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-colors hover:bg-s2">
        <Icons.Plus /><span className="shrink-0 whitespace-nowrap">{t("queue_timeline_one_more")}</span><span className="min-w-0 truncate" title={footerLabel}>{footerLabel}</span>
      </button>
    </>
  );

  function addCurrent(): void {
    const profileModel = useProviderDataStore.getState().profiles.find((profile) => profile.isActive)?.defaultModel ?? null;
    const latestModel = profileModel ?? useProviderStore.getState().connection.model ?? null;
    const latestPresetId = useSnapshotStore.getState().activeChat?.promptPresetId ?? null;
    if (latestModel) enqueueGenerateMore(timelineBatch.messageId, latestModel, latestPresetId);
  }

  function selectVariant(row: FinishedQueueRow): void {
    const latestMessage = useSnapshotStore.getState().messagesById[timelineBatch.messageId];
    if (!latestMessage) return;
    const actual = latestMessage.variants.find((variant) => variant.id === row.item.variantId);
    if (!actual) return;
    const currentPosition = latestMessage.variants.findIndex((variant) => variant.variantIndex === latestMessage.selectedVariantIndex);
    const targetPosition = latestMessage.variants.findIndex((variant) => variant.id === actual.id);
    const direction = targetPosition > currentPosition ? 1 : -1;
    useSnapshotStore.getState().selectVariant(timelineBatch.messageId, actual.variantIndex, direction);
    void selectVariantAction(timelineChatId, timelineBatch.messageId, actual.variantIndex);
    onClose();
  }
}

function FoldRow({ rows, messageId, open, onToggle, onSelect }: { rows: FinishedQueueRow[]; messageId: string; open: boolean; onToggle: () => void; onSelect: (row: FinishedQueueRow) => void }): ReactNode {
  const { t } = useT();
  return <><button type="button" onClick={onToggle} aria-expanded={open} aria-label={t(open ? "queue_timeline_fold_hide_aria" : "queue_timeline_fold_show_aria")} className="relative flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-[calc(var(--ui-fs)-3px)] text-t2 hover:bg-s2" data-queue-timeline-fold><span className="z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-glass-bg text-[9px] text-accent">{rows.length}</span><span className="min-w-0 flex-1">{t("queue_timeline_folded", { count: rows.length })}</span><span className="flex h-6 w-6 shrink-0 items-center justify-center text-t3"><Icons.Caret direction={open ? "u" : "d"} /></span></button><AnimatedDisclosure open={open}><div>{rows.map((row) => <FinishedRow key={row.item.variantId} row={row} messageId={messageId} onSelect={onSelect} />)}</div></AnimatedDisclosure></>;
}

function FinishedRow({ row, messageId, onSelect }: { row: FinishedQueueRow; messageId: string; onSelect: (row: FinishedQueueRow) => void }): ReactNode {
  const { t } = useT();
  const metadata = row.item.presetName ? `${row.item.modelLabel} · ${row.item.presetName}` : row.item.modelLabel;
  return <div className="relative flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-[calc(var(--ui-fs)-3px)]" data-queue-timeline-row="finished" data-selected={row.selected}><button type="button" onClick={() => onSelect(row)} className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-left", row.selected ? "text-accent-t" : "text-t2")}><span className="z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"><Icons.check /></span><span className="shrink-0 whitespace-nowrap">{t("queue_timeline_variant", { n: row.item.displayIndex })}</span><span className="min-w-0 truncate text-t3" title={metadata}>{metadata}</span></button>{messageId && <VariantStarButton messageId={brandId<MessageId>(messageId)} variantId={row.item.variantId} displayIndex={row.item.displayIndex} className="h-6 w-6" />}</div>;
}

function RecordRow({ row, expanded, onToggleError, jobId, ref }: { row: Exclude<QueueRow, FinishedQueueRow>; expanded: boolean; onToggleError: () => void; jobId?: string; ref?: React.Ref<HTMLDivElement> }): ReactNode {
  const { t } = useT();
  const record = row.record;
  const modelLabel = record.model ? resolveModelLabel(record.model) : "";
  const metadata = `${modelLabel}${record.presetName ? ` · ${record.presetName}` : ""}`;
  const cancel = () => { if (jobId) cancelQueueJob(jobId); else if (record.status === "running") useChatStore.getState().abortGeneration(useChatStore.getState().activeChatId!); };
  const label = record.status === "failed" ? t("queue_timeline_error") : record.status === "running" ? t("queue_timeline_writing") : t("queue_timeline_waiting");
  return <div ref={ref}><div className="relative flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-[calc(var(--ui-fs)-3px)]" data-queue-timeline-row={record.status}><span className="z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-glass-bg">{record.status === "failed" ? <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-danger-text text-[10px] text-danger-text">!</span> : record.status === "running" ? <QueueProgressRing className="h-4 w-4" running testIdPrefix="queue-timeline-running" /> : <span className="h-4 w-4 rounded-full border-2 border-t4" />}</span><span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", record.status === "failed" && "text-danger-text", record.status === "running" && "text-accent-t")}><span className="shrink-0 whitespace-nowrap">{label}</span><span className="min-w-0 truncate text-t3" title={metadata}>{metadata}</span></span>{record.status === "failed" ? <button type="button" onClick={onToggleError} aria-expanded={expanded} aria-label={t(expanded ? "queue_timeline_error_detail_hide_aria" : "queue_timeline_error_detail_show_aria")} className="flex h-6 w-6 shrink-0 items-center justify-center text-t3"><Icons.Caret direction={expanded ? "u" : "d"} /></button> : <button type="button" onClick={cancel} aria-label={t("queue_timeline_cancel_aria")} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-t3 hover:bg-s2 hover:text-danger-text"><Icons.Close /></button>}</div>{record.status === "failed" && <AnimatedDisclosure open={expanded}><div className="px-3 pb-2 pl-[38px] text-[calc(var(--ui-fs)-3px)] leading-snug text-danger-text" data-queue-timeline-error>{record.error}</div></AnimatedDisclosure>}</div>;
}
