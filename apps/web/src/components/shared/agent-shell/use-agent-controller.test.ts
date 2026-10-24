/**
 * useExperienceCopilotController — ER-11b send/stream controller.
 *
 * Pins the load-bearing contract: the SSE→turn-store wiring (tool events upsert
 * activities with the SAME shapes the persisted path
 * `extractPersistedAgentActivities` produces), `pendingText`
 * accumulation, and the settle (done/cancelled/failed) → `onTurnSettled`
 * signal. The controller calls the real transport against a deterministic
 * fetch/SSE router, so the stream lifecycle is observed at the HTTP boundary.
 */
import { afterAll, beforeEach, describe, test, expect, mock, spyOn } from "bun:test";

import type { CopilotStreamOpts } from "../../../api/experience-copilot-api.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { act, renderHook } = await import("@testing-library/react");

// --- fetch-level transport router ---
// The controller imports the real transport. These two spies configure the
// router's SSE response and retain the prior assertions at the HTTP boundary.
const streamExperienceCopilot = mock<typeof import("../../../api/experience-copilot-api.js")["streamExperienceCopilot"]>(
  () => Promise.resolve({ finishReason: "stop" }),
);
const answerCopilotAsk = mock<typeof import("../../../api/experience-copilot-api.js")["answerCopilotAsk"]>(
  () => Promise.resolve({ finishReason: "stop" }),
);
const { toast } = await import("sonner");
const toastError = spyOn(toast, "error");
const toastInfo = spyOn(toast, "info");
const { i18next } = await import("../../../i18n/i18n.js");
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
// AP-10: every `POST .../turns/delete` the router answers, in order (the
// controller's delete path is observed at the HTTP boundary like the stream).
let deleteCalls: Array<{ threadId: string; body: Record<string, unknown> }> = [];
// AP-10: holding the delete response open keeps the delete in-flight so the
// mid-run flags are observable, not raced (the stream side's holdStreamOpen).
let holdDeleteOpen = false;
let releaseDelete: (() => void) | null = null;
let holdStreamOpen = false;
let releaseStream: (() => void) | null = null;
let nextHttpError: { message: string; category?: string } | null = null;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), "http://gateway.test");
  // AP-10: the turn-delete REST call — captured like the stream, answered
  // with the AP-8 wire result (the deleted user row echoes when included).
  const deleteMatch = url.pathname.match(/\/api\/experience-copilot\/([^/]+)\/turns\/delete$/);
  if ((init?.method ?? "GET").toUpperCase() === "POST" && deleteMatch) {
    requestCount++;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    deleteCalls.push({ threadId: deleteMatch[1] ?? "", body });
    if (nextHttpError) {
      const error = nextHttpError;
      nextHttpError = null;
      return new Response(JSON.stringify({ error: { message: error.message, details: { category: error.category ?? "unknown" } } }), { status: 400 });
    }
    if (holdDeleteOpen) {
      return new Promise<Response>((resolve) => {
        releaseDelete = () => {
          releaseDelete = null;
          const messageId = String(body.messageId ?? "");
          resolve(new Response(JSON.stringify({
            deletedMessageIds: [messageId],
            deletedUserMessageId: body.includeUserMessage === true ? messageId : null,
          }), { status: 200 }));
        };
      });
    }
    const messageId = String(body.messageId ?? "");
    return new Response(JSON.stringify({
      deletedMessageIds: [messageId],
      deletedUserMessageId: body.includeUserMessage === true ? messageId : null,
    }), { status: 200 });
  }
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

const { useAgentController } = await import("./use-agent-controller.js");
const { useAgentTurnStore } = await import("../../../stores/agent-turn-store.js");
const { ProviderStreamError } = await import("../../../api/provider-stream-error.js");
// AS-6c-i: the controller receives its transport through args — this wires
// the REAL experience client fns exactly as the experience host's descriptor
// does, so the stream lifecycle stays observed at the HTTP boundary (the
// fetch router above); only the sendStream/answerAsk pair is ever called.
const experienceCopilotApi = await import("../../../api/experience-copilot-api.js");
const { scriptOwnerId } = await import("../../../lib/agent-host-registry.js");
const testTransport = {
  sendStream: experienceCopilotApi.streamExperienceCopilot,
  answerAsk: experienceCopilotApi.answerCopilotAsk,
  // AP-10: the turn-delete REST call — the real client fn, so the delete
  // path stays observed at the HTTP boundary (the fetch router above).
  deleteTurn: experienceCopilotApi.deleteCopilotTurn,
  // SC-0c repair (assertions unchanged): the seam takes the typed owner
  // now — mapped back exactly as the experience host does.
  getActiveThread: (owner: Parameters<typeof scriptOwnerId>[0]) => experienceCopilotApi.getExperienceCopilotActive(scriptOwnerId(owner)),
  listMessages: experienceCopilotApi.listExperienceCopilotMessages,
  startSession: (owner: Parameters<typeof scriptOwnerId>[0], title?: string) => experienceCopilotApi.startExperienceCopilotSession(scriptOwnerId(owner), title),
  listSessions: (owner: Parameters<typeof scriptOwnerId>[0]) => experienceCopilotApi.listExperienceCopilotSessions(scriptOwnerId(owner)),
  activateSession: experienceCopilotApi.activateExperienceCopilotSession,
  renameSession: experienceCopilotApi.renameExperienceCopilotSession,
  setContextLinks: experienceCopilotApi.setExperienceCopilotContextLinks,
};
const { extractPersistedAgentActivities, wireToToolSource } = await import(
  "../../../stores/agent-turn-store.js"
);
type CopilotTodoItem = import("@vibe-tavern/api-contracts").CopilotTodoItem;

