import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import { useSnapshotStore } from "./snapshot-store.js";

/**
 * Chat generation queue — per-chat sequential job list (CHAT_GENERATION_QUEUE_PLAN Q3).
 *
 * Owns ONLY the queue's concern: the ordered list of enqueued regeneration
 * jobs and their per-job status. It does NOT model streaming-target identity
 * — that is the {@link useChatStore}`.streamingMessageId` seam (D8), which the
 * queue runner writes through `startGeneration`. The two stores are distinct:
 * this one answers "what is the queue's progress", chat-store answers "which
 * message is streaming right now".
 *
 * Job model/preset are KEYS, frozen at enqueue. The sampler/budget/reasoning
 * VALUES are NOT stored here — they resolve live from the target model's
 * per-model overlay at job-pop time on the backend (Q1a effective-profile path).
 * So editing provider settings between enqueue and pop applies the new values
 * to the next job (resolve-at-pop, not freeze-at-enqueue).
 *
 * The standalone FIRST regenerate (job #0) is NOT enqueued here — it stays a
 * single-flight action in {@link useChatController.handleRegenerateMessage}.
 * Only "Generate more" clicks (job #2 onward) feed executable jobs. The batch
 * state remembers that intent independently, so manager visibility survives a
 * drained, cleared, or cancelled job list until the next Send/Resend reset.
 */

export type QueueJobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface QueueJob {
  id: string;
  chatId: string;
  /** Existing assistant message this job adds a variant to. */
  messageId: string;
  /** Frozen model key. The override model's per-model overlay resolves at pop. */
  model: string;
  /** Frozen prompt-preset key (null = use the chat's current preset). */
  promptPresetId: string | null;
  /** Links this executable job to its non-variant timeline record. */
  recordId?: string;
  status: QueueJobStatus;
  /** Variant index once the job completes and materializes a swipe. */
  variantIndex?: number;
  error?: string;
  enqueuedAt: number;
}

export type GenerationRecordOrigin = "regenerate" | "queue";
export type GenerationRecordStatus = "pending" | "running" | "failed";
export interface GenerationRecord {
  id: string;
  messageId: string;
  /** Number of target variants that existed when this generation began. */
  startVariantPosition: number;
  origin: GenerationRecordOrigin;
  status: GenerationRecordStatus;
  model: string | null;
  presetName: string | null;
  presetId: string | null;
  error?: string;
}
export interface GenerationBatch {
  messageId: string;
  variantIdsAtStart: string[];
}

export interface GenerationBatchSummary {
  done: number;
  failed: number;
  running: number;
  pending: number;
  total: number;
}

interface GenerationQueueState {
  /** Jobs keyed by chat id, in enqueue order. */
  jobsByChat: Record<string, QueueJob[]>;
  batchesByChat: Record<string, GenerationBatch>;
  recordsByChat: Record<string, GenerationRecord[]>;
}

export interface EnqueueJobInput {
  chatId: string;
  messageId: string;
  model: string;
  promptPresetId: string | null;
  recordId?: string;
}

export interface GenerationQueueActions {
  /** Append a pending job. Returns the new job id. */
  enqueueJob: (input: EnqueueJobInput) => string;
  /**
   * Cancel a job. Pending jobs are removed immediately. A running job is marked
   * `cancelled` (the runner observes the abort and stops); the caller is
   * responsible for aborting the in-flight generation via the chat-store.
   */
  cancelJob: (jobId: string) => void;
  /** Remove all non-running jobs for a chat (Clear queue). Running jobs continue. */
  clearPending: (chatId: string) => void;
  /** Drop finished/failed/cancelled jobs for a chat (tidy after the user is done). */
  clearSettled: (chatId: string) => void;
  markRunning: (jobId: string) => void;
  markDone: (jobId: string, variantIndex?: number) => void;
  markFailed: (jobId: string, error: string) => void;
  /** Remove a single job (used after the runner observes a cancel). */
  removeJob: (jobId: string) => void;
  startBatch: (chatId: string, messageId: string, variantIds: string[]) => void;
  addRecord: (chatId: string, record: Omit<GenerationRecord, "id" | "startVariantPosition">) => string;
  updateRecord: (
    chatId: string,
    id: string,
    patch: Partial<Omit<GenerationRecord, "id" | "messageId" | "startVariantPosition">>,
  ) => void;
  removeRecord: (chatId: string, id: string) => void;
  clearBatch: (chatId: string) => void;
}

let jobCounter = 0;
function nextJobId(): string {
  jobCounter += 1;
  return `qjob_${Date.now().toString(36)}_${jobCounter}`;
}

function findChatJobs(state: GenerationQueueState, chatId: string): QueueJob[] {
  return state.jobsByChat[chatId] ?? (state.jobsByChat[chatId] = []);
}

