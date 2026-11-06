/**
 * useAgentController — permission decisions (SC-23f + DMT-31): the decision
 * rides the SAME split-turn answer path as the ask family (no transport
 * fork), flips the optimistic `pendingPermissionAnswer`, and rolls back on a
 * pre-stream failure. DMT-31: an allow decision carries the user-edited
 * swipe `instruction` VERBATIM in the same answer body (never converted into
 * a sidechat user message), a deny never carries one, a refused request can
 * be retried (the rollback keeps the card interactive), and a duplicate
 * submission while one decision is in flight is suppressed. The transport
 * enters through the hook's DI seam (a stub — no fetch router, no
 * process-global patches).
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

  test("DMT-31: an allow with the edited instruction forwards the EXACT text on the same answer body (never a user message)", async () => {
    let capturedBody!: Record<string, unknown>;
    answerAsk.mockImplementation((_threadId, body, _opts) => {
      capturedBody = body as Record<string, unknown>;
      return Promise.resolve({ finishReason: "stop" });
    });
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", {
        decision: "allow",
        instruction: "Rewrite it spicier, keep the accent",
      });
    });

    expect(answerAsk).toHaveBeenCalledTimes(1);
    // The exact UI-approved text rides the original permission answer
    // transport — one body, no `content` user row, no ask `text` slot.
    expect(capturedBody).toEqual({
      answer: {
        toolCallId: "tc-perm",
        decision: "allow",
        instruction: "Rewrite it spicier, keep the accent",
      },
      providerProfileId: PROVIDER,
    });
    expect(result.current.pendingUserContent).toBe("");
    expect(result.current.pendingAskAnswer).toBeNull();
    expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "allow" });
  });

  test("DMT-31: a deny never sends an instruction (the guard refuses the body before any stream call)", async () => {
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "deny", instruction: "reject text" });
    });

    expect(answerAsk).not.toHaveBeenCalled();
    expect(sendStream).not.toHaveBeenCalled();
    expect(result.current.pendingPermissionAnswer).toBeNull();
    expect(result.current.pendingAskAnswer).toBeNull();
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

  test("DMT-31: after a transport refusal the card is interactive again — the retry re-sends and succeeds", async () => {
    answerAsk.mockImplementationOnce(() => Promise.reject(new Error("validation 400")));
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "allow", instruction: "edited text" });
    });
    // Refused: the optimistic receipt rolled back, the failure recorded.
    expect(result.current.pendingPermissionAnswer).toBeNull();
    expect(result.current.turnFailure).toEqual({ category: "unknown" });

    // The retry goes out again — the refusal must not resurrect a decided
    // state (the row was never rewritten, so the card returns to awaiting).
    let capturedBody!: Record<string, unknown>;
    answerAsk.mockImplementation((_threadId, body, _opts) => {
      capturedBody = body as Record<string, unknown>;
      return Promise.resolve({ finishReason: "stop" });
    });
    await act(async () => {
      await result.current.handleAnswer("tc-perm", { decision: "allow", instruction: "edited text" });
    });

    expect(answerAsk).toHaveBeenCalledTimes(2);
    expect(capturedBody).toEqual({
      answer: { toolCallId: "tc-perm", decision: "allow", instruction: "edited text" },
      providerProfileId: PROVIDER,
    });
    expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "allow" });
    expect(result.current.turnFailure).toBeNull();
  });

  test("DMT-31: a duplicate submission while a decision is in flight is suppressed (exactly one call, no double flip)", async () => {
    const d = deferred<{ finishReason: string }>();
    answerAsk.mockImplementation((_threadId, _body, _opts) => d.promise);
    const { result } = renderHook(() =>
      useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.handleAnswer("tc-perm", { decision: "allow", instruction: "in-flight text" });
      // The duplicate fires while the first decision has not settled.
      second = result.current.handleAnswer("tc-perm", { decision: "deny" });
      await Promise.resolve();
    });

    await act(async () => {
      d.resolve({ finishReason: "stop" });
      await Promise.all([first, second]);
    });

    expect(answerAsk).toHaveBeenCalledTimes(1);
    expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "allow" });
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
        kind: "prompt_read",
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

  test("a live request_message_swipe tool-result projects through the SAME decoder (kind + instruction, like history)", async () => {
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
      captured.onToolCall!({ toolCallId: "tc-swipe", toolName: "request_message_swipe", args: { messageId: "msg-1" } });
      captured.onToolResult!({
        toolCallId: "tc-swipe",
        toolName: "request_message_swipe",
        output: {
          status: "awaiting_permission",
          variantNumber: 2,
          replyFirstLine: "Live swipe line",
          messageId: "msg-1",
          variantId: "var-2",
          instruction: "Rewrite it spicier",
        },
        isError: false,
      });
    });

    expect(useAgentTurnStore.getState().getActivities("experience", THREAD)).toEqual([{
      toolCallId: "tc-swipe",
      toolName: "request_message_swipe",
      args: { messageId: "msg-1" },
      status: "done",
      permission: {
        status: "awaiting_permission",
        kind: "swipe",
        variantNumber: 2,
        replyFirstLine: "Live swipe line",
        messageId: "msg-1",
        variantId: "var-2",
        instruction: "Rewrite it spicier",
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

	// ── DMT-24b (owner ruling 2026-11-06): an absorbed swipe-run failure
	// arrives as the ESTABLISHED generation-failure toast — the answer request
	// itself succeeded, so the optimistic permission flip never rolls back and
	// the failure owns no card. ──

	test("DMT-24b: a failed swipe-run outcome toasts the swipe-failed key with the provider reason as the description and never rolls the flip back", async () => {
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
			captured.onSwipeRunOutcome!({
				toolCallId: "tc-perm",
				outcome: { status: "failed", reason: "Provider 502: upstream exploded" },
			});
		});

		// The established scheme: the swipe-failed key as the title, the provider
		// text as the description (key-echo i18n — the translate spy above).
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith("copilot_permission_swipe_run_failed", {
			description: "Provider 502: upstream exploded",
		});

		await act(async () => {
			d.resolve({ finishReason: "stop" });
			await pending;
		});
		// NO optimistic rollback: the decision was accepted, the receipt stored
		// server-side — the card keeps its granted state and no failure card
		// appears (the toast owns the outcome).
		expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "allow" });
		expect(result.current.turnFailure).toBeNull();
		expect(result.current.isSending).toBe(false);
	});

	test("DMT-24b: a no_output outcome toasts the swipe no-output key (no description) and never rolls the flip back", async () => {
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
			captured.onSwipeRunOutcome!({
				toolCallId: "tc-perm",
				outcome: { status: "no_output", messageId: "msg-1" },
			});
		});

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith("copilot_permission_swipe_run_no_output");

		await act(async () => {
			d.resolve({ finishReason: "stop" });
			await pending;
		});
		expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "allow" });
		expect(result.current.turnFailure).toBeNull();
	});

	test("DMT-24b: a cancelled outcome toasts NOTHING here (the established cancel toast already owns every reachable cancelled frame) and never rolls the flip back", async () => {
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
			captured.onSwipeRunOutcome!({ toolCallId: "tc-perm", outcome: { status: "cancelled" } });
		});

		// Pinned: no swipe-cancel toast — a cancelled swipe generation always
		// has the established `generation_cancelled` toast elsewhere (the RP
		// chat's attached-run Stop; cancelling the answer turn itself aborts
		// the stream before this frame can arrive). A second toast would
		// double-fire.
		expect(toastError).not.toHaveBeenCalled();

		await act(async () => {
			d.resolve({ finishReason: "stop" });
			await pending;
		});
		expect(result.current.pendingPermissionAnswer).toEqual({ toolCallId: "tc-perm", decision: "allow" });
	});

	test("DMT-24b: the outcome handler is wired on the LIVE answer path only (the send path carries none — replays and sends never toast)", async () => {
		let sendOpts!: Record<string, unknown>;
		const d = deferred<{ finishReason: string }>();
		sendStream.mockImplementation((_chatId, _body, opts) => {
			sendOpts = opts as Record<string, unknown>;
			return d.promise;
		});
		const { result } = renderHook(() =>
			useAgentController({ transport: stubTransport, kind: "experience", threadId: THREAD, providerProfileId: PROVIDER }),
		);

		let pending!: Promise<void>;
		await act(async () => {
			pending = result.current.handleSend("a plain message");
			await Promise.resolve();
		});

		expect("onSwipeRunOutcome" in sendOpts).toBe(false);

		await act(async () => {
			d.resolve({ finishReason: "stop" });
			await pending;
		});
	});
});
