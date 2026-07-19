/**
 * useChatController — non-streaming cancellation cleanup.
 *
 * Characterization tests for the message-level state machine around
 * `handleRegenerateMessage` when the active profile has `streamResponse=false`
 * (the non-streaming path). The regression under test: an early `return` in
 * the non-stream abort branch skipped `setMessageActionId(null)`, leaving the
 * regenerated message permanently busy (`MessageBlock.isBusy` /
 * `isBranching` both key off `messageActionId === messageId`).
 *
 * The test exercises the controller end-to-end (action layer → app-client →
 * store cleanup) with `regenerateChatMessage` stubbed to settle on demand, so
 * the abort/error/success boundaries are observable without a server.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatId } from "@vibe-tavern/domain";

// --- app-client stubs (only the two functions the non-stream path crosses) ---
// vi.hoisted runs before the hoisted vi.mock factory so the stubs exist at
// mock-registration time (vi.mock is hoisted above every const). Spread
// `...actual` first so types, logClientSendDebug, and the (unused here) stream
// functions keep their real bindings; vi.mock is file-scoped (vitest), so this
// cannot leak into other test files.
const { regenerateChatMessage, sendChatMessageStream, fetchChat, logClientSendDebug } = vi.hoisted(() => ({
  regenerateChatMessage: vi.fn(),
  sendChatMessageStream: vi.fn(),
  fetchChat: vi.fn(),
  // fire-and-forget POST to /api/debug/send-log — no server in tests.
  logClientSendDebug: vi.fn(),
}));
vi.mock("../app-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app-client.js")>();
  return { ...actual, regenerateChatMessage, sendChatMessageStream, fetchChat, logClientSendDebug };
});

// getT() without initI18n — translations are irrelevant to state cleanup.
vi.mock("../i18n/locale-helpers.js", () => ({
  getT: () => (key: string) => key,
}));

import { useChatController } from "./use-chat-controller.js";
import { useChatStore } from "../stores/chat-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useBootstrapStore } from "../stores/api-actions/bootstrap-actions.js";

const CHAT = "chat-1" as ChatId;
const MSG = "msg-1";

/** Stub that rejects with an AbortError-shaped error when the signal fires,
 *  mirroring how `fetch` rejects on `AbortController.abort()`. */
function rejectOnAbort(_chatId: ChatId, _messageId: string, opts?: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => {
      const err = new Error("The user aborted a request");
      err.name = "AbortError";
      reject(err);
    });
  });
}

beforeEach(() => {
  regenerateChatMessage.mockReset();
  sendChatMessageStream.mockReset();
  fetchChat.mockReset();
  // ingestSnapshot preserves absent fields, so an empty snapshot is a safe
  // no-op refresh for the post-abort / post-error refetch.
  fetchChat.mockResolvedValue({});

  useChatStore.setState({
    activeChatId: CHAT,
    messageActionId: null,
    generations: {},
  });
  // Non-streaming mode — selects the `else` branch in handleRegenerateMessage.
  useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
  // Active profile with a default model so `canSendViaActiveProfile` is true
  // (otherwise handleRegenerateMessage toasts + returns before touching state).
  useProviderDataStore.setState({
    profiles: [{ id: "p1", isActive: true, defaultModel: "gpt-x" } as never],
  });
});

describe("useChatController — handleRegenerateMessage (non-stream)", () => {
  test("success clears messageActionId and isSending", async () => {
    regenerateChatMessage.mockResolvedValue({});
    const { result } = renderHook(() => useChatController());

    await act(async () => {
      await result.current.handleRegenerateMessage(MSG);
    });

    expect(useChatStore.getState().messageActionId).toBeNull();
    expect(useChatStore.getState().generations[CHAT]?.isSending).toBe(false);
  });

  test("cancel (abort) clears messageActionId and isSending — the regression under fix", async () => {
    regenerateChatMessage.mockImplementation(rejectOnAbort);
    const { result } = renderHook(() => useChatController());

    // Kick off the regeneration; flush the synchronous prefix
    // (setMessageActionId + startGeneration) before asserting the in-flight state.
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleRegenerateMessage(MSG);
      await Promise.resolve();
    });

    expect(useChatStore.getState().messageActionId).toBe(MSG);
    expect(useChatStore.getState().generations[CHAT]?.isSending).toBe(true);

    // User clicks Cancel — abortGeneration flips the abort flag synchronously,
    // the stubbed action rejects, the controller's catch must run cleanup.
    await act(async () => {
      useChatStore.getState().abortGeneration(CHAT);
      await pending;
    });

    expect(useChatStore.getState().messageActionId).toBeNull();
    expect(useChatStore.getState().generations[CHAT]?.isSending).toBe(false);
  });

  test("provider error clears messageActionId and isSending", async () => {
    regenerateChatMessage.mockRejectedValue(new Error("provider boom"));
    const { result } = renderHook(() => useChatController());

    await act(async () => {
      await result.current.handleRegenerateMessage(MSG);
    });

    expect(useChatStore.getState().messageActionId).toBeNull();
    expect(useChatStore.getState().generations[CHAT]?.isSending).toBe(false);
  });
});

describe("useChatController — Co-Author send gate", () => {
  beforeEach(() => {
    // Put the active chat into coauthor mode.
    useSnapshotStore.setState({ activeChat: { mode: "coauthor" } as never });
    // Stream mode so handleSend uses the stream path (sendChatMessageStream).
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: true } }));
  });

  test("passes the gate when an explicit Co-Author binding exists", async () => {
    useProviderDataStore.setState({
      profiles: [{ id: "p_co", name: "Co Prof", isActive: false, defaultModel: null } as never],
    });
    useBootstrapStore.setState({
      data: { uiSettings: { coauthorProviderId: "p_co", coauthorModelName: "tool-m" } } as never,
    });
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });

    useChatStore.setState({ activeChatId: CHAT, draft: "hello", generations: {}, messageActionId: null });
    const { result } = renderHook(() => useChatController());
    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
  });

  test("blocks when no explicit binding and no RP fallback profile", async () => {
    useProviderDataStore.setState({ profiles: [] });
    useBootstrapStore.setState({ data: { uiSettings: { coauthorProviderId: null, coauthorModelName: null } } as never });

    useChatStore.setState({ activeChatId: CHAT, draft: "hello", generations: {}, messageActionId: null });
    const { result } = renderHook(() => useChatController());
    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).not.toHaveBeenCalled();
  });
});