const THREAD = "thread-1";
const PROVIDER = "provider-1";
const routerFetch = Object.assign(fetchRouter, { preconnect: () => {} });

// CA-4e3: the one draft attachment fixture + its `toSendAttachment`
// projection (the ONE send mapper — tokenCount preserved, no extra fields).
const attachmentFile: import("@vibe-tavern/domain").Attachment = {
  id: "att1", assetId: "asset-1", name: "notes.md", type: "file",
  mimeType: "text/markdown", sizeBytes: 12, tokenCount: 42,
};
const sentAttachment = {
  id: "att1", assetId: "asset-1", name: "notes.md", type: "file",
  mimeType: "text/markdown", sizeBytes: 12, tokenCount: 42,
};

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
  deleteCalls = [];
  holdDeleteOpen = false;
  releaseDelete = null;
  holdStreamOpen = false;
  releaseStream = null;
  nextHttpError = null;
  streamExperienceCopilot.mockReset();
  answerCopilotAsk.mockReset();
  toastError.mockClear();
  toastInfo.mockClear();
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
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

describe("useExperienceCopilotController — attachments (CA-4e3)", () => {
  test("the send body carries the composer's attachments through the ONE send mapper", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("read this", { attachments: [attachmentFile] });
    });

    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect(body.content).toBe("read this");
    expect(body.attachments).toEqual([sentAttachment]);
  });

  test("an attachment-only send omits content and still streams", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("   ", { attachments: [attachmentFile] });
    });

    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect("content" in body).toBe(false);
    expect(body.attachments).toEqual([sentAttachment]);
  });

  test("no text and no attachments stays the silent guard", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("   ", {});
    });

    expect(streamExperienceCopilot).not.toHaveBeenCalled();
  });

  test("pendingUserAttachments is set during the stream and cleared after", async () => {
    const d = deferred<{ finishReason: string }>();
    streamExperienceCopilot.mockImplementation(() => d.promise);
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("hello", { attachments: [attachmentFile] });
      await Promise.resolve();
    });
    expect(result.current.pendingUserAttachments).toEqual([attachmentFile]);

    await act(async () => {
      d.resolve({ finishReason: "stop" });
      await pending;
    });
    expect(result.current.pendingUserAttachments).toEqual([]);
  });

  test("an answer never carries attachments even when the options hold them", async () => {
    answerCopilotAsk.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc1", { text: "ans" }, { attachments: [attachmentFile] });
    });

    expect(answerCopilotAsk).toHaveBeenCalledTimes(1);
    const body = answerCopilotAsk.mock.calls[0][1] as Record<string, unknown>;
    expect("attachments" in body).toBe(false);
  });
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
    useAgentTurnStore.getState().upsertActivity("experience", THREAD, {
      toolCallId: "old",
      toolName: "run_test",
      status: "done",
      summary: "stale",
    });

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
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
    expect(useAgentTurnStore.getState().getActivities("experience", THREAD)).toEqual([]);

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

    const activities = useAgentTurnStore.getState().getActivities("experience", THREAD);
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, model: "m1" }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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

  test("passes review metadata and independent false saved flags on send and ask answers", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    answerCopilotAsk.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );
    const reviewSnapshot = { targets: [] };
    await act(async () => { await result.current.handleSend("review", { reviewSnapshot, rulesSaved: false, visualSaved: true }); });
    expect(streamExperienceCopilot.mock.calls[0]![1]).toMatchObject({ reviewSnapshot, rulesSaved: false, visualSaved: true });
    await act(async () => { await result.current.handleAnswer("ask-1", { text: "yes" }, { reviewSnapshot, rulesSaved: false, visualSaved: false }); });
    expect(answerCopilotAsk.mock.calls[0]![1]).toMatchObject({ reviewSnapshot, rulesSaved: false, visualSaved: false });
  });

  test("passes the Try sandbox launch context through to the stream body", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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

    const [activity] = useAgentTurnStore.getState().getActivities("experience", THREAD);
    expect(activity).toMatchObject({ toolCallId: "tc1", toolName: "write_buffer", status: "error" });
  });
});

describe("useExperienceCopilotController — guards", () => {
  test("empty content → no stream call", async () => {
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("   ");
    });

    expect(streamExperienceCopilot).not.toHaveBeenCalled();
  });

  test("null threadId → no stream call", async () => {
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: null, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    expect(streamExperienceCopilot).not.toHaveBeenCalled();
  });

  test("null providerProfileId → toast + no stream call", async () => {
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: null }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    expect(result.current.isSending).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    // WAS (AP-10 basis): server_error toasted with the transient description
    // (`toastError("boom", { description: "provider_error_transient_desc" })`).
    // NOW (AP-13): the card carries the failure — no toast, the record
    // carries the category (the description key derives from it).
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.turnFailure).toEqual({ category: "server_error" });
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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

    const feed = useAgentTurnStore.getState().feedByThread[THREAD];
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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

    const feed = useAgentTurnStore.getState().feedByThread[THREAD];
    expect(feed.filter((e) => e.kind === "activity").map((e) => e.id)).toEqual(["t1"]);
  });

  test("handleSend clears the prior turn's feed (clearTurn at start)", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    // Seed a prior turn's feed.
    useAgentTurnStore.getState().appendTextDelta("experience", THREAD, "old text");
    expect(useAgentTurnStore.getState().feedByThread[THREAD]).toHaveLength(1);

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("new turn");
    });

    expect(useAgentTurnStore.getState().feedByThread[THREAD]).toBeUndefined();
  });
});

