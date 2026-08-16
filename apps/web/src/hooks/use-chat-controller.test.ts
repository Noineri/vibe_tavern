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
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import type { DiceRollSnapshot, ExperienceQueuedAttachmentView } from "../api/types.js";
import type { ExperienceScopeState } from "../stores/experience-store.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

// --- app-client stubs (only the two functions the non-stream path crosses) ---
const regenerateChatMessage = mock();
const sendChatMessageStream = mock();
const fetchChat = mock();
const logClientSendDebug = mock();
const sendChatMessageAction = mock();

const realAppClient = await import("../app-client.js");
const realChatActions = await import("../stores/api-actions/chat-actions.js");
const realLocaleHelpers = await import("../i18n/locale-helpers.js");
mock.module("../app-client.js", () => {
	return { ...realAppClient, regenerateChatMessage, sendChatMessageStream, fetchChat, logClientSendDebug };
});

// sendChatMessageAction (chat-actions) is the non-stream send entry handleSend
// calls; stubbed separately so the non-stream dice path can be exercised end
// to end while all unrelated exports remain real.
mock.module("../stores/api-actions/chat-actions.js", () => {
	return { ...realChatActions, sendChatMessageAction };
});

// getT() without initI18n — translations are irrelevant to state cleanup.
mock.module("../i18n/locale-helpers.js", () => ({
	...realLocaleHelpers,
	getT: () => (key: string) => key,
}));

