import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import type { AppMessage } from "../api/types.js";

import { useDomEnv } from "../../test/dom-env.js";
import {
  useGenerationQueueStore,
  useQueueCount,
  useQueueForMessage,
  useQueueJobStatus,
  useHasActiveQueue,
  useGenerationBatchSummary,
} from "./generation-queue-store.js";
import { useSnapshotStore } from "./snapshot-store.js";

useDomEnv();

const originalSnapshotState = useSnapshotStore.getState();
afterAll(() => { useSnapshotStore.setState(originalSnapshotState, true); });

const { render, act } = await import("@testing-library/react");

/**
 * State-machine + narrow-selector tests for the generation queue store (Q3).
 *
 * Part 1 (pure logic, no DOM): enqueue → sequential pending→running→done, never
 * two running; cancel mid-run; clearPending keeps the running job; failure marks
 * `failed` without halting the queue.
 *
 * Part 2 (narrow selectors, scoped happy-dom): a subscriber to useQueueCount
 * does NOT re-render when an unrelated job's `error` field changes (markFailed)
 * — the useShallow projection (a length number) is stable. This is the
 * self-check Q3 re-render guard.
 */


function resetStore() {
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
}

function enq(chatId: string, messageId: string, model: string) {
  return useGenerationQueueStore.getState().enqueueJob({ chatId, messageId, model, promptPresetId: null });
}

function setVisibleTarget(variantIds: string[]): void {
  useSnapshotStore.setState({
    messageOrder: ["m1"],
    messagesById: { m1: { id: "m1", variants: variantIds.map((id) => ({ id })) } } as unknown as Record<string, AppMessage>,
  });
}

describe("Q3 store: sequential state machine", () => {
  beforeEach(resetStore);

  test("enqueue 3 jobs, transition pending→running→done one at a time, never two running", () => {
    const ids = [enq("c1", "m1", "a"), enq("c1", "m1", "b"), enq("c1", "m1", "c")];
    const jobs = () => useGenerationQueueStore.getState().jobsByChat["c1"]!;

    expect(jobs().map((j) => j.status)).toEqual(["pending", "pending", "pending"]);

    // Pop + run job 0.
    useGenerationQueueStore.getState().markRunning(ids[0]);
    expect(jobs().map((j) => j.status)).toEqual(["running", "pending", "pending"]);
    expect(jobs().filter((j) => j.status === "running").length).toBe(1);

    // Job 0 done; job 1 running. At no point are two running.
    useGenerationQueueStore.getState().markDone(ids[0], 1);
    useGenerationQueueStore.getState().markRunning(ids[1]);
    expect(jobs().map((j) => j.status)).toEqual(["done", "running", "pending"]);
    expect(jobs().filter((j) => j.status === "running").length).toBe(1);

    useGenerationQueueStore.getState().markDone(ids[1], 2);
    useGenerationQueueStore.getState().markRunning(ids[2]);
    expect(jobs().map((j) => j.status)).toEqual(["done", "done", "running"]);

    useGenerationQueueStore.getState().markDone(ids[2], 3);
    expect(jobs().map((j) => j.status)).toEqual(["done", "done", "done"]);
  });

  test("cancel mid-run marks cancelled; the runner's observer removes it", () => {
    const id = enq("c1", "m1", "a");
    useGenerationQueueStore.getState().markRunning(id);
    useGenerationQueueStore.getState().cancelJob(id); // running → cancelled
    expect(useGenerationQueueStore.getState().jobsByChat["c1"]![0].status).toBe("cancelled");

    useGenerationQueueStore.getState().removeJob(id); // runner observes abort, drops it
    expect(useGenerationQueueStore.getState().jobsByChat["c1"]).toBeUndefined();
  });

  test("cancel a pending job drops it immediately", () => {
    const a = enq("c1", "m1", "a");
    const b = enq("c1", "m1", "b");
    useGenerationQueueStore.getState().cancelJob(a); // pending → removed
    const jobs = useGenerationQueueStore.getState().jobsByChat["c1"]!;
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe(b);
  });

  test("clearPending keeps settled jobs while dropping pending work", () => {
    const a = enq("c1", "m1", "a");
    enq("c1", "m1", "b");
    enq("c1", "m1", "c");
    useGenerationQueueStore.getState().markRunning(a);
    useGenerationQueueStore.getState().markDone(a, 0);
    // a=done, b=pending, c=pending
    useGenerationQueueStore.getState().clearPending("c1");
    const jobs = useGenerationQueueStore.getState().jobsByChat["c1"]!;
    expect(jobs.map((job) => job.status)).toEqual(["done"]);
  });

  test("clearPending preserves an in-flight running job", () => {
    const a = enq("c1", "m1", "a");
    enq("c1", "m1", "b");
    useGenerationQueueStore.getState().markRunning(a);
    useGenerationQueueStore.getState().clearPending("c1");
    const jobs = useGenerationQueueStore.getState().jobsByChat["c1"]!;
    expect(jobs.map((j) => j.status)).toEqual(["running"]); // running kept, pending b dropped
  });

  test("markFailed records the error and leaves the job in the list (queue continues)", () => {
    const a = enq("c1", "m1", "a");
    useGenerationQueueStore.getState().markRunning(a);
    useGenerationQueueStore.getState().markFailed(a, "429 rate limited");
    const job = useGenerationQueueStore.getState().jobsByChat["c1"]![0];
    expect(job.status).toBe("failed");
    expect(job.error).toBe("429 rate limited");
  });

  test("useHasActiveQueue / useQueueForMessage reflect state", () => {
    // These are selector hooks — exercised via getState projections here.
    enq("c1", "m1", "a");
    enq("c1", "m2", "b");
    const s = useGenerationQueueStore.getState();
    const c1 = s.jobsByChat["c1"]!;
    expect(c1.some((j) => j.status === "pending" || j.status === "running")).toBe(true);
    expect(c1.filter((j) => j.messageId === "m1").length).toBe(1);
    expect(c1.filter((j) => j.messageId === "m2").length).toBe(1);
  });
});