// ─── TAG-7 (restored PM-7) / PM-6: todo, plan + ask wiring ─────────────

/** TAG-7 (restored PM-7): the session-scoped checklist items — the shapes
 *  the restored `todo` tool produces (object root `{items}`). */
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

/** PM-6: a `plan` tool-call's args (object root `{plan}`) and its success
 *  result envelope — the shapes createAgentPlanTools produces. */
const PLAN_ARGS = {
  plan: {
    goal: "Ship the visual",
    constraints: ["Keep it focused"],
    tasks: [
      { id: "task_1", title: "Draft the rules skeleton", body: "", status: "completed" },
      { id: "task_2", title: "Write the visual header", body: "Use the shared frame", status: "active" },
      { id: "task_3", title: "Wire the score action", body: "", status: "pending" },
    ],
  },
};

const PLAN_ENVELOPE = {
  ok: true,
  activeTitle: "Write the visual header",
  remaining: 2,
};

const ASK_ARGS = {
  question: "Which deck suits the tone?",
  options: ["tarot", "playing cards"],
  recommended: "tarot",
};

describe("useExperienceCopilotController — todo wiring (TAG-7, restored PM-7)", () => {
  test("a todo tool-call upserts the panel state from its args (full rewrite, immediate); the result envelope confirms + carries the card payload", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan this");
      await Promise.resolve();
    });

    // Args arrive BEFORE the result — the panel updates immediately.
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_todo", toolName: "todo", args: { items: TODO_ITEMS } });
    });
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(TODO_ITEMS);

    await act(async () => {
      captured.onToolResult!({ toolCallId: "tc_todo", toolName: "todo", output: TODO_ENVELOPE, isError: false });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const [activity] = useAgentTurnStore.getState().getActivities("experience", THREAD);
    expect(activity).toEqual({
      toolCallId: "tc_todo",
      toolName: "todo",
      args: { items: TODO_ITEMS },
      status: "done",
      todo: { items: TODO_ITEMS, remaining: 2, activeTitle: "Write the visual header" },
    });
    // The panel still shows the confirmed list after the envelope.
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(TODO_ITEMS);
  });

  test("a failed todo save (ok:false) renders the error card and leaves the panel at the optimistic args value", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan this");
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

    const [activity] = useAgentTurnStore.getState().getActivities("experience", THREAD);
    expect(activity).toMatchObject({ toolCallId: "tc_todo", toolName: "todo", status: "error" });
    expect(activity!.todo).toBeUndefined();
    // Optimistic panel value retained — the model retries the rewrite next step.
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(TODO_ITEMS);
  });

  test("threadTodo seeds/resets the panel state from the persisted wire; omitted leaves the store untouched", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });

    // renderHook's rerender takes new PROPS (not a new render callback — a
    // zero-arg callback would ignore them and re-run its stale closure), so the
    // threadTodo is threaded through initialProps to make re-seeding drivable.
    const initial = renderHook(
      ({ todo }: { todo: readonly CopilotTodoItem[] }) =>
        useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, threadTodo: todo }),
      { initialProps: { todo: TODO_ITEMS } },
    );
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(TODO_ITEMS);

    // A refetch producing a new wire todo re-seeds (new array identity).
    const rewritten: CopilotTodoItem[] = [{ title: "Fresh plan", status: "active" }];
    await act(async () => {
      initial.rerender({ todo: rewritten });
    });
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(rewritten);

    // The empty wire todo clears the panel (thread switch to a plan-less thread).
    await act(async () => {
      initial.rerender({ todo: [] });
    });
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual([]);

    // Omitted (undefined) — no seeding, the existing state is untouched.
    useAgentTurnStore.getState().setTodo("experience", THREAD, TODO_ITEMS);
    initial.unmount();
    const second = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(TODO_ITEMS);
    second.unmount();
  });

  test("PM-7 coexistence: a todo event routes to the turn store while a plan event routes to applyPlanToolResult", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });
    const applyPlanToolResult = mock();

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, applyPlanToolResult }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("both tools");
      await Promise.resolve();
    });

    // ONE turn, both mechanics: the todo call rewrites the session checklist…
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_todo", toolName: "todo", args: { items: TODO_ITEMS } });
    });
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(TODO_ITEMS);
    // …and the plan call routes its carrier args + envelope to the hook seam.
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_plan", toolName: "plan", args: PLAN_ARGS });
      captured.onToolResult!({ toolCallId: "tc_plan", toolName: "plan", output: PLAN_ENVELOPE, isError: false });
      captured.onToolResult!({ toolCallId: "tc_todo", toolName: "todo", output: TODO_ENVELOPE, isError: false });
      d.resolve({ finishReason: "stop" });
      await pending;
    });
    expect(applyPlanToolResult).toHaveBeenCalledWith(PLAN_ARGS, PLAN_ENVELOPE);
    // The two states never crossed: the todo envelope confirmed the store list…
    expect(useAgentTurnStore.getState().getTodo("experience", THREAD)).toEqual(TODO_ITEMS);
    // …and the plan activity carries no todo payload (and vice versa).
    const activities = useAgentTurnStore.getState().getActivities("experience", THREAD);
    expect(activities.find((a) => a.toolName === "todo")!.todo).toBeDefined();
    expect(activities.find((a) => a.toolName === "plan")!.todo).toBeUndefined();
  });
});

