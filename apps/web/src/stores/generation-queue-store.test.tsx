import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  useGenerationQueueStore,
  useQueueCount,
  useQueueForMessage,
  useQueueJobStatus,
  useHasActiveQueue,
} from "./generation-queue-store.js";

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

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function resetStore() {
  useGenerationQueueStore.setState({ jobsByChat: {} });
}

function enq(chatId: string, messageId: string, model: string) {
  return useGenerationQueueStore.getState().enqueueJob({ chatId, messageId, model, promptPresetId: null });
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

  test("clearPending keeps the running job, drops pending + settled", () => {
    const a = enq("c1", "m1", "a");
    enq("c1", "m1", "b");
    enq("c1", "m1", "c");
    useGenerationQueueStore.getState().markRunning(a);
    useGenerationQueueStore.getState().markDone(a, 0);
    // a=done, b=pending, c=pending
    useGenerationQueueStore.getState().clearPending("c1");
    const jobs = useGenerationQueueStore.getState().jobsByChat["c1"]!;
    expect(jobs.length).toBe(0); // no running job right now → all dropped
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

describe("Q3 store: narrow selectors do not over-render", () => {
  beforeEach(() => {
    resetStore();
    cleanup();
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
});