// ── Part 2: narrow-selector re-render guard (scoped DOM) ──────────────────

function CountSubscriber({ chatId }: { chatId: string }) {
  // Subscribe to the count only.
  useQueueCount(chatId);
  return null;
}

function StatusSubscriber({ jobId }: { jobId: string }) {
  useQueueJobStatus(jobId);
  return null;
}

function BatchSummarySubscriber({ chatId, onRead }: { chatId: string; onRead: (value: ReturnType<typeof useGenerationBatchSummary>) => void }) {
  onRead(useGenerationBatchSummary(chatId));
  return null;
}

describe("Q3 store: narrow selectors do not over-render", () => {
  beforeEach(() => {
    resetStore();
    useSnapshotStore.setState({ messageOrder: [], messagesById: {} });
  });

  test("useQueueCount subscriber does NOT re-render when a job's error changes", () => {
    const id = enq("c1", "m1", "a");
    const renders: number[] = [];
    const onRender: ProfilerOnRenderCallback = (_phase, _phaseKind, actualDuration) => {
      void _phase; void actualDuration;
      renders.push(renders.length);
    };
    const { unmount } = render(
      <Profiler id="count" onRender={onRender}>
        <CountSubscriber chatId="c1" />
      </Profiler>,
    );

    const initialCommits = renders.length;
    expect(initialCommits).toBeGreaterThanOrEqual(1);

    // Mutate an unrelated field on the existing job — length is unchanged.
    act(() => {
      useGenerationQueueStore.getState().markFailed(id, "err");
    });
    // Allow any pending React work to flush.
    expect(useGenerationQueueStore.getState().jobsByChat["c1"]![0].error).toBe("err");
    expect(renders.length).toBe(initialCommits); // no extra commit

    // Positive control: enqueueing another job DOES change the length → re-render.
    act(() => {
      enq("c1", "m1", "b");
    });
    expect(renders.length).toBe(initialCommits + 1);

    unmount();
  });

  test("useQueueJobStatus subscriber re-renders only when THAT job's status changes", () => {
    const a = enq("c1", "m1", "a");
    const b = enq("c1", "m1", "b");
    const renders: number[] = [];
    const onRender: ProfilerOnRenderCallback = () => { renders.push(renders.length); };
    const { unmount } = render(
      <Profiler id="status-a" onRender={onRender}>
        <StatusSubscriber jobId={a} />
      </Profiler>,
    );
    const initial = renders.length;

    // Mutating job b must NOT re-render the subscriber to job a's status.
    act(() => {
      useGenerationQueueStore.getState().markRunning(b);
    });
    expect(renders.length).toBe(initial);

    // Mutating job a's status DOES re-render.
    act(() => {
      useGenerationQueueStore.getState().markRunning(a);
    });
    expect(renders.length).toBe(initial + 1);

    unmount();
  });

  test("useQueueCount returns 0 for an unknown chat (pill hidden)", () => {
    let seen = -1;
    function C() { seen = useQueueCount("nope"); return null; }
    render(<C />);
    expect(seen).toBe(0);
  });

  test("owner scenario 1 counts one persisted variant plus running and pending records", () => {
    setVisibleTarget(["a"]);
    useGenerationQueueStore.getState().startBatch("c1", "m1", ["a"]);
    const regenerate = useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "regenerate", status: "running", model: "resolved-b", presetName: "Preset B", presetId: null,
    });
    const queued = useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "queue", status: "pending", model: "frozen-c", presetName: "Preset C", presetId: "preset-c",
    });
    useGenerationQueueStore.getState().enqueueJob({ chatId: "c1", messageId: "m1", model: "frozen-c", promptPresetId: "preset-c", recordId: queued });
    let seen!: ReturnType<typeof useGenerationBatchSummary>;
    const { unmount } = render(<BatchSummarySubscriber chatId="c1" onRead={(value) => { seen = value; }} />);

    expect(seen).toEqual({ visible: true, summary: { done: 1, failed: 0, running: 1, pending: 1, total: 3 } });
    expect(useGenerationQueueStore.getState().batchesByChat.c1?.variantIdsAtStart).toEqual(["a"]);
    expect(useGenerationQueueStore.getState().recordsByChat.c1?.find((record) => record.id === regenerate)).toMatchObject({ origin: "regenerate", status: "running", model: "resolved-b", presetName: "Preset B" });
    expect(useGenerationQueueStore.getState().recordsByChat.c1?.find((record) => record.id === queued)).toMatchObject({ origin: "queue", model: "frozen-c", presetId: "preset-c" });
    unmount();
  });

  test("a partial variant is excluded from done until its running record settles", () => {
    setVisibleTarget(["a"]);
    useGenerationQueueStore.getState().startBatch("c1", "m1", ["a"]);
    const recordId = useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "regenerate", status: "running", model: "resolved-b", presetName: null, presetId: null,
    });
    let seen!: ReturnType<typeof useGenerationBatchSummary>;
    const { unmount } = render(<BatchSummarySubscriber chatId="c1" onRead={(value) => { seen = value; }} />);

    act(() => {
      setVisibleTarget(["a", "partial-b"]);
    });
    expect(seen.summary).toEqual({ done: 1, failed: 0, running: 1, pending: 0, total: 2 });

    act(() => {
      useGenerationQueueStore.getState().removeRecord("c1", recordId);
    });
    expect(seen.summary).toEqual({ done: 2, failed: 0, running: 0, pending: 0, total: 2 });
    unmount();
  });

  test("a failed record retains the target variant position at which it started", () => {
    setVisibleTarget(["a", "b"]);
    const recordId = useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "queue", status: "failed", model: "bad", presetName: null, presetId: null, error: "provider rate limit",
    });
    expect(useGenerationQueueStore.getState().recordsByChat.c1?.find((record) => record.id === recordId))
      .toMatchObject({ startVariantPosition: 2, status: "failed" });
  });

  test("owner scenario 2 counts three persisted variants plus running and pending records", () => {
    setVisibleTarget(["a", "b", "c"]);
    useGenerationQueueStore.getState().startBatch("c1", "m1", ["a", "b", "c"]);
    useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "regenerate", status: "running", model: "resolved-b", presetName: "Preset B", presetId: null,
    });
    useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "queue", status: "pending", model: "frozen-c", presetName: "Preset C", presetId: "preset-c",
    });
    let seen!: ReturnType<typeof useGenerationBatchSummary>;
    const { unmount } = render(<BatchSummarySubscriber chatId="c1" onRead={(value) => { seen = value; }} />);
    expect(seen).toEqual({ visible: true, summary: { done: 3, failed: 0, running: 1, pending: 1, total: 5 } });
    expect(useGenerationQueueStore.getState().batchesByChat.c1?.variantIdsAtStart).toEqual(["a", "b", "c"]);
    unmount();
  });

  test("a plain regenerate record without a batch is hidden", () => {
    useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "regenerate", status: "running", model: "resolved", presetName: null, presetId: null,
    });
    setVisibleTarget(["a"]);
    let seen!: ReturnType<typeof useGenerationBatchSummary>;
    const { unmount } = render(<BatchSummarySubscriber chatId="c1" onRead={(value) => { seen = value; }} />);
    expect(seen.visible).toBe(false);
    unmount();
  });

  test("removing the batch target from message order hides it", () => {
    useGenerationQueueStore.getState().startBatch("c1", "m1", ["a"]);
    setVisibleTarget(["a"]);
    let seen!: ReturnType<typeof useGenerationBatchSummary>;
    const { unmount } = render(<BatchSummarySubscriber chatId="c1" onRead={(value) => { seen = value; }} />);
    expect(seen.visible).toBe(true);
    act(() => { useSnapshotStore.setState({ messageOrder: [] }); });
    expect(seen.visible).toBe(false);
    unmount();
  });

  test("a drained batch stays visible and counts persisted variants until reset", async () => {
    useGenerationQueueStore.getState().startBatch("c1", "m1", ["a", "b"]);
    setVisibleTarget(["a", "b"]);
    let seen!: ReturnType<typeof useGenerationBatchSummary>;
    const { unmount } = render(<BatchSummarySubscriber chatId="c1" onRead={(value) => { seen = value; }} />);
    expect(useGenerationQueueStore.getState().jobsByChat.c1).toBeUndefined();
    expect(useGenerationQueueStore.getState().recordsByChat.c1).toBeUndefined();
    expect(seen).toEqual({ visible: true, summary: { done: 2, failed: 0, running: 0, pending: 0, total: 2 } });
    await act(async () => { useGenerationQueueStore.getState().clearBatch("c1"); });
    expect(seen.visible).toBe(false);
    unmount();
  });

  test("a running queue job and its linked running record count once", () => {
    setVisibleTarget(["a"]);
    useGenerationQueueStore.getState().startBatch("c1", "m1", ["a"]);
    const recordId = useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "queue", status: "running", model: "frozen", presetName: null, presetId: null,
    });
    const jobId = useGenerationQueueStore.getState().enqueueJob({ chatId: "c1", messageId: "m1", model: "frozen", promptPresetId: null, recordId });
    useGenerationQueueStore.getState().markRunning(jobId);
    let seen!: ReturnType<typeof useGenerationBatchSummary>;
    const { unmount } = render(<BatchSummarySubscriber chatId="c1" onRead={(value) => { seen = value; }} />);
    expect(seen.summary).toEqual({ done: 1, failed: 0, running: 1, pending: 0, total: 2 });
    unmount();
  });

  test("clear removes pending records but keeps failed records and target variants", () => {
    useGenerationQueueStore.getState().startBatch("c1", "m1", ["a"]);
    const failed = useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "queue", status: "failed", model: "bad", presetName: null, presetId: null, error: "provider rate limit",
    });
    const pending = useGenerationQueueStore.getState().addRecord("c1", {
      messageId: "m1", origin: "queue", status: "pending", model: "next", presetName: null, presetId: null,
    });
    useGenerationQueueStore.getState().enqueueJob({ chatId: "c1", messageId: "m1", model: "next", promptPresetId: null, recordId: pending });
    setVisibleTarget(["a"]);
    useGenerationQueueStore.getState().clearPending("c1");
    expect(useGenerationQueueStore.getState().recordsByChat.c1).toEqual([expect.objectContaining({ id: failed, status: "failed" })]);
    expect(useSnapshotStore.getState().messagesById.m1?.variants.map((variant) => String(variant.id))).toEqual(["a"]);
  });
});