describe("useExperienceCopilotController — plan wiring (PM-6)", () => {
  test("a plan tool result routes the carrier args + envelope to applyPlanToolResult and renders the done card (no raw summary)", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });
    const applyPlanToolResult = mock();

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, applyPlanToolResult }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan the work");
      await Promise.resolve();
    });

    // The tool-call event leaves the streaming placeholder carrying the args
    // (the same carrier the ask_user branch reads back).
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_plan", toolName: "plan", args: PLAN_ARGS });
    });
    await act(async () => {
      captured.onToolResult!({ toolCallId: "tc_plan", toolName: "plan", output: PLAN_ENVELOPE, isError: false });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    // The hook seam: args + envelope routed together (the shell passes
    // useAgentPlan's applyToolResult — the cache replace itself is pinned in
    // use-agent-plan.test.tsx).
    expect(applyPlanToolResult).toHaveBeenCalledWith(PLAN_ARGS, PLAN_ENVELOPE);

    const [activity] = useAgentTurnStore.getState().getActivities("experience", THREAD);
    expect(activity).toEqual({
      toolCallId: "tc_plan",
      toolName: "plan",
      args: PLAN_ARGS,
      status: "done",
    });
  });

  test("a failed plan save (ok:false) renders the error card with the raw content; the args still route to the hook seam", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });
    const applyPlanToolResult = mock();

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, applyPlanToolResult }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan the work");
      await Promise.resolve();
    });

    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_plan", toolName: "plan", args: PLAN_ARGS });
      captured.onToolResult!({
        toolCallId: "tc_plan",
        toolName: "plan",
        output: { ok: false, error: "db down" },
        isError: false,
      });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    // The hook decides whether to apply (ok:false → no replace); the routing
    // itself still fires with the same args + envelope pair.
    expect(applyPlanToolResult).toHaveBeenCalledWith(PLAN_ARGS, { ok: false, error: "db down" });

    const [activity] = useAgentTurnStore.getState().getActivities("experience", THREAD);
    expect(activity).toMatchObject({ toolCallId: "tc_plan", toolName: "plan", status: "error" });
    expect(activity!.summary).toBe(JSON.stringify({ ok: false, error: "db down" }));
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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

    const [activity] = useAgentTurnStore.getState().getActivities("experience", THREAD);
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
  test("the same turn fixture produces identical activities through both paths", async () => {
    // The fixture models one real turn: a plan rewrite plus three ask calls
    // (one still awaiting, one answered, one skipped). The SAME data drives
    // (a) the live SSE callbacks and (b) the persisted wire rows through
    // wireToToolSource → extractPersistedAgentActivities.
    const carrierCalls = [
      { type: "tool-call", toolCallId: "tc_plan", toolName: "plan", input: PLAN_ARGS },
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
      reasoning: null,
      reasoningDurationMs: null,
      createdAt: "",
      ...over,
    });
    const wireRows = [
      wireMessage({ id: "u1", role: "user", content: "plan and ask" }),
      wireMessage({ id: "carrier", toolCallsJson: JSON.stringify(carrierCalls) }),
      wireMessage({ id: "t_plan", role: "tool", toolCallId: "tc_plan", content: JSON.stringify({ toolName: "plan", output: PLAN_ENVELOPE }) }),
      wireMessage({ id: "t_a1", role: "tool", toolCallId: "tc_a1", content: JSON.stringify({ toolName: "ask_user", output: { status: "awaiting_answer", ...ASK_ARGS } }) }),
      wireMessage({ id: "t_a2", role: "tool", toolCallId: "tc_a2", content: JSON.stringify({ toolName: "ask_user", output: { status: "answered", answer: "tarot, definitely" } }) }),
      wireMessage({ id: "t_a3", role: "tool", toolCallId: "tc_a3", content: JSON.stringify({ toolName: "ask_user", output: { status: "skipped" } }) }),
      wireMessage({ id: "a1", role: "assistant", content: "working on it" }),
    ];

    // (b) persisted path FIRST (pure — no hook needed): hydrate as the shell
    // would after settle+refetch.
    const persistedActivities = extractPersistedAgentActivities(wireRows.map(wireToToolSource));

    // (a) live path: reset, then drive the SAME turn through the SSE callbacks.
    useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
    const d = deferred<{ finishReason: string }>();
    let captured!: CopilotStreamOpts;
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend("plan and ask");
      await Promise.resolve();
    });
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc_plan", toolName: "plan", args: PLAN_ARGS });
      captured.onToolResult!({ toolCallId: "tc_plan", toolName: "plan", output: PLAN_ENVELOPE, isError: false });
      captured.onToolCall!({ toolCallId: "tc_a1", toolName: "ask_user", args: ASK_ARGS });
      captured.onToolResult!({ toolCallId: "tc_a1", toolName: "ask_user", output: { status: "awaiting_answer", ...ASK_ARGS }, isError: false });
      captured.onToolCall!({ toolCallId: "tc_a2", toolName: "ask_user", args: ASK_ARGS });
      captured.onToolResult!({ toolCallId: "tc_a2", toolName: "ask_user", output: { status: "answered", answer: "tarot, definitely" }, isError: false });
      captured.onToolCall!({ toolCallId: "tc_a3", toolName: "ask_user", args: ASK_ARGS });
      captured.onToolResult!({ toolCallId: "tc_a3", toolName: "ask_user", output: { status: "skipped" }, isError: false });
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    const liveActivities = useAgentTurnStore.getState().getActivities("experience", THREAD);

    // THE parity claim: field-for-field identical activities (plan/ask
    // payloads, args, status) from the two sources. The plan row is the twin
    // guard: the store's ok-flag check and the controller's
    // parseAgentPlanToolResult must agree on the SAME envelope.
    expect(liveActivities).toEqual(persistedActivities);
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-ask", { text: "Rules" });
    });

    expect(result.current.pendingAskAnswer).toBeNull();
    expect(result.current.isSending).toBe(false);
    // WAS: the answer failure toasted. NOW (AP-13): the card carries it —
    // no toast, the record carries the category (the 400 carried none).
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.turnFailure).toEqual({ category: "unknown" });
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
  });

  test("a MID-stream failure keeps the resolution (the backend already persisted it)", async () => {
    answerCopilotAsk.mockImplementation((_threadId, _body, opts) => {
      opts.onStatus("streaming");
      return Promise.reject(new Error("provider died mid-stream"));
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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

describe("useExperienceCopilotController — handleRegenerate (AP-10)", () => {
  test("sends { regenerate: true } with NO content, no user bubble, settles once", async () => {
    const onTurnSettled = mock();
    // Deferred (the send test's pattern): the held stream keeps the turn
    // in-flight so the mid-run flags are observable, not raced.
    const d = deferred<{ finishReason: string }>();
    streamExperienceCopilot.mockImplementation(() => d.promise);
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleRegenerate();
      await Promise.resolve();
    });

    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    expect(streamExperienceCopilot.mock.calls[0][0]).toBe(THREAD);
    // The regenerate mode rides the stream body with NO content row.
    expect(streamExperienceCopilot.mock.calls[0][1]).toEqual({ regenerate: true, providerProfileId: PROVIDER });
    expect(result.current.isSending).toBe(true);
    expect(result.current.pendingUserContent).toBe("");

    await act(async () => {
      d.resolve({ finishReason: "stop" });
      await pending;
    });

    expect(result.current.isSending).toBe(false);
    expect(result.current.pendingText).toBe("");
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(true);
  });

  test("a regenerate carries no attachments even when the options hold them (CA-4e3: not a content send)", async () => {
    const d = deferred<{ finishReason: string }>();
    streamExperienceCopilot.mockImplementation(() => d.promise);
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleRegenerate({ attachments: [attachmentFile] });
      await Promise.resolve();
    });

    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect("attachments" in body).toBe(false);
    expect("content" in body).toBe(false);

    await act(async () => {
      d.resolve({ finishReason: "stop" });
      await pending;
    });
  });

  test("marks the turn regenerating while in flight, clears on settle; sends and answers never mark", async () => {
    // AP-29 follow-up 2: the list hides the replaced turn while this flag
    // holds — it must cover exactly the regenerate flight (a send opens a
    // fresh turn with its optimistic user row instead, an answer continues
    // its turn's caption, so neither may ever set it).
    const d = deferred<{ finishReason: string }>();
    streamExperienceCopilot.mockImplementation(() => d.promise);
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    expect(result.current.isRegenerating).toBe(false);
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleRegenerate();
      await Promise.resolve();
    });
    expect(result.current.isRegenerating).toBe(true);
    await act(async () => {
      d.resolve({ finishReason: "stop" });
      await pending;
    });
    expect(result.current.isRegenerating).toBe(false);

    // A failed regenerate clears the flag too (the settle refetch shows
    // the stored truth — the old turn — again, not a blank).
    nextHttpError = { message: "folded into a digest" };
    await act(async () => {
      await result.current.handleRegenerate();
    });
    expect(result.current.isRegenerating).toBe(false);

    // Sends and ask-answer continuations never mark (a send opens a fresh
    // turn with its optimistic user row, an answer joins its turn).
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    answerCopilotAsk.mockResolvedValue({ finishReason: "stop" });
    await act(async () => {
      await result.current.handleSend("hi");
    });
    expect(result.current.isRegenerating).toBe(false);
    await act(async () => {
      await result.current.handleAnswer("tc-1", { text: "yes" });
    });
    expect(result.current.isRegenerating).toBe(false);
  });

  test("passes model and send options through, still with no content", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, model: "m1" }),
    );

    await act(async () => {
      await result.current.handleRegenerate({ rules: "live-rules" });
    });

    expect(streamExperienceCopilot.mock.calls[0][1]).toEqual({
      regenerate: true,
      providerProfileId: PROVIDER,
      model: "m1",
      rules: "live-rules",
    });
  });

  test("handleSend and handleAnswer never set the regenerate flag", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    answerCopilotAsk.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });
    expect("regenerate" in (streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>)).toBe(false);

    await act(async () => {
      await result.current.handleAnswer("tc-1", { text: "yes" });
    });
    expect("regenerate" in (answerCopilotAsk.mock.calls[0][1] as Record<string, unknown>)).toBe(false);
  });

  test("a pre-stream failure records the failure, clears the flags, settles false", async () => {
    const onTurnSettled = mock();
    nextHttpError = { message: "nothing to regenerate" };
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(result.current.isSending).toBe(false);
    expect(result.current.pendingUserContent).toBe("");
    // WAS: the regenerate failure toasted. NOW (AP-13): the card carries
    // it — no toast, the record carries the category (the 400 carried none).
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.turnFailure).toEqual({ category: "unknown" });
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(false);
  });

  test("silent guards: missing thread or provider make no stream call", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result: noThread } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: null, providerProfileId: PROVIDER, onTurnSettled }),
    );
    await act(async () => {
      await noThread.current.handleRegenerate();
    });
    expect(streamExperienceCopilot).not.toHaveBeenCalled();
    expect(onTurnSettled).not.toHaveBeenCalled();

    const { result: noProvider } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: null, onTurnSettled }),
    );
    await act(async () => {
      await noProvider.current.handleRegenerate();
    });
    expect(streamExperienceCopilot).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("message_unavailable_no_provider");
  });
});

