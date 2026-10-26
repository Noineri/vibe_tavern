/**
 * useAgentController — permission decisions (SC-23f): the decision rides the
 * SAME split-turn answer path as the ask family (no transport fork), flips
 * the optimistic `pendingPermissionAnswer`, and rolls back on a pre-stream
 * failure. The transport enters through the hook's DI seam (a stub — no
 * fetch router, no process-global patches).
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AgentHostTransport } from "../../../lib/agent-host-registry.js";
import type { CopilotAnswerInput } from "../../../api/experience-copilot-api.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { act, renderHook } = await import("@testing-library/react");
const { toast } = await import("sonner");
const toastError = spyOn(toast, "error");
const { i18next } = await import("../../../i18n/i18n.js");
// Key-echo (the controller only translates toasts) — restored in afterAll;
// sibling suites must never see translated strings from this file (R13).
const translate = spyOn(i18next, "t").mockImplementation(
  ((key: string) => String(key)) as typeof i18next.t,
);
const { useAgentController } = await import("./use-agent-controller.js");
const { useAgentTurnStore } = await import("../../../stores/agent-turn-store.js");

const THREAD = "thread-perm";
const PROVIDER = "provider-1";

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

type AnswerAskFn = AgentHostTransport["answerAsk"];
type AnswerAskOpts = Parameters<AnswerAskFn>[2];
const answerAsk = mock(async (..._args: Parameters<AnswerAskFn>) => ({ finishReason: "stop" }));
const sendStream = mock(async (..._args: Parameters<AgentHostTransport["sendStream"]>) => ({ finishReason: "stop" }));
const neverCalled = () => {
  throw new Error("not implemented in this suite");
};
// The hook's transport DI seam — only the answer/send pair is ever called;
// the rest are unreachable stubs (a call is a wiring bug, so they throw).
const stubTransport = {
  sendStream,
  answerAsk,
  getActiveThread: neverCalled,
  listMessages: neverCalled,
  startSession: neverCalled,
  listSessions: neverCalled,
  activateSession: neverCalled,
  renameSession: neverCalled,
  setContextLinks: neverCalled,
  deleteTurn: neverCalled,
  editMessage: neverCalled,
} as unknown as AgentHostTransport;

beforeEach(() => {
  answerAsk.mockReset();
  answerAsk.mockImplementation(() => Promise.resolve({ finishReason: "stop" }));
  sendStream.mockReset();
  sendStream.mockImplementation(() => Promise.resolve({ finishReason: "stop" }));
  toastError.mockClear();
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
});

afterAll(() => {
  translate.mockRestore();
  toastError.mockRestore();
});

describe("useAgentController — permission decisions (SC-23f)", () => {
  test("allow sends { decision: 'allow' } on the answer path and flips the optimistic override", async () => {
    const onTurnSettled = mock();
    let capturedBody!: Record<string, unknown>;
    answerAsk.mockImplementation((_threadId, body, _opts) => {
      capturedBody = body as Record<string, unknown>;
      return Promise.resolve({ finishReason: "stop" });
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER, onTurnSettled }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "allow" });
    });

    expect(answerAsk).toHaveBeenCalledTimes(1);
    expect(sendStream).not.toHaveBeenCalled();
    expect(capturedBody).toEqual({
      answer: { toolCallId: "tc-perm", decision: "allow" },
      providerProfileId: PROVIDER,
    });
    expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "allow" });
    // The ask override is untouched (null) and there is no user bubble.
    expect(result.current.pendingAskAnswer).toBeNull();
    expect(result.current.pendingUserContent).toBe("");
    expect(result.current.isSending).toBe(false);
    expect(onTurnSettled).toHaveBeenCalledTimes(1);
  });

  test("deny sends { decision: 'deny' } and flips to the denied override", async () => {
    let capturedBody!: Record<string, unknown>;
    answerAsk.mockImplementation((_threadId, body, _opts) => {
      capturedBody = body as Record<string, unknown>;
      return Promise.resolve({ finishReason: "stop" });
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "deny" });
    });

    expect(capturedBody).toEqual({
      answer: { toolCallId: "tc-perm", decision: "deny" },
      providerProfileId: PROVIDER,
    });
    expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "deny" });
  });

  test("guards: neither family / a mixed body / a bad decision → no stream call", async () => {
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    // A mixed body matches NEITHER wire-union member (both are `.strict()`).
    const mixed = { decision: "allow", text: "also text" } as unknown as CopilotAnswerInput;
    const badDecision = { decision: "maybe" } as unknown as CopilotAnswerInput;
    await act(async () => {
      await result.current.handleAnswer("tc-perm", {});
      await result.current.handleAnswer("tc-perm", mixed);
      await result.current.handleAnswer("tc-perm", badDecision);
      await result.current.handleAnswer("", { decision: "allow" });
    });

    expect(answerAsk).not.toHaveBeenCalled();
    expect(result.current.pendingPermissionAnswer).toBeNull();
    expect(result.current.pendingAskAnswer).toBeNull();
  });

  test("a PRE-stream failure rolls the permission flip back (the row was never rewritten)", async () => {
    answerAsk.mockImplementation(() => Promise.reject(new Error("validation 400")));
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "allow" });
    });

    expect(result.current.pendingPermissionAnswer).toBeNull();
    expect(result.current.isSending).toBe(false);
    // WAS: the answer failure toasted. NOW (AP-13): the card carries it —
    // no toast, the record carries the category (a plain Error has none).
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.turnFailure).toEqual({ category: "unknown" });
  });

  test("a MID-stream failure keeps the decision (the backend already persisted it)", async () => {
    answerAsk.mockImplementation((_threadId, _body, opts) => {
      opts.onStatus("streaming");
      return Promise.reject(new Error("provider died mid-stream"));
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "deny" });
    });

    expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "deny" });
  });

  test("a live read_message_prompt tool-result upserts the permission activity (same shape as the persisted row)", async () => {
    const d = deferred<{ finishReason: string }>();
    let captured!: AnswerAskOpts;
    answerAsk.mockImplementation((_threadId, _body, opts) => {
      captured = opts;
      return d.promise;
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleAnswer("tc-perm", { decision: "allow" });
      await Promise.resolve();
    });
    await act(async () => {
      captured.onToolCall!({ toolCallId: "tc-perm", toolName: "read_message_prompt", args: { position: 7 } });
      captured.onToolResult!({
        toolCallId: "tc-perm",
        toolName: "read_message_prompt",
        output: {
          status: "awaiting_permission",
          position: 7,
          variantNumber: 2,
          replyFirstLine: "First line",
          promptTokens: 99,
          presetName: "Preset",
        },
        isError: false,
      });
    });

    expect(useAgentTurnStore.getState().getActivities("experience", THREAD)).toEqual([{
      toolCallId: "tc-perm",
      toolName: "read_message_prompt",
      args: { position: 7 },
      status: "done",
      permission: {
        status: "awaiting_permission",
        position: 7,
        variantNumber: 2,
        replyFirstLine: "First line",
        promptTokens: 99,
        presetName: "Preset",
      },
    }]);

    await act(async () => {
      d.resolve({ finishReason: "stop" });
      await pending;
    });
    expect(result.current.isSending).toBe(false);
  });

  test("handleSend clears a stale pendingPermissionAnswer at the next turn start", async () => {
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "allow" });
    });
    expect(result.current.pendingPermissionAnswer).not.toBeNull();

    await act(async () => {
      await result.current.handleSend("next message");
    });
    expect(result.current.pendingPermissionAnswer).toBeNull();
  });

  test("an ask answer through the same path still flips only the ask override", async () => {
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-ask", { text: "Rules" });
    });

    expect(result.current.pendingAskAnswer).toEqual({ toolCallId: "tc-ask", status: "answered", answer: "Rules" });
    expect(result.current.pendingPermissionAnswer).toBeNull();
  });
});
