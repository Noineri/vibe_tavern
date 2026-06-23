import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "./chat-store.js";

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
 * Only "Generate more" clicks (job #2 onward) feed this store. Therefore a
 * non-empty store ⟺ the user has clicked "Generate more" ⟺ the manager pill
 * is visible (D10).
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
  status: QueueJobStatus;
  /** Variant index once the job completes and materializes a swipe. */
  variantIndex?: number;
  error?: string;
  enqueuedAt: number;
}

interface GenerationQueueState {
  /** Jobs keyed by chat id, in enqueue order. */
  jobsByChat: Record<string, QueueJob[]>;
}

export interface EnqueueJobInput {
  chatId: string;
  messageId: string;
  model: string;
  promptPresetId: string | null;
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

    enqueueJob: (input) => {
      const id = nextJobId();
      const job: QueueJob = {
        id,
        chatId: input.chatId,
        messageId: input.messageId,
        model: input.model,
        promptPresetId: input.promptPresetId,
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
        // Keep only the running job (if any); drop pending + settled.
        s.jobsByChat[chatId] = jobs.filter((j) => j.status === "running");
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
        if (job && job.status === "pending") job.status = "running";
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
  })),
);

function findJob(state: GenerationQueueState, jobId: string): QueueJob | undefined {
  for (const jobs of Object.values(state.jobsByChat)) {
    const job = jobs.find((j) => j.id === jobId);
    if (job) return job;
  }
  return undefined;
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
export function useQueueDisplayTotal(chatId: string | null | undefined): number {
  const queued = useQueueCount(chatId);
  const isSending = useChatStore(
    useShallow((s) => (chatId ? !!s.generations[chatId]?.isSending : false)),
  );
  return queued + (isSending ? 1 : 0);
}

/**
 * All jobs for a chat, in enqueue order. Subscribed to by the QueueManager so it
 * re-renders on any status transition / error in the chat's queue. Returns a
 * stable EMPTY array when there are no jobs (so callers can `.map` safely and
 * referential identity holds when nothing changes).
 */
export function useQueueJobs(chatId: string | null | undefined): QueueJob[] {
  return useGenerationQueueStore(
    useShallow((s) => (chatId ? s.jobsByChat[chatId] ?? EMPTY : EMPTY)),
  );
}