describe("useExperienceCopilotController — handleDeleteTurn (AP-10)", () => {
  test("deletes via the transport, settles true, leaves the live store alone", async () => {
    const onTurnSettled = mock();
    // Hold the delete response open (the stream suite's holdStreamOpen
    // pattern): the mid-run flags are observable, not raced.
    holdDeleteOpen = true;
    // Seed a live activity: the delete must NOT optimistically remove it.
    useAgentTurnStore.getState().upsertActivity("experience", THREAD, {
      toolCallId: "live",
      toolName: "run_test",
      status: "done",
      summary: "keep",
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleDeleteTurn("msg-7", true);
      await Promise.resolve();
    });

    expect(deleteCalls).toEqual([{ threadId: THREAD, body: { messageId: "msg-7", includeUserMessage: true } }]);
    expect(result.current.isSending).toBe(true);
    // No optimistic user bubble and no pending text on a delete.
    expect(result.current.pendingUserContent).toBe("");

    await act(async () => {
      releaseDelete?.();
      await pending;
    });

    expect(result.current.isSending).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(true);
    // NO optimistic removal — the server owns the turn resolution, so the
    // live store is byte-identical (the settle refetch replaces the feed).
    expect(useAgentTurnStore.getState().getActivities("experience", THREAD)).toEqual([
      { toolCallId: "live", toolName: "run_test", status: "done", summary: "keep" },
    ]);
  });

  test("a failed delete toasts, settles false, leaves the feed untouched", async () => {
    const onTurnSettled = mock();
    nextHttpError = { message: "digest floor" };
    useAgentTurnStore.getState().upsertActivity("experience", THREAD, {
      toolCallId: "live",
      toolName: "run_test",
      status: "done",
      summary: "keep",
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleDeleteTurn("msg-7", false);
    });

    expect(deleteCalls).toHaveLength(1);
    expect(result.current.isSending).toBe(false);
    expect(toastError).toHaveBeenCalled();
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(false);
    expect(useAgentTurnStore.getState().getActivities("experience", THREAD)).toEqual([
      { toolCallId: "live", toolName: "run_test", status: "done", summary: "keep" },
    ]);
  });

  test("silent guards: missing thread and an in-flight turn make no call", async () => {
    const onTurnSettled = mock();
    const { result: noThread } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: null, providerProfileId: PROVIDER, onTurnSettled }),
    );
    await act(async () => {
      await noThread.current.handleDeleteTurn("msg-7", true);
    });
    expect(deleteCalls).toHaveLength(0);
    expect(onTurnSettled).not.toHaveBeenCalled();

    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.handleDeleteTurn("msg-1", true);
      // The first delete holds the in-flight flag — the second is a no-op.
      await result.current.handleDeleteTurn("msg-2", true);
      await first;
    });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({ threadId: THREAD, body: { messageId: "msg-1", includeUserMessage: true } });
  });
});

