import { useState, useMemo, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../lib/cn.js";
import { resolveModelLabel } from "../../lib/model-resolve.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import {
  useQueueJobs,
  useQueueDisplayTotal,
  useHasActiveQueue,
  type QueueJob,
} from "../../stores/generation-queue-store.js";
import {
  enqueueGenerateMore,
  cancelQueueJob,
  clearQueuePending,
} from "../../hooks/use-generation-queue.js";

/**
 * Pinned queue manager (CHAT_GENERATION_QUEUE_PLAN Q4b).
 *
 * Sits as a sibling above the composer in PlayMode. Hidden entirely while the
 * queue store is empty (the standalone first regenerate, job #0, is NOT tracked
 * here — so the store only populates once the user clicks "Generate more"). The
 * first queued job reveals the pill; expanding it shows the per-job list with
 * cancel / clear / add-current affordances.
 *
 * Layout:
 *  - Desktop: a left-aligned pill; expanding opens an UPWARD popover anchored to
 *    the pill (`absolute bottom-full left-0`). The composer never moves.
 *  - Mobile: a left-aligned pill; tapping opens a full-width bottom sheet
 *    (reuses the Rail.tsx z-[501] pattern), so it never fights the keyboard.
 *
 * The pill pulses while any job is pending or running (source-agnostic: covers
 * non-stream `streamResponse`-off runs via useHasActiveQueue → isSending).
 */
export function QueueManager(): ReactNode {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const jobs = useQueueJobs(activeChatId);
  const total = useQueueDisplayTotal(activeChatId);
  const isActive = useHasActiveQueue(activeChatId);
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const { t } = useT();

  // Empty queue (job #0 not tracked) → render nothing, UNLESS the popover is
  // already open (e.g. the user just cleared the last pending job): then keep
  // the panel mounted so it can show a brief "queue empty" frame instead of
  // vanishing mid-interaction. The pill appears on the first "Generate more"
  // click, which is exactly when the user has signaled intent to queue ≥ 1.
  if (jobs.length < 1 && !expanded) return null;

  const done = jobs.filter((j) => j.status === "done").length;
  // Counter-only label: the spinning regen icon conveys "generating", so a
  // trailing noun is redundant — and a noun after a Russian counter ("0/6
  // генерация…") is grammatically wrong without plural-form logic. Keeping
  // the pill locale-agnostic (done/total only) sidesteps both issues.
  const pillLabel = jobs.length < 1 ? "" : `${done}/${total}`;

  return (
    <div className="absolute bottom-full left-1.5 z-20 mb-1 flex items-center gap-1.5">
      <Popover.Root open={expanded} onOpenChange={setExpanded}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              "glass-blur flex items-center gap-1.5 rounded-full border border-border2 bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1",
            )}
            aria-expanded={expanded}
            aria-label={t("queue_title")}
          >
            <Icons.regen className={cn(isActive && "animate-spin-slow")} />
            {pillLabel && <span className={cn(isActive && "text-accent-t")}>{pillLabel}</span>}
            <Icons.Caret direction={expanded ? "d" : "u"} />
          </button>
        </Popover.Trigger>
        {!isMobile && (
          <Popover.Portal container={getModalPortal() ?? undefined}>
            <DesktopPopoverContent jobs={jobs} onClose={() => setExpanded(false)} />
          </Popover.Portal>
        )}
      </Popover.Root>

      {expanded && isMobile && (
        <MobileSheet jobs={jobs} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}

// ── Job-row rendering (shared metadata resolution) ───────────────────────

/** Resolve a preset id to its display name from the bootstrap preset list. */
function usePresetName(presetId: string | null): string | null {
  const presets = useBootstrapStore((s) => s.data?.promptPresets ?? null);
  return useMemo(() => {
    if (!presetId || !presets) return null;
    return presets.find((p) => p.id === presetId)?.name ?? null;
  }, [presetId, presets]);
}

/** Status indicator for a single job row. Pending rows stay quiet (a muted
 *  dot) instead of repeating the word "queued"; running shows the spinning
 *  regen glyph; failed wraps its ✕ in a tooltip carrying the job's error.
 *  Visual state is paired with an aria-label so screen readers still announce
 *  it — the dots/icons/✓/✕ alone are not descriptive enough. */
function JobStatus({ job }: { job: QueueJob }): ReactNode {
  const { t } = useT();
  switch (job.status) {
    case "pending":
      return <span aria-label={t("queue_queued")} className="text-t4">·</span>;
    case "running":
      return (
        <span aria-label={t("queue_running")} className="text-accent-t">
          <Icons.regen className="animate-spin-slow" />
        </span>
      );
    case "done":
      return <span aria-label={t("queue_done")} className="text-success-text">✓</span>;
    case "failed":
      return (
        <CustomTooltip content={job.error ?? ""} side="top">
          <span aria-label={job.error ? `${t("queue_failed")}: ${job.error}` : t("queue_failed")} className="cursor-help text-danger-text">✕</span>
        </CustomTooltip>
      );
    case "cancelled":
      return <span className="text-t4">✕</span>;
  }
}

function JobRow({ job, index, onClose, compact = true }: { job: QueueJob; index: number; onClose: () => void; compact?: boolean }): ReactNode {
  const presetName = usePresetName(job.promptPresetId);
  const isCancellable = job.status === "pending" || job.status === "running";
  return (
    <div className={cn(
      "flex items-center gap-2 text-[calc(var(--ui-fs)-3px)] text-t2",
      compact ? "px-3 py-2" : "px-4 py-3",
    )}>
      <span className="w-6 shrink-0 text-t3">#{index + 1}</span>
      <span className="shrink-0 text-t2">{resolveModelLabel(job.model)}</span>
      {presetName && <span className="min-w-0 flex-1 truncate text-t3">· {presetName}</span>}
      <span className="ml-auto shrink-0">
        <JobStatus job={job} />
      </span>
      {isCancellable && (
        <button
          type="button"
          onClick={() => { cancelQueueJob(job.id); }}
          className={cn(
            "flex shrink-0 items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-danger-text",
            compact ? "h-6 w-6" : "h-10 w-10",
          )}
          aria-label="cancel"
        >
          <Icons.Close />
        </button>
      )}
    </div>
  );
}

/** "+ Add (current)" enqueues another job for the same message as the existing jobs. */
function useAddCurrent(jobs: QueueJob[]): () => void {
  return useMemo(() => () => {
    const messageId = jobs[0]?.messageId;
    if (!messageId) return;
    const profile = useProviderDataStore.getState().profiles.find((p) => p.isActive) ?? null;
    const model = profile?.defaultModel ?? useProviderStore.getState().connection.model ?? null;
    if (!model) return;
    const promptPresetId = useSnapshotStore.getState().activeChat?.promptPresetId ?? null;
    enqueueGenerateMore(messageId, model, promptPresetId);
  }, [jobs]);
}

function ManagerHeader({ jobs, onClose }: { jobs: QueueJob[]; onClose: () => void }): ReactNode {
  const { t } = useT();
  const addCurrent = useAddCurrent(jobs);
  const hasPending = jobs.some((j) => j.status === "pending");
  // Two rows: title + count + clear on top, a full-width "Add current" CTA
  // below. Cramming all three into one w-80 row wraps under Russian strings
  // ("Добавить текущие" + "Очистить очередь" + title ≈ 48 chars > 320px); the
  // primary CTA also deserves its own row. Each row stays single-line.
  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="shrink-0 whitespace-nowrap font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-t1">{t("queue_title")}</span>
        <span className="shrink-0 whitespace-nowrap text-[calc(var(--ui-fs)-3px)] text-t3">{jobs.length}</span>
        {hasPending && (
          <button
            type="button"
            onClick={() => { clearQueuePending(); onClose(); }}
            className="ml-auto shrink-0 whitespace-nowrap rounded px-2 py-1 text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-danger-text"
          >
            {t("queue_clear")}
          </button>
        )}
      </div>
      <CustomTooltip content={t("queue_add_current_hint")} side="top">
        <button
          type="button"
          onClick={addCurrent}
          className="flex w-full items-center gap-1.5 whitespace-nowrap border-t border-border px-3 py-2 text-[calc(var(--ui-fs)-3px)] text-accent-t transition-colors hover:bg-s2"
        >
          <Icons.Plus />
          <span>{t("queue_add_current")}</span>
        </button>
      </CustomTooltip>
    </div>
  );
}

