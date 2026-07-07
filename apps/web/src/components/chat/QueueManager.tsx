import { useState, useMemo, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../lib/cn.js";
import { resolveModelLabel } from "../../lib/model-resolve.js";
import { Icons } from "../shared/icons.js";
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

  // Empty queue (job #0 not tracked) → render nothing. The pill appears on the
  // first "Generate more" click, which is exactly when the user has signaled
  // intent to queue ≥ 1 additional variant.
  if (jobs.length < 1) return null;

  const done = jobs.filter((j) => j.status === "done").length;
  const pillLabel = isActive
    ? `${done}/${total} ${t("queue_generating")}`
    : `${done}/${total}`;

  return (
    <div className="absolute bottom-full left-1.5 z-20 mb-1 flex items-center gap-1.5">
      <Popover.Root open={expanded} onOpenChange={setExpanded}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              "glass-blur flex items-center gap-1.5 rounded-full bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 transition-colors hover:bg-s3 hover:text-t1",
              isActive && "text-accent-t",
            )}
            aria-expanded={expanded}
            aria-label={t("queue_title")}
          >
            <Icons.regen className={cn(isActive && "animate-spin-slow")} />
            <span className={cn(isActive && "animate-pulse")}>{pillLabel}</span>
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

function statusLabel(status: QueueJob["status"], t: (k: string) => string): string {
  switch (status) {
    case "pending": return t("queue_queued");
    case "running": return t("queue_running");
    case "done": return "✓";
    case "failed": return t("queue_failed");
    case "cancelled": return "✕";
  }
}

function JobRow({ job, index, onClose }: { job: QueueJob; index: number; onClose: () => void }): ReactNode {
  const { t } = useT();
  const presetName = usePresetName(job.promptPresetId);
  const isCancellable = job.status === "pending" || job.status === "running";
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[calc(var(--ui-fs)-2px)] text-t2">
      <span className="w-6 shrink-0 text-t3">#{index + 1}</span>
      <span className="shrink-0 font-medium text-t1">{resolveModelLabel(job.model)}</span>
      {presetName && <span className="truncate text-t3">· {presetName}</span>}
      <span className={cn(
        "ml-auto shrink-0",
        job.status === "running" && "text-accent-t",
        job.status === "failed" && "text-danger-text",
        job.status === "done" && "text-success-text",
      )}>
        {statusLabel(job.status, t)}
      </span>
      {isCancellable && (
        <button
          type="button"
          onClick={() => { cancelQueueJob(job.id); }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-danger-text"
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
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-t1">{t("queue_title")}</span>
      <button
        type="button"
        onClick={addCurrent}
        className="flex items-center gap-1 rounded px-2 py-1 text-[calc(var(--ui-fs)-3px)] text-accent-t transition-colors hover:bg-s2"
      >
        <Icons.Plus />
        <span>{t("queue_add_current")}</span>
      </button>
      {hasPending && (
        <button
          type="button"
          onClick={() => { clearQueuePending(); onClose(); }}
          className="ml-auto rounded px-2 py-1 text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-danger-text"
        >
          {t("queue_clear")}
        </button>
      )}
    </div>
  );
}

// ── Desktop: upward popover (Radix Popover) ─────────────────────────────

function DesktopPopoverContent({ jobs, onClose }: { jobs: QueueJob[]; onClose: () => void }): ReactNode {
  return (
    <Popover.Content
      side="top"
      align="start"
      sideOffset={4}
      className="glass-blur z-[220] w-80 overflow-hidden rounded-lg border border-border bg-glass-bg shadow-[0_-4px_16px_rgba(0,0,0,0.4)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
    >
      <ManagerHeader jobs={jobs} onClose={onClose} />
      <div className="max-h-64 overflow-y-auto">
        {jobs.map((job, i) => (
          <JobRow key={job.id} job={job} index={i} onClose={onClose} />
        ))}
      </div>
    </Popover.Content>
  );
}

// ── Mobile: bottom sheet (reuses Rail.tsx z-[501] pattern) ───────────────

function MobileSheet({ jobs, onClose }: { jobs: QueueJob[]; onClose: () => void }): ReactNode {
  return (
    <BottomSheet open={true} onClose={onClose}>
      <ManagerHeader jobs={jobs} onClose={onClose} />
      <div className="max-h-[50vh] overflow-y-auto pb-2">
        {jobs.map((job, i) => (
          <JobRow key={job.id} job={job} index={i} onClose={onClose} />
        ))}
      </div>
    </BottomSheet>
  );
}