describe("useExperienceCopilotController — handleEditLast (AP-10)", () => {
  const msg = (id: string, role: string, attachments?: import("@vibe-tavern/domain").Attachment[]): ExperienceCopilotMessageWire => ({
    id,
    threadId: THREAD,
    role,
    content: `${role} ${id}`,
    ...(attachments !== undefined ? { attachments } : {}),
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "2026-10-22T00:00:00.000Z",
  });

  test("deletes the LAST user exchange, then sends the new content", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const threadMessages = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant")];
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled, threadMessages }),
    );

    await act(async () => {
      await result.current.handleEditLast("  revised question  ");
    });

    // Edit-last resolves the last USER row (u2 — not the trailing assistant
    // row) and deletes it WITH its user row.
    expect(deleteCalls).toEqual([{ threadId: THREAD, body: { messageId: "u2", includeUserMessage: true, keepAttachmentFiles: true } }]);
    // ...then sends the trimmed content as a fresh turn.
    expect(streamExperienceCopilot).toHaveBeenCalledTimes(1);
    expect(streamExperienceCopilot.mock.calls[0][1]).toEqual({ content: "revised question", providerProfileId: PROVIDER });
    // One settle for the whole edit (the send's) — no intermediate delete
    // settle, so the shell refetches once.
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(true);
  });

  test("a failed delete never sends: the error surfaces, the feed is untouched", async () => {
    const onTurnSettled = mock();
    nextHttpError = { message: "digest floor" };
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const threadMessages = [msg("u1", "user"), msg("a1", "assistant")];
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled, threadMessages }),
    );

    await act(async () => {
      await result.current.handleEditLast("revised");
    });

    expect(deleteCalls).toHaveLength(1);
    expect(streamExperienceCopilot).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(false);
  });

  test("no user row: surfaces the error without deleting or sending", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const threadMessages = [msg("a1", "assistant")];
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled, threadMessages }),
    );

    await act(async () => {
      await result.current.handleEditLast("revised");
    });

    expect(deleteCalls).toHaveLength(0);
    expect(streamExperienceCopilot).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(false);
  });

  test("the row's attachments ride the resend mapped through toSendAttachment (CA-4e3)", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const file = attachmentFile;
    const threadMessages = [msg("u1", "user", [file]), msg("a1", "assistant")];
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled, threadMessages }),
    );

    await act(async () => {
      await result.current.handleEditLast("revised");
    });

    expect(deleteCalls).toEqual([{ threadId: THREAD, body: { messageId: "u1", includeUserMessage: true, keepAttachmentFiles: true } }]);
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect(body.attachments).toEqual([sentAttachment]);
    expect(body.content).toBe("revised");
  });

  test("empty content with an attachment row still edits (CA-4e3)", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const threadMessages = [msg("u1", "user", [attachmentFile]), msg("a1", "assistant")];
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled, threadMessages }),
    );

    await act(async () => {
      await result.current.handleEditLast("   ");
    });

    expect(deleteCalls).toHaveLength(1);
    const body = streamExperienceCopilot.mock.calls[0][1] as Record<string, unknown>;
    expect("content" in body).toBe(false);
    expect(body.attachments).toEqual([sentAttachment]);
  });

  test("empty content is a silent guard (no delete, no send, no settle)", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const threadMessages = [msg("u1", "user"), msg("a1", "assistant")];
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled, threadMessages }),
    );

    await act(async () => {
      await result.current.handleEditLast("   ");
    });

    expect(deleteCalls).toHaveLength(0);
    expect(streamExperienceCopilot).not.toHaveBeenCalled();
    expect(onTurnSettled).not.toHaveBeenCalled();
  });
});

