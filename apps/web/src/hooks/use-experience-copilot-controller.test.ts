/**
 * useExperienceCopilotController — ER-11b send/stream controller.
 *
 * Pins the load-bearing contract: the SSE→turn-store wiring (tool events upsert
 * activities with the SAME shapes the persisted path
 * `extractPersistedExperienceCopilotActivities` produces), `pendingText`
 * accumulation, and the settle (done/cancelled/failed) → `onTurnSettled`
 * signal. The controller calls the real transport against a deterministic
 * fetch/SSE router, so the stream lifecycle is observed at the HTTP boundary.
 */
import { afterAll, beforeEach, describe, test, expect, mock, spyOn } from "bun:test";

import type { CopilotStreamOpts } from "../api/experience-copilot-api.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const { act, renderHook } = await import("@testing-library/react");

// --- fetch-level transport router ---
// The controller imports the real transport. These two spies configure the
// router's SSE response and retain the prior assertions at the HTTP boundary.
const streamExperienceCopilot = mock<typeof import("../api/experience-copilot-api.js")["streamExperienceCopilot"]>(
  () => Promise.resolve({ finishReason: "stop" }),
);
const answerCopilotAsk = mock<typeof import("../api/experience-copilot-api.js")["answerCopilotAsk"]>(
  () => Promise.resolve({ finishReason: "stop" }),
);
const { toast } = await import("sonner");
const toastError = spyOn(toast, "error");
const toastInfo = spyOn(toast, "info");
const { i18next } = await import("../i18n/i18n.js");
// `t` returns a call-site generic ($NoInfer<Ret>) not nameable here, so the key-echo is cast to the exact `t` type.
const translate = spyOn(i18next, "t").mockImplementation(
  ((key: string) => String(key)) as typeof i18next.t,
);

const FINISH_STOP = 'event: finish\ndata: {"finishReason":"stop"}\n\n';
const sseResponse = (events: readonly string[]) =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

const originalFetch = globalThis.fetch;
let fetchBeforeController: typeof globalThis.fetch | null = null;
let requestCount = 0;
let holdStreamOpen = false;
let releaseStream: (() => void) | null = null;
let nextHttpError: { message: string; category?: string } | null = null;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), "http://gateway.test");
  if ((init?.method ?? "GET").toUpperCase() !== "POST" || !/\/api\/experience-copilot\/[^/]+\/stream$/.test(url.pathname)) {
    return new Response(JSON.stringify({ error: { message: `Unhandled fetch: ${url.pathname}` } }), { status: 404 });
  }
  requestCount++;
  const threadId = url.pathname.match(/\/api\/experience-copilot\/([^/]+)\/stream$/)?.[1] ?? "";
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  if (nextHttpError) {
    const error = nextHttpError;
    nextHttpError = null;
    return new Response(JSON.stringify({ error: { message: error.message, details: { category: error.category ?? "unknown" } } }), { status: 400 });
  }
  if (holdStreamOpen) {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The user aborted a request.", "AbortError")), { once: true });
    });
  }
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseEvent(event, data)));
  const opts: CopilotStreamOpts = {
    signal: init?.signal ?? undefined,
    onStatus: () => {},
    onChunk: (delta) => send("text-delta", { delta }),
    onReasoningChunk: (delta) => send("reasoning-delta", { delta }),
    onToolCall: (info) => send("tool-call", info),
    onToolInputStart: (info) => send("tool-input-start", info),
    onToolInputDelta: (info) => send("tool-input-delta", info),
    onToolResult: (info) => send("tool-result", info),
  };
  const completion = "answer" in body
    ? answerCopilotAsk(threadId, body as Parameters<typeof answerCopilotAsk>[1], opts)
    : streamExperienceCopilot(threadId, body as Parameters<typeof streamExperienceCopilot>[1], opts);
  return new Response(new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      releaseStream = () => {
        if (releaseStream === null) return;
        controller.enqueue(encoder.encode(FINISH_STOP));
        controller.close();
        releaseStream = null;
      };
      void completion.then(
        () => { if (!holdStreamOpen) releaseStream?.(); },
        (error) => {
          if (!holdStreamOpen) {
            const provider = error instanceof ProviderStreamError;
            controller.enqueue(encoder.encode(sseEvent("error", {
              message: error instanceof Error ? error.message : "Provider request failed",
              category: provider ? error.category : "unknown",
            })));
            controller.close();
          }
        },
      );
    },
    cancel() { releaseStream = null; },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
});

