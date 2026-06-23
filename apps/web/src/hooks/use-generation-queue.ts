import { useEffect } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { useChatStore } from "../stores/chat-store.js";
import {
  useGenerationQueueStore,
  type QueueJob,
} from "../stores/generation-queue-store.js";
import type { StreamOutcome } from "./use-chat-controller.js";

/**
 * Generation queue runner (CHAT_GENERATION_QUEUE_PLAN Q3).
 *
 * Owns the sequential pump: a single async loop per chat that pops pending
 * jobs one at a time and runs each via the controller's `runRegenerateJob`
 * (which reuses the existing streaming/reveal + generation-state machinery).
 * The queue STATE lives in {@link useGenerationQueueStore}; this module is only
 * the pump + the UI entry points (enqueue / cancel / clear).
 *
 * The runner is registered once (in the app shell) with a `runJob` function;
 * thereafter {@link enqueueGenerateMore} / {@link cancelQueueJob} /
 * {@link clearQueuePending} are plain module-level functions any component
 * (the "Generate more" button, the QueueManager) can import and call directly.
 *
 * Invariants (from the plan):
 *  - Sequential: exactly one in-flight generation per chat. The pump waits for
 *    `!isSending(chatId)` before starting each job, so it never overlaps the
 *    standalone first regenerate (job #0) or a previous queue job.
 *  - Chat-switch pause (D2): the pump also waits for `activeChatId === chatId`,
 *    so pending jobs for a backgrounded chat resume only on return. The
 *    in-flight job always finishes (it is not cancelled by the switch).
 *  - Per-job failure (D3): a failed job is marked `failed`; the pump advances.
 *  - Abort (D1): cancelling a running job aborts the chat's in-flight
 *    generation (the controller observes the abort, returns "cancelled", and
 *    the backend keeps the partial variant); pending cancels drop the job.
 */

export type RunJobFn = (
  chatId: ChatId,
  messageId: string,
  override?: { model?: string; promptPresetId?: string },
) => Promise<StreamOutcome>;

// ── Module-level runner registration + pump registry ────────────────────
// Registered once by the app shell; the pump reads the latest binding so a
// stable useCallback runJob is fine.
let registeredRunJob: RunJobFn | null = null;

/** One pump per chat, alive while the chat has pending work. */
const activePumps = new Set<string>();

/** Resolve when the chat is active AND no generation is in flight for it. */
function waitForReady(chatId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const s = useChatStore.getState();
      const idle = !s.generations[chatId]?.isSending;
      if (s.activeChatId === chatId && idle) {
        resolve();
        return true;
      }
      return false;
    };
    if (check()) return;
    const unsub = useChatStore.subscribe(() => {
      if (check()) unsub();
    });
  });
}

function overrideFromJob(job: QueueJob): { model?: string; promptPresetId?: string } {
  const override: { model?: string; promptPresetId?: string } = { model: job.model };
  if (job.promptPresetId) override.promptPresetId = job.promptPresetId;
  return override;
}

/** Pop the first pending job for a chat and mark it running. Returns null if none. */
function takeNextPending(chatId: string): QueueJob | null {
  const state = useGenerationQueueStore.getState();
  const jobs = state.jobsByChat[chatId];
  const next = jobs?.find((j) => j.status === "pending");
  if (!next) return null;
  useGenerationQueueStore.getState().markRunning(next.id);
  return { ...next, status: "running" };
}

/**
 * Run the sequential pump for one chat until its pending queue drains.
 * Self-unregisters from {@link activePumps} on exit.
 */
async function pump(chatId: string): Promise<void> {
  const runJob = registeredRunJob;
  if (!runJob) {
    activePumps.delete(chatId);
    return;
  }
  try {
    for (;;) {
      const store = useGenerationQueueStore.getState();
      if (!store.jobsByChat[chatId]?.some((j) => j.status === "pending")) break;

      // D2 pause + sequentiality: wait until the chat is active and idle.
      await waitForReady(chatId);

      // Atomically take the next pending job (mark running).
      const job = takeNextPending(chatId);
      if (!job) break;

      // The user may have cancelled while we were waiting.
      if (job.status === "cancelled") {
        useGenerationQueueStore.getState().removeJob(job.id);
        continue;
      }

      const outcome = await runJob(chatId as ChatId, job.messageId, overrideFromJob(job));

      // Re-read in case the user cancelled mid-run (status flips to cancelled).
      const fresh = useGenerationQueueStore
        .getState()
        .jobsByChat[chatId]
        ?.find((j) => j.id === job.id);
      if (fresh?.status === "cancelled") {
        useGenerationQueueStore.getState().removeJob(job.id);
        continue;
      }

      switch (outcome) {
        case "done":
          useGenerationQueueStore.getState().markDone(job.id);
          break;
        case "failed":
          useGenerationQueueStore.getState().markFailed(job.id, "generation_failed");
          break;
        case "cancelled":
          // Partial variant (if any) already kept by the backend abort path.
          useGenerationQueueStore.getState().removeJob(job.id);
          break;
      }
    }
  } finally {
    activePumps.delete(chatId);
  }
}

// ── Public module-level API (called by the UI: Q4a button, Q4b manager) ──

/**
 * Enqueue a "Generate more" job against an existing message. Snapshots the
 * model + preset as KEYS (immutable for the job's lifetime); the values
 * resolve live from the target model's overlay at pop (Q1a). Starts the pump
 * if one is not already running for the chat.
 */
export function enqueueGenerateMore(
  messageId: string,
  model: string,
  promptPresetId: string | null,
): void {
  const chatId = useChatStore.getState().activeChatId;
  if (!chatId) return;
  useGenerationQueueStore.getState().enqueueJob({ chatId, messageId, model, promptPresetId });
  if (!activePumps.has(chatId)) {
    activePumps.add(chatId);
    void pump(chatId);
  }
}

/** Cancel a specific job (per-item ×). Running → abort + mark; pending → drop. */
export function cancelQueueJob(jobId: string): void {
  const state = useGenerationQueueStore.getState();
  let chatId: string | null = null;
  let isRunning = false;
  for (const [cid, jobs] of Object.entries(state.jobsByChat)) {
    const job = jobs.find((j) => j.id === jobId);
    if (job) { chatId = cid; isRunning = job.status === "running"; break; }
  }
  if (!chatId) return;
  useGenerationQueueStore.getState().cancelJob(jobId);
  if (isRunning) {
    // D1: abort the in-flight generation; the backend keeps any partial variant.
    useChatStore.getState().abortGeneration(chatId);
  }
}

/** Drop all pending jobs for the active chat (Clear queue). Running continues. */
export function clearQueuePending(): void {
  const chatId = useChatStore.getState().activeChatId;
  if (!chatId) return;
  useGenerationQueueStore.getState().clearPending(chatId);
}

/**
 * Register the controller's `runRegenerateJob` so the pump can drive queued
 * jobs through the existing streaming/reveal machinery. Call once near the app
 * root (the runJob useCallback is stable for the hook's lifetime).
 */
export function useGenerationQueue(runJob: RunJobFn): void {
  useEffect(() => {
    registeredRunJob = runJob;
    return () => {
      // Only clear if still ours (a re-register replaces first).
      if (registeredRunJob === runJob) registeredRunJob = null;
    };
  }, [runJob]);
}