describe("useExperienceCopilotController — turn failure record (AP-13)", () => {
  test("a failed send records the failure — no toast (the card carries it)", async () => {
    const onTurnSettled = mock();
    streamExperienceCopilot.mockRejectedValue(new ProviderStreamError("boom", "server_error"));
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    // WAS (AP-10): a category-aware error toast
    // (`toastError("boom", { description: "provider_error_transient_desc" })`).
    // NOW: the turn failure owns the surface — the card renders the
    // category description, so the toast is gone.
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.turnFailure).toEqual({ category: "server_error" });
    expect(result.current.isSending).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
    expect(onTurnSettled).toHaveBeenCalledWith(false);
  });

  test("a non-provider send failure records { category: 'unknown' }", async () => {
    streamExperienceCopilot.mockRejectedValue(new Error("socket hung up"));
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.turnFailure).toEqual({ category: "unknown" });
  });

  test("a successful turn clears the recorded failure", async () => {
    streamExperienceCopilot.mockRejectedValueOnce(new ProviderStreamError("boom", "rate_limit"));
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });
    expect(result.current.turnFailure).toEqual({ category: "rate_limit" });

    await act(async () => {
      await result.current.handleSend("hi again");
    });
    expect(result.current.turnFailure).toBeNull();
  });

  test("a regenerate failure REPLACES the recorded failure", async () => {
    streamExperienceCopilot.mockRejectedValueOnce(new ProviderStreamError("bad key", "authentication"));
    streamExperienceCopilot.mockRejectedValueOnce(new ProviderStreamError("slow", "rate_limit"));
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });
    expect(result.current.turnFailure).toEqual({ category: "authentication" });

    await act(async () => {
      await result.current.handleRegenerate();
    });
    // The retry's failure replaces the card's content (same slot, new category).
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.turnFailure).toEqual({ category: "rate_limit" });
  });

  test("failure state is keyed per thread (a switch shows that thread's failure or none)", async () => {
    streamExperienceCopilot.mockRejectedValue(new ProviderStreamError("boom", "timeout"));
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useAgentController({ transport: testTransport, kind: "experience", threadId, providerProfileId: PROVIDER }),
      { initialProps: { threadId: THREAD as string | null } },
    );

    await act(async () => {
      await result.current.handleSend("hi");
    });
    expect(result.current.turnFailure).toEqual({ category: "timeout" });

    await act(async () => {
      rerender({ threadId: "thread-2" });
    });
    expect(result.current.turnFailure).toBeNull();

    await act(async () => {
      rerender({ threadId: THREAD });
    });
    expect(result.current.turnFailure).toEqual({ category: "timeout" });
  });

  test("cancel records no failure (quiet info toast only)", async () => {
    holdStreamOpen = true;
    streamExperienceCopilot.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useAgentController({ transport: testTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
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

    expect(result.current.turnFailure).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("generation_cancelled");
  });
});