export const useGenerationQueueStore = create<GenerationQueueState & GenerationQueueActions>()(
  immer((set) => ({
    jobsByChat: {},
    batchesByChat: {},
    recordsByChat: {},

    enqueueJob: (input) => {
      const id = nextJobId();
      const job: QueueJob = {
        id,
        chatId: input.chatId,
        messageId: input.messageId,
        model: input.model,
        promptPresetId: input.promptPresetId,
        recordId: input.recordId,
        status: "pending",
        enqueuedAt: Date.now(),
      };
      set((s) => {
        findChatJobs(s, input.chatId).push(job);
      });
      return id;
    },

    cancelJob: (jobId) =>
      set((s) => {
        for (const jobs of Object.values(s.jobsByChat)) {
          const idx = jobs.findIndex((j) => j.id === jobId);
          if (idx === -1) continue;
          const job = jobs[idx];
          if (job.status === "pending") {
            // Not started yet — drop it outright.
            jobs.splice(idx, 1);
            if (job.recordId) removeRecordFromDraft(s, job.chatId, job.recordId);
          } else if (job.status === "running") {
            // In flight — mark cancelled; the runner's abort observer removes it.
            job.status = "cancelled";
          }
          return;
        }
      }),

    clearPending: (chatId) =>
      set((s) => {
        const jobs = s.jobsByChat[chatId];
        if (!jobs) return;
        // Finished variants and failed records remain visible; clear only waiting work.
        for (const job of jobs) {
          if (job.status === "pending" && job.recordId) removeRecordFromDraft(s, chatId, job.recordId);
        }
        s.jobsByChat[chatId] = jobs.filter((j) => j.status !== "pending");
      }),

    clearSettled: (chatId) =>
      set((s) => {
        const jobs = s.jobsByChat[chatId];
        if (!jobs) return;
        s.jobsByChat[chatId] = jobs.filter((j) => j.status === "pending" || j.status === "running");
      }),

    markRunning: (jobId) =>
      set((s) => {
        const job = findJob(s, jobId);
        if (job && job.status === "pending") {
          job.status = "running";
          if (job.recordId) {
            const record = s.recordsByChat[job.chatId]?.find((item) => item.id === job.recordId);
            if (record) record.status = "running";
          }
        }
      }),

    markDone: (jobId, variantIndex) =>
      set((s) => {
        const job = findJob(s, jobId);
        if (job) {
          job.status = "done";
          if (typeof variantIndex === "number") job.variantIndex = variantIndex;
        }
      }),

    markFailed: (jobId, error) =>
      set((s) => {
        const job = findJob(s, jobId);
        if (job) {
          job.status = "failed";
          job.error = error;
        }
      }),

    removeJob: (jobId) =>
      set((s) => {
        for (const [chatId, jobs] of Object.entries(s.jobsByChat)) {
          const idx = jobs.findIndex((j) => j.id === jobId);
          if (idx !== -1) {
            jobs.splice(idx, 1);
            if (jobs.length === 0) delete s.jobsByChat[chatId];
            return;
          }
        }
      }),
    startBatch: (chatId, messageId, variantIds) => set((s) => {
      if (!s.batchesByChat[chatId]) s.batchesByChat[chatId] = { messageId, variantIdsAtStart: variantIds };
    }),
    addRecord: (chatId, record) => {
      const id = nextJobId();
      const startVariantPosition = useSnapshotStore.getState().messagesById[record.messageId]?.variants.length ?? 0;
      set((s) => {
        (s.recordsByChat[chatId] ??= []).push({ ...record, id, startVariantPosition });
      });
      return id;
    },
    updateRecord: (chatId, id, patch) => set((s) => {
      const record = s.recordsByChat[chatId]?.find((item) => item.id === id);
      if (record) Object.assign(record, patch);
    }),
    removeRecord: (chatId, id) => set((s) => {
      const records = s.recordsByChat[chatId];
      if (!records) return;
      s.recordsByChat[chatId] = records.filter((record) => record.id !== id);
    }),
    clearBatch: (chatId) => set((s) => {
      delete s.batchesByChat[chatId];
      delete s.recordsByChat[chatId];
      delete s.jobsByChat[chatId];
    }),
  })),
);

function findJob(state: GenerationQueueState, jobId: string): QueueJob | undefined {
  for (const jobs of Object.values(state.jobsByChat)) {
    const job = jobs.find((j) => j.id === jobId);
    if (job) return job;
  }
  return undefined;
}

function removeRecordFromDraft(state: GenerationQueueState, chatId: string, recordId: string): void {
  const records = state.recordsByChat[chatId];
  if (!records) return;
  state.recordsByChat[chatId] = records.filter((record) => record.id !== recordId);
}