const { useExperienceCopilotController } = await import("./use-experience-copilot-controller.js");
const { useExperienceCopilotTurnStore } = await import("../stores/experience-copilot-turn-store.js");
const { ProviderStreamError } = await import("../api/provider-stream-error.js");
const { extractPersistedExperienceCopilotActivities, wireToToolSource } = await import(
  "../stores/experience-copilot-turn-store.js"
);
type CopilotTodoItem = import("@vibe-tavern/api-contracts").CopilotTodoItem;

const THREAD = "thread-1";
const PROVIDER = "provider-1";
const routerFetch = Object.assign(fetchRouter, { preconnect: () => {} });

describe("useExperienceCopilotController transport fixture", () => {

/** Minimal controllable promise for driving the stubbed stream to completion. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  if (fetchBeforeController === null) fetchBeforeController = globalThis.fetch;
  globalThis.fetch = routerFetch;
  requestCount = 0;
  holdStreamOpen = false;
  releaseStream = null;
  nextHttpError = null;
  streamExperienceCopilot.mockReset();
  answerCopilotAsk.mockReset();
  toastError.mockClear();
  toastInfo.mockClear();
  useExperienceCopilotTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
});

afterAll(() => {
  // A co-located DOM suite may have installed its own router in beforeAll.
  // Restore the value present before this suite's first test, not a module-load
  // snapshot that would clobber that suite's router.
  if (globalThis.fetch === routerFetch) globalThis.fetch = fetchBeforeController ?? originalFetch;
  translate.mockRestore();
  toastError.mockRestore();
  toastInfo.mockRestore();
});

describe("useExperienceCopilotController — handleSend stream lifecycle", () => {
  test("streams a turn: accumulates pendingText, upserts activity shapes, settles once", async () => {
    const onTurnSettled = mock();
    const d = deferred<{ finishReason: string }>();
    let capturedThreadId!: string;
    let capturedBody!: Record<string, unknown>;
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((threadId, body, opts) => {
      capturedThreadId = threadId;
      capturedBody = body as Record<string, unknown>;
      captured = opts;
      return d.promise;
    });

    // Seed a prior turn's activity so clearTurn's drop is observable.
    useExperienceCopilotTurnStore.getState().upsertActivity(THREAD, {
      toolCallId: "old",
      toolName: "run_test",
      status: "done",
      summary: "stale",
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("  hello world  ");
      await Promise.resolve();
    });

    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    expect(capturedThreadId).toBe(THREAD);
    expect(capturedBody).toEqual({ content: "hello world", providerProfileId: PROVIDER });
    expect(result.current.isSending).toBe(true);
    expect(result.current.pendingText).toBe("");
    // clearTurn dropped the prior turn at start.
    expect(useExperienceCopilotTurnStore.getState().getActivities(THREAD)).toEqual([]);

    // Drive text deltas; pendingText accumulates live.
    await act(async () => {
      captured.onChunk("Hel");
      captured.onChunk("lo");
    });
    expect(result.current.pendingText).toBe("Hello");

    // UX 2026-08-16 remark 4: reasoning-deltas accumulate into pendingReasoning
    // (rendered with the co-author's MessageReasoning minimal pattern).
    await act(async () => {
      captured.onReasoningChunk!("think");
      captured.onReasoningChunk!("ing");
    });
    expect(result.current.pendingReasoning).toBe("thinking");

    // Drive the tool-event wiring: onToolCall captures args + a streaming
    // placeholder, onToolResult finalizes each card with the persisted shape.
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc1", toolName: "write_buffer", args: { buffer: "rules" } });
      captured.onToolResult!({
        toolCallId: "tc1",
        toolName: "write_buffer",
        output: { target: "rules", proposed: "proposed-buffer", summary: "wrote rules" },
        isError: false,
      });
      captured.onToolInputStart!({ toolCallId: "tc2", toolName: "read_skill_file" });
      captured.onToolResult!({
        toolCallId: "tc2",
        toolName: "read_skill_file",
        output: { path: "/skills/combat.md", content: "..." },
        isError: false,
      });
      captured.onToolResult!({
        toolCallId: "tc3",
        toolName: "run_test",
        output: { ok: true, results: [] },
        isError: false,
      });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    expect(result.current.isSending).toBe(false);
    expect(result.current.pendingText).toBe("");
    expect(result.current.pendingReasoning).toBe("");
    expect(onTurnSettled).toHaveBeenCalledTimes(1);

    const activities = useExperienceCopilotTurnStore.getState().getActivities(THREAD);
    expect(activities).toEqual([
      {
        toolCallId: "tc1",
        toolName: "write_buffer",
        args: { buffer: "rules" },
        status: "done",
        summary: "wrote rules",
        target: "rules",
        proposed: "proposed-buffer",
      },
      { toolCallId: "tc2", toolName: "read_skill_file", status: "done", readPath: "/skills/combat.md" },
      { toolCallId: "tc3", toolName: "run_test", status: "done", summary: '{"ok":true,"results":[]}' },
    ]);
  });

  test("passes model through to the stream body", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER, model: "m1" }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual({ content: "hi", providerProfileId: PROVIDER, model: "m1" });
  });

  test("passes testFeedback through to the stream body when provided in opts (ER-14)", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    const feedback = { ok: true, status: "active", revision: 3, legalActionTypes: ["score"], stateSummary: "{}", consoleTail: [] };
    await act(async () => {
      await result.current.handleSend("here is my test result", { testFeedback: feedback });
    });

    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect(body.testFeedback).toEqual(feedback);
    // Omitting testFeedback does not add the field (the undefined guard).
    streamExperienceCopilot.mockClear();
    await act(async () => {
      await result.current.handleSend("plain follow-up");
    });
    expect("testFeedback" in (streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>)).toBe(false);
  });

  test("passes the Try sandbox launch context through to the stream body", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );
    const launchContext = {
      participants: [{ id: "you", label: "You", controller: "human" as const }],
      capabilityGrants: ["participants" as const],
      settings: { rounds: 3 },
      seed: "seed-1",
      humanSeatId: "you",
    };

    await act(async () => {
      await result.current.handleSend("test this", { launchContext });
    });

    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect(body.launchContext).toEqual(launchContext);
  });

  test("write_buffer tool error (isError) marks the card error", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("hi");
      await Promise.resolve();
    });

    await act(async () => {
      captured.onToolResult!({
        toolCallId: "tc1",
        toolName: "write_buffer",
        output: { target: "rules", proposed: "x", summary: "s" },
        isError: true,
      });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const [activity] = useExperienceCopilotTurnStore.getState().getActivities(THREAD);
    expect(activity).toMatchObject({ toolCallId: "tc1", toolName: "write_buffer", status: "error" });
  });
});

describe("useExperienceCopilotController — guards", () => {
  test("empty content → no stream call", async () => {
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("   ");
    });

    expect(streamExperienceCopilot).not.toHaveBeenCalled();
  });

  test("null threadId → no stream call", async () => {
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: null, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    expect(streamExperienceCopilot).not.toHaveBeenCalled();
  });

  test("null providerProfileId → toast + no stream call", async () => {
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: null }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    expect(streamExperienceCopilot).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("message_unavailable_no_provider");
  });
});

describe("useExperienceCopilotController — cancel and error", () => {
  test("handleCancel aborts in-flight stream → cancelled toast, isSending false, settled", async () => {
    const onTurnSettled = mock();
    holdStreamOpen = true;
    const held = deferred<{ finishReason: string }>();
    streamExperienceCopilot.mockImplementation(() => held.promise);

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("hi");
      await Promise.resolve();
    });
    expect(result.current.isSending).toBe(true);

    await act(async () => {
      result.current.handleCancel();
      await pending;
    });

    expect(result.current.isSending).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith("cancelling_generation");
    expect(toastInfo).toHaveBeenCalledWith("generation_cancelled");
  });

  test("provider error → showProviderErrorToast path, isSending false, settled", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockRejectedValue(new ProviderStreamError("boom", "server_error"));

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    expect(result.current.isSending).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    // server_error is a transient category → transient description toast.
    expect(toastError).toHaveBeenCalledWith("boom", { description: "provider_error_transient_desc" });
  });
});

describe("feed wiring (TF-4)", () => {
  test("writes text deltas into ordered feed segments around tool events", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("edit the rules");
      await Promise.resolve();
    });

    await act(async () => {
      captured.onChunk("I'll ");
      captured.onToolInputStart!({ toolCallId: "t1", toolName: "write_buffer" });
      captured.onChunk("Done ");
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const feed = useExperienceCopilotTurnStore.getState().feedByThread[THREAD];
    expect(feed).toHaveLength(3);
    expect(feed[0]).toMatchObject({ kind: "text", text: "I'll ", closed: true });
    expect(feed[1]).toEqual({ kind: "activity", id: "t1" });
    expect(feed[2]).toMatchObject({ kind: "text", text: "Done ", closed: false });
  });

  test("tool-input-start + tool-call + tool-result collapse to one activity ref", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("hi");
      await Promise.resolve();
    });

    await act(async () => {
      captured.onChunk("x");
      captured.onToolInputStart!({ toolCallId: "t1", toolName: "write_buffer" });
      captured.onToolCall!({ toolCallId: "t1", toolName: "write_buffer", args: { buffer: "rules" } });
      captured.onToolResult!({
        toolCallId: "t1",
        toolName: "write_buffer",
        output: { target: "rules", proposed: "v2", summary: "wrote" },
        isError: false,
      });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const feed = useExperienceCopilotTurnStore.getState().feedByThread[THREAD];
    expect(feed.filter((e) => e.kind === "activity").map((e) => e.id)).toEqual(["t1"]);
  });

  test("handleSend clears the prior turn's feed (clearTurn at start)", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    // Seed a prior turn's feed.
    useExperienceCopilotTurnStore.getState().appendTextDelta(THREAD, "old text");
    expect(useExperienceCopilotTurnStore.getState().feedByThread[THREAD]).toHaveLength(1);

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("new turn");
    });

    expect(useExperienceCopilotTurnStore.getState().feedByThread[THREAD]).toBeUndefined();
  });
});

// ─── TAG-7: todo/ask wiring ─────────────────────────────────────────────────

const TODO_ITEMS: CopilotTodoItem[] = [
  { title: "Draft the rules skeleton", status: "completed" },
  { title: "Write the visual header", status: "active" },
  { title: "Wire the score action", status: "pending" },
];

const TODO_ENVELOPE = {
  ok: true,
  items: TODO_ITEMS,
  activeTitle: "Write the visual header",
  remaining: 2,
};

const ASK_ARGS = {
  question: "Which deck suits the tone?",
  options: ["tarot", "playing cards"],
  recommended: "tarot",
};

describe("useExperienceCopilotController — todo wiring (TAG-7)", () => {
  test("a todo tool-call upserts the panel state from its args (full rewrite, immediate); the result envelope confirms + carries the card payload", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan the work");
      await Promise.resolve();
    });

    // Args arrive BEFORE the result — the panel updates immediately.
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_todo", toolName: "todo", args: { items: TODO_ITEMS } });
    });
    expect(useExperienceCopilotTurnStore.getState().getTodo(THREAD)).toEqual(TODO_ITEMS);

    await act(async () => {
      captured.onToolResult!({ toolCallId: "tc_todo", toolName: "todo", output: TODO_ENVELOPE, isError: false });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const [activity] = useExperienceCopilotTurnStore.getState().getActivities(THREAD);
    expect(activity).toEqual({
      toolCallId: "tc_todo",
      toolName: "todo",
      args: { items: TODO_ITEMS },
      status: "done",
      todo: { items: TODO_ITEMS, remaining: 2, activeTitle: "Write the visual header" },
    });
    // The panel still shows the confirmed list after the envelope.
    expect(useExperienceCopilotTurnStore.getState().getTodo(THREAD)).toEqual(TODO_ITEMS);
  });

  test("a failed todo save (ok:false) renders the error card and leaves the panel at the optimistic args value", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan the work");
      await Promise.resolve();
    });

    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_todo", toolName: "todo", args: { items: TODO_ITEMS } });
      captured.onToolResult!({
        toolCallId: "tc_todo",
        toolName: "todo",
        output: { ok: false, error: "db down" },
        isError: false,
      });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const [activity] = useExperienceCopilotTurnStore.getState().getActivities(THREAD);
    expect(activity).toMatchObject({ toolCallId: "tc_todo", toolName: "todo", status: "error" });
    expect(activity!.todo).toBeUndefined();
    // Optimistic panel value retained — the model retries the rewrite next step.
    expect(useExperienceCopilotTurnStore.getState().getTodo(THREAD)).toEqual(TODO_ITEMS);
  });

  test("threadTodo seeds/resets the panel state from the persisted wire; omitted leaves the store untouched", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });

    // renderHook's rerender takes new PROPS (not a new render callback — a
    // zero-arg callback would ignore them and re-run its stale closure), so the
    // threadTodo is threaded through initialProps to make re-seeding drivable.
    const initial = renderHook(
      ({ todo }: { todo: readonly CopilotTodoItem[] }) =>
        useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER, threadTodo: todo }),
      { initialProps: { todo: TODO_ITEMS } },
    );
    expect(useExperienceCopilotTurnStore.getState().getTodo(THREAD)).toEqual(TODO_ITEMS);

    // A refetch producing a new wire todo re-seeds (new array identity).
    const rewritten: CopilotTodoItem[] = [{ title: "Fresh plan", status: "active" }];
    await act(async () => {
      initial.rerender({ todo: rewritten });
    });
    expect(useExperienceCopilotTurnStore.getState().getTodo(THREAD)).toEqual(rewritten);

    // The empty wire todo clears the panel (thread switch to a plan-less thread).
    await act(async () => {
      initial.rerender({ todo: [] });
    });
    expect(useExperienceCopilotTurnStore.getState().getTodo(THREAD)).toEqual([]);

    // Omitted (undefined) — no seeding, the existing state is untouched.
    useExperienceCopilotTurnStore.getState().setTodo(THREAD, TODO_ITEMS);
    initial.unmount();
    const second = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );
    expect(useExperienceCopilotTurnStore.getState().getTodo(THREAD)).toEqual(TODO_ITEMS);
    second.unmount();
  });
});

describe("useExperienceCopilotController — ask wiring (TAG-7)", () => {
  test("an ask tool-call + awaiting marker becomes a done activity carrying the ask state", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("what is unclear?");
      await Promise.resolve();
    });

    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_ask", toolName: "ask_user", args: ASK_ARGS });
      captured.onToolResult!({
        toolCallId: "tc_ask",
        toolName: "ask_user",
        output: { status: "awaiting_answer", ...ASK_ARGS },
        isError: false,
      });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const [activity] = useExperienceCopilotTurnStore.getState().getActivities(THREAD);
    expect(activity).toEqual({
      toolCallId: "tc_ask",
      toolName: "ask_user",
      args: ASK_ARGS,
      status: "done",
      ask: {
        question: "Which deck suits the tone?",
        options: ["tarot", "playing cards"],
        recommended: "tarot",
        status: "awaiting_answer",
      },
    });
  });
});

describe("PARITY: live SSE ingestion === persisted thread-GET hydration (TAG-7 acceptance)", () => {
  test("the same turn fixture produces identical activities and todo panel state through both paths", async () => {
    // The fixture models one real turn: a todo rewrite plus three ask calls
    // (one still awaiting, one answered, one skipped). The SAME data drives
    // (a) the live SSE callbacks and (b) the persisted wire rows through
    // wireToToolSource → extractPersistedExperienceCopilotActivities.
    const carrierCalls = [
      { type: "tool-call", toolCallId: "tc_todo", toolName: "todo", input: { items: TODO_ITEMS } },
      { type: "tool-call", toolCallId: "tc_a1", toolName: "ask_user", input: ASK_ARGS },
      { type: "tool-call", toolCallId: "tc_a2", toolName: "ask_user", input: ASK_ARGS },
      { type: "tool-call", toolCallId: "tc_a3", toolName: "ask_user", input: ASK_ARGS },
    ];
    const wireMessage = (over: Record<string, unknown>) => ({
      id: "w",
      threadId: THREAD,
      role: "assistant",
      content: "",
      toolCallsJson: null,
      toolCallId: null,
      createdAt: "",
      ...over,
    });
    const wireRows = [
      wireMessage({ id: "u1", role: "user", content: "plan and ask" }),
      wireMessage({ id: "carrier", toolCallsJson: JSON.stringify(carrierCalls) }),
      wireMessage({ id: "t_todo", role: "tool", toolCallId: "tc_todo", content: JSON.stringify({ toolName: "todo", output: TODO_ENVELOPE }) }),
      wireMessage({ id: "t_a1", role: "tool", toolCallId: "tc_a1", content: JSON.stringify({ toolName: "ask_user", output: { status: "awaiting_answer", ...ASK_ARGS } }) }),
      wireMessage({ id: "t_a2", role: "tool", toolCallId: "tc_a2", content: JSON.stringify({ toolName: "ask_user", output: { status: "answered", answer: "tarot, definitely" } }) }),
      wireMessage({ id: "t_a3", role: "tool", toolCallId: "tc_a3", content: JSON.stringify({ toolName: "ask_user", output: { status: "skipped" } }) }),
      wireMessage({ id: "a1", role: "assistant", content: "working on it" }),
    ];

    // (b) persisted path FIRST (pure — no hook needed): hydrate as the shell
    // would after settle+refetch, then seed the panel from the thread wire.
    const persistedActivities = extractPersistedExperienceCopilotActivities(wireRows.map(wireToToolSource));
    useExperienceCopilotTurnStore.getState().setTodo(THREAD, TODO_ITEMS); // thread.todo seed
    const persistedTodo = useExperienceCopilotTurnStore.getState().getTodo(THREAD);

    // (a) live path: reset, then drive the SAME turn through the SSE callbacks.
    useExperienceCopilotTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan and ask");
      await Promise.resolve();
    });
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_todo", toolName: "todo", args: { items: TODO_ITEMS } });
      captured.onToolResult!({ toolCallId: "tc_todo", toolName: "todo", output: TODO_ENVELOPE, isError: false });
      captured.onToolCall!({ toolCallId: "tc_a1", toolName: "ask_user", args: ASK_ARGS });
      captured.onToolResult!({ toolCallId: "tc_a1", toolName: "ask_user", output: { status: "awaiting_answer", ...ASK_ARGS }, isError: false });
      captured.onToolCall!({ toolCallId: "tc_a2", toolName: "ask_user", args: ASK_ARGS });
      captured.onToolResult!({ toolCallId: "tc_a2", toolName: "ask_user", output: { status: "answered", answer: "tarot, definitely" }, isError: false });
      captured.onToolCall!({ toolCallId: "tc_a3", toolName: "ask_user", args: ASK_ARGS });
      captured.onToolResult!({ toolCallId: "tc_a3", toolName: "ask_user", output: { status: "skipped" }, isError: false });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const liveActivities = useExperienceCopilotTurnStore.getState().getActivities(THREAD);
    const liveTodo = useExperienceCopilotTurnStore.getState().getTodo(THREAD);

    // THE parity claim: field-for-field identical activities (todo/ask
    // payloads, args, status) and identical panel state from the two sources.
    expect(liveActivities).toEqual(persistedActivities);
    expect(liveTodo).toEqual(persistedTodo);
    // And the payloads specifically (not just the envelope):
    expect(liveActivities.map((a) => a.todo ?? a.ask)).toEqual(
      persistedActivities.map((a) => a.todo ?? a.ask),
    );
  });
});

describe("useExperienceCopilotController — handleAnswer (TAG-9 split-turn)", () => {
  test("posts the answer body (no content), flips the card optimistically, settles", async () => {
    const onTurnSettled = mock();
    const d = deferred<{ finishReason: string }>();
    let capturedThreadId!: string;
    let capturedBody!: Record<string, unknown>;
    answerCopilotAsk.mockImplementation((threadId, body, _opts) => {
      capturedThreadId = threadId;
      capturedBody = body as Record<string, unknown>;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleAnswer("tc-ask", { text: "  Rules, please  " }, {
        rules: "rules-code",
        visual: "visual-src",
        step: "rules",
        launchContext: {
          participants: [{ id: "you", label: "You", controller: "human" }],
          capabilityGrants: [],
          settings: {},
        },
      });
      await Promise.resolve();
    });

    expect(answerCopilotAsk).toHaveBeenCalledTimes(1);
    expect(streamExperienceCopilot).not.toHaveBeenCalled();
    expect(capturedThreadId).toBe(THREAD);
    // The answer body carries NO content (style B — no new user row) and the
    // draft buffers flow through like a normal send.
    expect(capturedBody).toEqual({
      answer: { toolCallId: "tc-ask", text: "Rules, please" },
      providerProfileId: PROVIDER,
      rules: "rules-code",
      visual: "visual-src",
      step: "rules",
      launchContext: {
        participants: [{ id: "you", label: "You", controller: "human" }],
        capabilityGrants: [],
        settings: {},
      },
    });
    expect(result.current.isSending).toBe(true);
    // The optimistic flip: the card shows the resolution immediately.
    expect(result.current.pendingAskAnswer).toEqual({
      toolCallId: "tc-ask",
      status: "answered",
      answer: "Rules, please",
    });
    // No optimistic USER bubble — the answer has no user row.
    expect(result.current.pendingUserContent).toBe("");

    await act(async () => {
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    expect(result.current.isSending).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    // The override LINGERS after settle (it matches the persisted row the
    // refetch shows) — cleared only by the next turn / thread switch.
    expect(result.current.pendingAskAnswer).toEqual({
      toolCallId: "tc-ask",
      status: "answered",
      answer: "Rules, please",
    });
  });

  test("skip sends { skipped: true } and flips to the skipped state", async () => {
    let capturedBody!: Record<string, unknown>;
    answerCopilotAsk.mockImplementation((_threadId, body, _opts) => {
      capturedBody = body as Record<string, unknown>;
      return Promise.resolve({ finishReason: "stop" });
    });
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-ask", { skipped: true });
    });

    expect(capturedBody).toEqual({
      answer: { toolCallId: "tc-ask", skipped: true },
      providerProfileId: PROVIDER,
    });
    expect(result.current.pendingAskAnswer).toEqual({ toolCallId: "tc-ask", status: "skipped" });
  });

  test("guards: both text+skipped / neither / empty text → no stream call", async () => {
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-ask", { text: "x", skipped: true });
      await result.current.handleAnswer("tc-ask", {});
      await result.current.handleAnswer("tc-ask", { text: "   " });
    });

    expect(answerCopilotAsk).not.toHaveBeenCalled();
    expect(result.current.pendingAskAnswer).toBeNull();
  });

  test("a PRE-stream failure rolls the optimistic flip back (the row was never rewritten)", async () => {
    const onTurnSettled = mock();
    nextHttpError = { message: "validation 400" };
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-ask", { text: "Rules" });
    });

    expect(result.current.pendingAskAnswer).toBeNull();
    expect(result.current.isSending).toBe(false);
    expect(toastError).toHaveBeenCalled();
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
  });

  test("a MID-stream failure keeps the resolution (the backend already persisted it)", async () => {
    answerCopilotAsk.mockImplementation((_threadId, _body, opts) => {
      opts.onStatus("streaming");
      return Promise.reject(new Error("provider died mid-stream"));
    });
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-ask", { text: "Rules" });
    });

    expect(result.current.pendingAskAnswer).toEqual({
      toolCallId: "tc-ask",
      status: "answered",
      answer: "Rules",
    });
  });

  test("handleSend clears a stale pendingAskAnswer at the next turn start", async () => {
    answerCopilotAsk.mockResolvedValue({ finishReason: "stop" });
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useExperienceCopilotController({ threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-ask", { text: "Rules" });
    });
    expect(result.current.pendingAskAnswer).not.toBeNull();

    await act(async () => {
      await result.current.handleSend("next message");
    });
    expect(result.current.pendingAskAnswer).toBeNull();
  });
});
});