// ── Desktop: upward popover (Radix Popover) ─────────────────────────────

function DesktopPopoverContent({ jobs, onClose }: { jobs: QueueJob[]; onClose: () => void }): ReactNode {
  const { t } = useT();
  return (
    <Popover.Content
      side="top"
      align="start"
      sideOffset={4}
      className="glass-blur z-[220] max-w-[calc(100vw-2rem)] w-80 overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
    >
      {jobs.length < 1 ? (
        <div className="px-3 py-6 text-center text-[calc(var(--ui-fs)-3px)] text-t3">{t("queue_empty")}</div>
      ) : (
        <>
          <ManagerHeader jobs={jobs} onClose={onClose} />
          <div className="max-h-64 overflow-y-auto">
            {jobs.map((job, i) => (
              <JobRow key={job.id} job={job} index={i} onClose={onClose} />
            ))}
          </div>
        </>
      )}
    </Popover.Content>
  );
}

// ── Mobile: bottom sheet (reuses Rail.tsx z-[501] pattern) ───────────────

function MobileSheet({ jobs, onClose }: { jobs: QueueJob[]; onClose: () => void }): ReactNode {
  const { t } = useT();
  return (
    <BottomSheet open={true} onClose={onClose}>
      {jobs.length < 1 ? (
        <div className="px-4 py-8 text-center text-[calc(var(--ui-fs)-2px)] text-t3">{t("queue_empty")}</div>
      ) : (
        <>
          <ManagerHeader jobs={jobs} onClose={onClose} />
          <div className="max-h-[50vh] overflow-y-auto pb-2">
            {jobs.map((job, i) => (
              <JobRow key={job.id} job={job} index={i} onClose={onClose} compact={false} />
            ))}
          </div>
        </>
      )}
    </BottomSheet>
  );
}
