/**
 * useExperienceCopilotController — ER-11b send/stream controller.
 *
 * Pins the load-bearing contract: the SSE→turn-store wiring (tool events upsert
 * activities with the SAME shapes the persisted path
 * `extractPersistedExperienceCopilotActivities` produces), `pendingText`
 * accumulation, and the settle (done/cancelled/failed) → `onTurnSettled`
 * signal. `streamExperienceCopilot` is stubbed and its callbacks driven
 * manually, so the stream lifecycle is observable without a server.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import type { CopilotStreamOpts } from "../api/experience-copilot-api.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

// --- transport + i18n + toast stubs (SAFE mock.module pattern) ---
const streamExperienceCopilot = mock<typeof import("../api/experience-copilot-api.js")["streamExperienceCopilot"]>(
  () => Promise.resolve({ finishReason: "stop" }),
);
const toastError = mock();
const toastInfo = mock();

const realCopilotApi = await import("../api/experience-copilot-api.js");
const realLocaleHelpers = await import("../i18n/locale-helpers.js");

mock.module("../api/experience-copilot-api.js", () => ({
  ...realCopilotApi,
  streamExperienceCopilot,
}));

mock.module("../i18n/locale-helpers.js", () => ({
  ...realLocaleHelpers,
  getT: () => (key: string) => key,
}));

mock.module("sonner", () => ({
  toast: {
    error: toastError,
    info: toastInfo,
    success: mock(),
    message: mock(),
    warning: mock(),
    loading: mock(),
    custom: mock(),
    promise: mock(),
    dismiss: mock(),
  },
  Toaster: () => null,
}));

const { useExperienceCopilotController } = await import("./use-experience-copilot-controller.js");
const { useExperienceCopilotTurnStore } = await import("../stores/experience-copilot-turn-store.js");
const { ProviderStreamError } = await import("../api/provider-stream-error.js");

const THREAD = "thread-1";
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

/** Stub that rejects with an AbortError-shaped error when the signal fires. */
function rejectOnAbort(opts: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => {
      const err = new Error("The user aborted a request");
      err.name = "AbortError";
      reject(err);
    });
  });
}

beforeEach(() => {
  streamExperienceCopilot.mockReset();
  toastError.mockClear();
  toastInfo.mockClear();
  useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
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
    streamExperienceCopilot.mockImplementation((_threadId, _body, opts) => rejectOnAbort(opts));

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