// Dev-only debug global (mirrors the chat-store / snapshot-store pattern) so the
// QueueManager UI can be exercised without driving a real generation.
if (typeof window !== "undefined") {
  window.__useGenerationQueueStore = useGenerationQueueStore;
}

// ── Narrow selectors ───────────────────────────────────────────────────
// Each selector projects only what its consumer renders, so unrelated job
// field changes (e.g. an error on job A) do not re-render a subscriber that
// only reads job B's status.

/** Total jobs for a chat (all statuses). Drives pill visibility (≥1 = show). */
export function useQueueCount(chatId: string | null | undefined): number {
  return useGenerationQueueStore(
    useShallow((s) => (chatId ? s.jobsByChat[chatId]?.length ?? 0 : 0)),
  );
}

/** Jobs targeting a specific message (e.g. to disable its edit affordance). */
export function useQueueForMessage(messageId: string | null | undefined): QueueJob[] {
  return useGenerationQueueStore(
    useShallow((s) => {
      if (!messageId) return EMPTY;
      const all = Object.values(s.jobsByChat).flat();
      return all.filter((j) => j.messageId === messageId);
    }),
  );
}

/** Single job status (for a per-item row in the manager). */
export function useQueueJobStatus(jobId: string | null | undefined): QueueJobStatus | null {
  return useGenerationQueueStore(
    useShallow((s) => (jobId ? findJob(s, jobId)?.status ?? null : null)),
  );
}

/** Whether a chat has any pending or running work (drives the pulsing pill + pause logic). */
export function useHasActiveQueue(chatId: string | null | undefined): boolean {
  return useGenerationQueueStore(
    useShallow((s) => {
      if (!chatId) return false;
      const jobs = s.jobsByChat[chatId];
      return !!jobs?.some((j) => j.status === "pending" || j.status === "running");
    }),
  );
}

const EMPTY: QueueJob[] = [];
const EMPTY_RECORDS: GenerationRecord[] = [];

/**
 * Conceptual display count for the manager pill: queue jobs PLUS one if a
 * generation is currently in flight for the chat (the standalone job #0 or a
 * running queue job). Per D10 the pill is shown when this is ≥ 2 — i.e. an
 * in-flight generation coexists with at least one queued job. In practice
 * this hook is rarely needed (the store is empty until the first "Generate
 * more", so {@link useQueueCount} ≥ 1 is the simpler pill gate); it is
 * provided for the pill's `{done}/{total}` text where `total` should read as
 * the user-perceived queue length including the running item.
 */
export function useGenerationBatchSummary(
  chatId: string | null | undefined,
): { visible: boolean; summary: GenerationBatchSummary } {
  const batch = useGenerationQueueStore((s) => (chatId ? s.batchesByChat[chatId] ?? null : null));
  const records = useGenerationQueueStore(
    useShallow((s) => (chatId ? s.recordsByChat[chatId] ?? EMPTY_RECORDS : EMPTY_RECORDS)),
  );
  const target = useSnapshotStore((s) => (batch ? s.messagesById[batch.messageId] ?? null : null));
  const isTargetVisible = useSnapshotStore((s) => batch !== null && s.messageOrder.includes(batch.messageId));
  const targetVariantCount = target?.variants.length ?? 0;
  const targetRecords = records.filter((record) => record.messageId === batch?.messageId);
  const runningRecords = targetRecords.filter((record) => record.status === "running");
  const hasArrivedInFlightVariant = runningRecords.some(
    (record) => targetVariantCount > record.startVariantPosition,
  );
  const done = Math.max(0, targetVariantCount - (hasArrivedInFlightVariant ? 1 : 0));
  const failed = targetRecords.filter((record) => record.status === "failed").length;
  const running = runningRecords.length;
  const pending = targetRecords.filter((record) => record.status === "pending").length;
  return {
    visible: batch !== null && isTargetVisible,
    summary: { done, failed, running, pending, total: done + failed + running + pending },
  };
}

/**
 * All jobs for a chat, in enqueue order. Subscribed to by the QueueManager so it
 * re-renders on any status transition / error in the chat's queue. Returns a
 * stable EMPTY array when there are no jobs (so callers can `.map` safely and
 * referential identity holds when nothing changes).
 */
export function useQueueJobs(chatId: string | null | undefined): QueueJob[] {
  const batch = useGenerationQueueStore((s) => (chatId ? s.batchesByChat[chatId] ?? null : null));
  const isTargetVisible = useSnapshotStore((s) => batch !== null && s.messageOrder.includes(batch.messageId));
  return useGenerationQueueStore(
    useShallow((s) => (chatId && isTargetVisible ? s.jobsByChat[chatId] ?? EMPTY : EMPTY)),
  );
}