const { useChatController, diceSendBlockReason } = await import("./use-chat-controller.js");
const { ProviderStreamError } = await import("../api/provider-stream-error.js");
const { DiceApiError } = await import("../api/dice-api.js");
const { useDiceStore } = await import("../stores/dice-store.js");
const { useChatStore } = await import("../stores/chat-store.js");
const { useProviderStore } = await import("../stores/provider-store.js");
const { useProviderDataStore } = await import("../stores/provider-data-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useBootstrapStore } = await import("../stores/api-actions/bootstrap-actions.js");
const { useExperienceStore } = await import("../stores/experience-store.js");

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

// ─── DICE-F3 send gate ─────────────────────────────────────────────────
//
// F3 wires Dice into the send path subtractively: when Dice is off, the lane
// is absent, or no roll is bindable, the send body + canSend are byte-identical
// to a no-Dice chat. Dice can only ever BLOCK a send (choose/actor gate) or
// ATTACH a commit intent (`{diceMode, pendingRevision}`) when a bindable roll
// exists. A server-side commit conflict (stale revision / unresolved choose)
// must resync the pending lane and KEEP the draft instead of erroring out.
//
// Two groups: (1) a pure gate `diceSendBlockReason` covering every null/block
// case without React; (2) `handleSend` end-to-end on the stream path (the
// stream mock + store pattern the existing Co-Author tests already use).

const DICE_PER = "per-1";
const DICE_CHAR = "char-1";

/** Minimal `DiceRollSnapshot` with every field the gate reads; fields the gate
 *  ignores (faces, resolution, timestamps) get placeholder values. */
function makeRoll(o: Partial<DiceRollSnapshot> = {}): DiceRollSnapshot {
  return {
    rollId: "r1",
    requestId: "req1",
    actor: { actorType: "persona", actorId: DICE_PER, actorLabel: "Persona" },
    scriptId: "s1",
    scriptLabel: "S",
    scriptRevision: 1,
    checkId: "c1",
    checkLabel: "C",
    notation: "1d20",
    faceShape: "d20" as never,
    resolution: "strict" as never,
    mode: "normal",
    included: true,
    finalAttemptId: null,
    attempts: [],
    createdAt: 0 as never,
    ...o,
  } as DiceRollSnapshot;
}

describe("diceSendBlockReason (DICE-F3 pure send gate)", () => {
  test("null/undefined lane ⇒ null (no-Dice send unaffected)", () => {
    expect(diceSendBlockReason(null, DICE_PER, DICE_CHAR)).toBeNull();
    expect(diceSendBlockReason(undefined, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("empty lane ⇒ null", () => {
    expect(diceSendBlockReason({ revision: 0, rolls: [] }, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("all-excluded rolls ⇒ null (excluded rolls neither block nor bind)", () => {
    const lane = { revision: 1, rolls: [makeRoll({ included: false, policy: "choose", finalAttemptId: null })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("included narrative roll (no choose policy) ⇒ null", () => {
    const lane = { revision: 1, rolls: [makeRoll({ policy: undefined })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("included choose roll, unresolved ⇒ 'choose'", () => {
    const lane = { revision: 1, rolls: [makeRoll({ policy: "choose", finalAttemptId: null })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBe("choose");
  });

  test("included choose roll, resolved (finalAttemptId set) ⇒ null", () => {
    const lane = { revision: 1, rolls: [makeRoll({ policy: "choose", finalAttemptId: "a1" })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("included persona roll, actor mismatch ⇒ 'actor_mismatch'", () => {
    const lane = { revision: 1, rolls: [makeRoll({ actor: { actorType: "persona", actorId: "WRONG", actorLabel: "X" } })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBe("actor_mismatch");
  });

  test("included persona roll, actor matches ⇒ null", () => {
    const lane = { revision: 1, rolls: [makeRoll({ actor: { actorType: "persona", actorId: DICE_PER, actorLabel: "P" } })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("included character roll, actor mismatch ⇒ 'actor_mismatch'", () => {
    const lane = { revision: 1, rolls: [makeRoll({ actor: { actorType: "character", actorId: "WRONG", actorLabel: "X" } })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBe("actor_mismatch");
  });

  test("included character roll, actor matches ⇒ null", () => {
    const lane = { revision: 1, rolls: [makeRoll({ actor: { actorType: "character", actorId: DICE_CHAR, actorLabel: "C" } })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("excluded persona-mismatch roll ⇒ null (excluded rolls don't block)", () => {
    const lane = { revision: 1, rolls: [makeRoll({ included: false, actor: { actorType: "persona", actorId: "WRONG", actorLabel: "X" } })] };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBeNull();
  });

  test("choose takes precedence over actor_mismatch (choose checked first)", () => {
    const lane = {
      revision: 1,
      rolls: [makeRoll({ policy: "choose", finalAttemptId: null, actor: { actorType: "persona", actorId: "WRONG", actorLabel: "X" } })],
    };
    expect(diceSendBlockReason(lane, DICE_PER, DICE_CHAR)).toBe("choose");
  });
});

describe("useChatController — handleSend dice send (DICE-F3, stream path)", () => {
  // Stubbed once per file so conflict tests can assert it fired; cleared in
  // beforeEach. `tryHandleDiceSendConflict` calls it fire-and-forget.
  const refreshPending = mock();
  // IR-73D: refreshAttachment is stubbed alongside refreshPending so
  // conflict / settlement tests can assert the experience attachment refresh.
  const refreshAttachment = mock((_chatId: string, _branchId: string): Promise<void> => Promise.resolve());
  const BRANCH = "br-1";

  beforeEach(() => {
    sendChatMessageStream.mockReset();
    sendChatMessageAction.mockReset();
    refreshPending.mockClear();
    refreshAttachment.mockClear();
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: true } }));
    useProviderDataStore.setState({ profiles: [{ id: "p1", isActive: true, defaultModel: "m" } as never] });
    // `readDiceSendState` reads chatId / branchId / insights / persona /
    // characterId straight from the snapshot, so seed them all here.
    useSnapshotStore.setState({
      activeChat: {
        id: CHAT,
        characterId: DICE_CHAR,
        mode: "rp",
        insightsConfig: { objectiveEnabled: true, trackerEnabled: true, diceEnabled: true, diceMode: "normal" },
      } as never,
      activeBranch: { id: BRANCH } as never,
      persona: { id: DICE_PER } as never,
    });
    useChatStore.setState({ activeChatId: CHAT, draft: "hi", generations: {}, messageActionId: null });
    useDiceStore.setState({ byScope: {}, refreshPending: refreshPending as never });
    // IR-73D: clear experience scope and override refreshAttachment with the
    // test mock so settlement/conflict tests can assert it fired.
    useExperienceStore.setState({ byScope: {}, activeScope: null, refreshAttachment });
  });

  /** Put a normal-mode pending lane into the active scope. */
  function setNormalLane(rolls: DiceRollSnapshot[], revision = 7): void {
    useDiceStore.setState({
      byScope: {
        [`${CHAT}|${BRANCH}`]: {
          definitions: null,
          lanes: { normal: { revision, rolls }, immersive: { revision, rolls: [] } },
          rollingRequestIds: {},
          lastError: null,
        },
      } as never,
    });
  }

  /** Experience queued attachment for the active scope (IR-73D). */
  function makeExpAttachment(overrides: Partial<ExperienceQueuedAttachmentView> = {}): ExperienceQueuedAttachmentView {
    return {
      id: "att-1",
      chatId: CHAT,
      branchId: BRANCH,
      sessionId: "exp-sess-1",
      sessionRevision: 3,
      queueRevision: 2,
      kind: "report",
      publicReport: { title: "Game", events: [] },
      rulesSourceHash: "hash-rules",
      visualSourceHash: "hash-visual",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  /** Put a queued attachment (or null) into the active experience scope. */
  function setExpAttachment(attachment: ExperienceQueuedAttachmentView | null): void {
    const scope: ExperienceScopeState = {
      config: null,
      session: null,
      effects: [],
      queuedAttachment: attachment,
      reportStatus: null,
      contextStatus: null,
      actionRequestIds: {},
      loading: false,
      lastError: null,
      lastApiError: null,
      modalOpen: false,
      detached: false,
    };
    useExperienceStore.setState({
      byScope: { [JSON.stringify([CHAT, BRANCH])]: scope },
    });
  }

  test("bindable lane ⇒ intent {diceMode, pendingRevision} threaded into the stream body", async () => {
    setNormalLane([makeRoll({ included: true })]);
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
    expect(sendChatMessageStream.mock.calls[0][1]).toEqual(
      expect.objectContaining({ content: "hi", diceMode: "normal", pendingRevision: 7 }),
    );
  });

  test("lane present but NO bindable roll ⇒ byte-identical send body (no dice fields)", async () => {
    setNormalLane([makeRoll({ included: false })]);
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    expect(body.diceMode).toBeUndefined();
    expect(body.pendingRevision).toBeUndefined();
    expect(body).toEqual(expect.objectContaining({ content: "hi" }));
  });

  test("Dice OFF ⇒ byte-identical send body (no dice fields)", async () => {
    useSnapshotStore.setState({
      activeChat: {
        id: CHAT, characterId: DICE_CHAR, mode: "rp",
        insightsConfig: { objectiveEnabled: true, trackerEnabled: true, diceEnabled: false, diceMode: "normal" },
      } as never,
      activeBranch: { id: BRANCH } as never,
      persona: { id: DICE_PER } as never,
    });
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    expect(body.diceMode).toBeUndefined();
    expect(body.pendingRevision).toBeUndefined();
  });

  test("unresolved choose roll ⇒ send blocked (no stream call)", async () => {
    setNormalLane([makeRoll({ included: true, policy: "choose", finalAttemptId: null })]);
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).not.toHaveBeenCalled();
  });

  test("persona actor mismatch ⇒ send blocked (no stream call)", async () => {
    setNormalLane([makeRoll({ included: true, actor: { actorType: "persona", actorId: "WRONG", actorLabel: "X" } })]);
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).not.toHaveBeenCalled();
  });

  test("stream conflict (stale_revision) ⇒ refreshPending + draft KEPT", async () => {
    setNormalLane([makeRoll({ included: true })]);
    sendChatMessageStream.mockRejectedValueOnce(new ProviderStreamError("stale", "server_error", "stale_revision"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
    expect(refreshPending).toHaveBeenCalledWith(CHAT, BRANCH);
    // executeStreamAction clears the draft up front; the dice-conflict path
    // must restore it so the user can re-review and resend.
    expect(useChatStore.getState().draft).toBe("hi");
  });

  test("stream conflict (unresolved_choose) ⇒ refreshPending fires too", async () => {
    setNormalLane([makeRoll({ included: true })]);
    sendChatMessageStream.mockRejectedValueOnce(new ProviderStreamError("choose", "server_error", "unresolved_choose"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshPending).toHaveBeenCalledWith(CHAT, BRANCH);
    expect(useChatStore.getState().draft).toBe("hi");
  });

  test("non-conflict provider error ⇒ NOT treated as dice (refreshPending not called)", async () => {
    setNormalLane([makeRoll({ included: true })]);
    // A plain provider failure with NO structured conflict code must fall through
    // to the generic provider-error path, never the dice resync.
    sendChatMessageStream.mockRejectedValueOnce(new ProviderStreamError("boom", "server_error"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshPending).not.toHaveBeenCalled();
  });

  // ── Non-stream path (streamResponse=false) ── handleSend routes through
  // sendChatMessageAction; a 409 DiceApiError reaches the onError callback,
  // which must run the SAME dice-conflict recovery (refresh + keep draft).

  test("non-stream: bindable lane ⇒ intent threaded as the diceCommit arg", async () => {
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
    setNormalLane([makeRoll({ included: true })]);
    sendChatMessageAction.mockResolvedValue({});
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    // (chatId, content, attachments, diceCommit, signal)
    expect(sendChatMessageAction.mock.calls[0][0]).toBe(CHAT);
    expect(sendChatMessageAction.mock.calls[0][1]).toBe("hi");
    expect(sendChatMessageAction.mock.calls[0][3]).toEqual({ diceMode: "normal", pendingRevision: 7 });
  });

  test("non-stream: Dice OFF ⇒ no diceCommit arg (undefined, byte-identical)", async () => {
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
    useSnapshotStore.setState({
      activeChat: {
        id: CHAT, characterId: DICE_CHAR, mode: "rp",
        insightsConfig: { objectiveEnabled: true, trackerEnabled: true, diceEnabled: false, diceMode: "normal" },
      } as never,
      activeBranch: { id: BRANCH } as never,
      persona: { id: DICE_PER } as never,
    });
    sendChatMessageAction.mockResolvedValue({});
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    expect(sendChatMessageAction.mock.calls[0][3]).toBeUndefined();
  });

  test("non-stream conflict (stale_revision) ⇒ refreshPending + draft KEPT", async () => {
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
    setNormalLane([makeRoll({ included: true })]);
    sendChatMessageAction.mockRejectedValueOnce(new DiceApiError(409, "stale", "stale_revision"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    expect(refreshPending).toHaveBeenCalledWith(CHAT, BRANCH);
    // handleSend's non-stream arm clears the draft up front (csStore.setDraft(""));
    // the dice-conflict path must restore it so the user can re-review and resend.
    expect(useChatStore.getState().draft).toBe("hi");
  });

  test("non-stream conflict (unresolved_choose) ⇒ refreshPending fires too", async () => {
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
    setNormalLane([makeRoll({ included: true })]);
    sendChatMessageAction.mockRejectedValueOnce(new DiceApiError(409, "choose", "unresolved_choose"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshPending).toHaveBeenCalledWith(CHAT, BRANCH);
    expect(useChatStore.getState().draft).toBe("hi");
  });

  // ── IR-73D experience send integration ─────────────────────────────
  //
  // The experience path mirrors the Dice subtractive pattern: when no
  // attachment is queued (or the scope IDs mismatch), the send body is
  // byte-identical to a no-experience send and no experience refresh fires.
  // When a valid attachment exists, exactly three identifiers/revisions are
  // derived and spread into the body; a server-side bind conflict (IR-70H)
  // restores the draft and triggers the authoritative attachment refresh
  // instead of the provider-error toast path. Combined Dice + Experience
  // carries both intents atomically.

  test("IR-73D: no queued attachment ⇒ stream body has NO experience fields, no refresh", async () => {
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    expect(body.experienceAttachmentId).toBeUndefined();
    expect(body.experienceQueueRevision).toBeUndefined();
    expect(body.experienceSessionRevision).toBeUndefined();
    expect(refreshAttachment).not.toHaveBeenCalled();
  });

  test("IR-73D: valid queued attachment ⇒ exact three experience fields on stream body", async () => {
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    expect(body.experienceAttachmentId).toBe("att-1");
    expect(body.experienceQueueRevision).toBe(2);
    expect(body.experienceSessionRevision).toBe(3);
  });

  test("IR-73D: exact experience final arg on non-stream action", async () => {
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
    setExpAttachment(makeExpAttachment());
    sendChatMessageAction.mockResolvedValue({});
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    // (chatId, content, attachments, diceCommit, signal, experienceCommit)
    expect(sendChatMessageAction.mock.calls[0][5]).toEqual({
      experienceAttachmentId: "att-1",
      experienceQueueRevision: 2,
      experienceSessionRevision: 3,
    });
  });

  test("IR-73D: combined Dice + Experience ⇒ both complete intents in stream body", async () => {
    setNormalLane([makeRoll({ included: true })]);
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    // Dice intent complete
    expect(body.diceMode).toBe("normal");
    expect(body.pendingRevision).toBe(7);
    // Experience intent complete
    expect(body.experienceAttachmentId).toBe("att-1");
    expect(body.experienceQueueRevision).toBe(2);
    expect(body.experienceSessionRevision).toBe(3);
  });

  test("IR-73D: stream conflict (stale_queue) ⇒ draft kept, attachment refreshed, no dice refresh", async () => {
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockRejectedValueOnce(new ProviderStreamError("stale", "server_error", "stale_queue"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshAttachment).toHaveBeenCalledWith(CHAT, BRANCH);
    expect(refreshPending).not.toHaveBeenCalled();
    expect(useChatStore.getState().draft).toBe("hi");
  });

  test("IR-73D: stream conflict (not_found) ⇒ draft kept, attachment refreshed", async () => {
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockRejectedValueOnce(new ProviderStreamError("gone", "server_error", "not_found"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshAttachment).toHaveBeenCalledWith(CHAT, BRANCH);
    expect(useChatStore.getState().draft).toBe("hi");
  });

  test("IR-73D: non-stream conflict (already_bound) ⇒ draft kept, attachment refreshed", async () => {
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
    setExpAttachment(makeExpAttachment());
    sendChatMessageAction.mockRejectedValueOnce(new DiceApiError(409, "bound", "already_bound"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    expect(refreshAttachment).toHaveBeenCalledWith(CHAT, BRANCH);
    expect(refreshPending).not.toHaveBeenCalled();
    expect(useChatStore.getState().draft).toBe("hi");
  });

  test("IR-73D: non-stream conflict (stale_session) ⇒ draft kept, attachment refreshed", async () => {
    useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: false } }));
    setExpAttachment(makeExpAttachment());
    sendChatMessageAction.mockRejectedValueOnce(new DiceApiError(409, "stale", "stale_session"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshAttachment).toHaveBeenCalledWith(CHAT, BRANCH);
    expect(useChatStore.getState().draft).toBe("hi");
  });

  test("IR-73D: generic stream failure with captured intent ⇒ attachment refreshed", async () => {
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockRejectedValueOnce(new ProviderStreamError("boom", "server_error"));
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshAttachment).toHaveBeenCalledWith(CHAT, BRANCH);
  });

  test("IR-73D: cancellation with captured intent ⇒ attachment refreshed", async () => {
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { signal: AbortSignal }): Promise<never> => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("The user aborted a request");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const { result } = renderHook(() => useChatController());

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend();
      await Promise.resolve();
    });

    await act(async () => {
      useChatStore.getState().abortGeneration(CHAT);
      await pending;
    });

    expect(refreshAttachment).toHaveBeenCalledWith(CHAT, BRANCH);
  });

  test("IR-73D: success with captured intent ⇒ attachment refreshed authoritatively", async () => {
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(refreshAttachment).toHaveBeenCalledWith(CHAT, BRANCH);
  });

  test("IR-73D: scope mismatch (wrong chatId) ⇒ no experience intent, no refresh", async () => {
    setExpAttachment(makeExpAttachment({ chatId: "WRONG-CHAT" }));
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    expect(body.experienceAttachmentId).toBeUndefined();
    expect(body.experienceQueueRevision).toBeUndefined();
    expect(body.experienceSessionRevision).toBeUndefined();
    expect(refreshAttachment).not.toHaveBeenCalled();
  });

  test("IR-73D: no private report/source fields leak into send body", async () => {
    setExpAttachment(makeExpAttachment());
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    expect(body.publicReport).toBeUndefined();
    expect(body.rulesSourceHash).toBeUndefined();
    expect(body.visualSourceHash).toBeUndefined();
    expect(body.kind).toBeUndefined();
    expect(body.sessionId).toBeUndefined();
    expect(body.sessionRevision).toBeUndefined();
    expect(body.queueRevision).toBeUndefined();
    expect(body.chatId).toBeUndefined();
    expect(body.branchId).toBeUndefined();
  });

  test("IR-73D: captured intent keeps handleSend pending until refresh settles (success path)", async () => {
    setExpAttachment(makeExpAttachment());
    let resolveRefresh!: () => void;
    refreshAttachment.mockReturnValueOnce(new Promise<void>((r) => { resolveRefresh = r; }));
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    let settled = false;
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleSend();
      pending.then(() => { settled = true; });
      // Flush microtasks until the stream settles and the post-settlement
      // block reaches refreshAttachment.
      for (let i = 0; i < 20 && refreshAttachment.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
    });

    // The stream settled (refreshAttachment was reached), but the deferred
    // refresh has not — handleSend must still be pending.
    expect(refreshAttachment).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await act(async () => {
      resolveRefresh();
      await pending;
    });
    expect(settled).toBe(true);
  });

  test("IR-73D: no captured intent ⇒ handleSend resolves without calling refresh", async () => {
    // No attachment set — no intent captured. handleSend must resolve fully
    // without ever calling refreshAttachment (boundary parity with the
    // captured-intent case above).
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
    expect(refreshAttachment).not.toHaveBeenCalled();
  });

  test("IR-73D: snapshot activeChat ≠ send target ⇒ fail closed (no intent, no refresh)", async () => {
    // ChatStore send target is CHAT; Snapshot claims a DIFFERENT chat is active,
    // one with its own valid queued attachment. A transient mismatch must NOT
    // bind the other chat's attachment into the CHAT send.
    const currentSnapshot = useSnapshotStore.getState();
    if (!currentSnapshot.activeChat) throw new Error("Expected seeded active chat");
    useSnapshotStore.setState({
      activeChat: { ...currentSnapshot.activeChat, id: brandId<ChatId>("OTHER-CHAT") },
    });
    useExperienceStore.setState({
      byScope: {
        [JSON.stringify(["OTHER-CHAT", BRANCH])]: {
          config: null,
          session: null,
          effects: [],
          queuedAttachment: makeExpAttachment({ chatId: "OTHER-CHAT", id: "other-att" }),
          reportStatus: null,
          contextStatus: null,
          actionRequestIds: {},
          loading: false,
          lastError: null,
          lastApiError: null,
          modalOpen: false,
          detached: false,
        },
      },
    });
    sendChatMessageStream.mockImplementation((_id: unknown, _body: unknown, opts: { onDone?: () => void }) => {
      opts?.onDone?.();
      return Promise.resolve();
    });
    const { result } = renderHook(() => useChatController());

    await act(async () => { await result.current.handleSend(); });

    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
    const body = sendChatMessageStream.mock.calls[0][1] as Record<string, unknown>;
    expect(body.experienceAttachmentId).toBeUndefined();
    expect(body.experienceQueueRevision).toBeUndefined();
    expect(body.experienceSessionRevision).toBeUndefined();
    expect(refreshAttachment).not.toHaveBeenCalled();
  });
});