describe("useExperienceCopilotController — regenerate hide set (AP-29 follow-up 3)", () => {
  const wire = (id: string, role: "user" | "assistant", content: string): ExperienceCopilotMessageWire => ({
    id,
    threadId: THREAD,
    role,
    content,
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "2026-10-23T00:00:00.000Z",
  });
  const oldThread = [
    wire("u0", "user", "earlier"),
    wire("a0", "assistant", "earlier answer"),
    wire("u1", "user", "go"),
    wire("c1", "assistant", ""),
    wire("a1", "assistant", "old reply"),
  ];
  const newThread = [
    wire("u0", "user", "earlier"),
    wire("a0", "assistant", "earlier answer"),
    wire("u1", "user", "go"),
    wire("a9", "assistant", "new reply"),
  ];

  function renderWithMessages(threadMessages: ExperienceCopilotMessageWire[], threadId: string | null = THREAD) {
    return renderHook(
      ({ msgs, tid }: { msgs: ExperienceCopilotMessageWire[]; tid: string | null }) =>
        useAgentController({ transport: testTransport, kind: "experience", threadId: tid, providerProfileId: PROVIDER, threadMessages: msgs }),
      { initialProps: { msgs: threadMessages, tid: threadId } },
    );
  }

  test("success keeps the hide set past the settle; the refetch without the rows empties it", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result, rerender } = renderWithMessages(oldThread);

    expect(result.current.hiddenRegeneratedIds).toBeNull();
    await act(async () => {
      await result.current.handleRegenerate();
    });

    // The flag drops at the settle (the follow-up 2 contract, unchanged) but
    // the SET keeps the replaced rows' ids — the pre-refetch messages still
    // hold them, so the feed hides exactly these rows, never a flash.
    expect(result.current.isRegenerating).toBe(false);
    expect(result.current.hiddenRegeneratedIds).toEqual(["c1", "a1"]);

    // The settle → refetch window: the same rows still present, the set holds.
    await act(async () => {
      rerender({ msgs: oldThread, tid: THREAD });
    });
    expect(result.current.hiddenRegeneratedIds).toEqual(["c1", "a1"]);

    // The refetch lands the new turn (the server deleted the replaced rows):
    // no recorded id remains, so the set empties — the natural end.
    await act(async () => {
      rerender({ msgs: newThread, tid: THREAD });
    });
    expect(result.current.hiddenRegeneratedIds).toBeNull();
  });

  test("failure drops the hide at once, so the refetch shows the stored old turn", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderWithMessages(oldThread);

    await act(async () => {
      await result.current.handleRegenerate();
    });
    expect(result.current.hiddenRegeneratedIds).toEqual(["c1", "a1"]);

    nextHttpError = { message: "nothing to regenerate" };
    await act(async () => {
      await result.current.handleRegenerate();
    });

    expect(result.current.isRegenerating).toBe(false);
    expect(result.current.hiddenRegeneratedIds).toBeNull();
    expect(result.current.turnFailure).toEqual({ category: "unknown" });
  });

  test("cancel drops the hide at once", async () => {
    holdStreamOpen = true;
    streamExperienceCopilot.mockImplementation(() => new Promise(() => {}));
    const { result } = renderWithMessages(oldThread);

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleRegenerate();
      await Promise.resolve();
    });
    expect(result.current.isRegenerating).toBe(true);
    expect(result.current.hiddenRegeneratedIds).toEqual(["c1", "a1"]);

    await act(async () => {
      result.current.handleCancel();
      await pending;
    });

    expect(result.current.isRegenerating).toBe(false);
    expect(result.current.hiddenRegeneratedIds).toBeNull();
  });

  test("a later regenerate starts with a fresh set", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result, rerender } = renderWithMessages(oldThread);

    await act(async () => {
      await result.current.handleRegenerate();
    });
    expect(result.current.hiddenRegeneratedIds).toEqual(["c1", "a1"]);

    // The thread moved on (two more turns since); the retry records only the
    // rows its own hide covers — never the stale set.
    const laterThread = [...oldThread, wire("u2", "user", "again"), wire("a2", "assistant", "second old reply")];
    await act(async () => {
      rerender({ msgs: laterThread, tid: THREAD });
    });
    await act(async () => {
      await result.current.handleRegenerate();
    });
    expect(result.current.hiddenRegeneratedIds).toEqual(["a2"]);
  });

  test("a thread switch drops the hide", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    const { result, rerender } = renderWithMessages(oldThread);

    await act(async () => {
      await result.current.handleRegenerate();
    });
    expect(result.current.hiddenRegeneratedIds).toEqual(["c1", "a1"]);

    await act(async () => {
      rerender({ msgs: oldThread, tid: "thread-2" });
    });
    expect(result.current.hiddenRegeneratedIds).toBeNull();
  });

  test("sends and ask-answer continuations never set the hide", async () => {
    streamExperienceCopilot.mockResolvedValue({ finishReason: "stop" });
    answerCopilotAsk.mockResolvedValue({ finishReason: "stop" });
    const { result } = renderWithMessages(oldThread);

    await act(async () => {
      await result.current.handleSend("hi");
    });
    expect(result.current.hiddenRegeneratedIds).toBeNull();
    await act(async () => {
      await result.current.handleAnswer("tc-1", { text: "yes" });
    });
    expect(result.current.hiddenRegeneratedIds).toBeNull();
  });
});
});
