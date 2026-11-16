import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { brandId } from "@vibe-tavern/domain";
import type { ChatBranchId, ChatId, CharacterId } from "@vibe-tavern/domain";
import { wireBranch, wireChat, wireMessage } from "../../../test/wire-fixtures.js";
import type { AppSnapshot, ChatListItem } from "../../api/types.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { useNavigationStore } from "../navigation-store.js";
import { useCoauthorTurnStore } from "../coauthor-turn-store.js";
import { useContextPreviewStore } from "../context-preview-store.js";

// Mocks for the deleteChatAction tests below. `deleteChat` returns the
// backend's ChatListResponse ({ chats }); the fire-and-forget bootstrap is
// stubbed so it can't race the assertion. Other chat-api exports stay real
// (spread), so the switchModeAction tests in this file are unaffected. Each
// mock wraps the REAL function so `mockResolvedValue` bodies are checked
// against the real wire signature (the 7f PromptManagerModal idiom).
const realInsightsCompletionActions = await import("./insights-completion-actions.js");
const realBootstrapActions = await import("./bootstrap-actions.js");
const realChatApi = await import("../../api/chat-api.js");
const realAgentChatApi = await import("../../api/agent-chat-api.js");
const realSonner = await import("sonner");

const deleteChatMock = mock(realChatApi.deleteChat);
const forkBranchMock = mock(realChatApi.forkBranch);
const forkBranchSidechatMock = mock(realAgentChatApi.forkBranchSidechat);
const generateObjectiveTasksMock = mock(realChatApi.generateObjectiveTasks);
const generateReplyMock = mock(realChatApi.generateReply);
const sendChatMessageMock = mock(realChatApi.sendChatMessage);
const startCompletionRefreshMock = mock(realInsightsCompletionActions.startInsightsCompletionRefreshFromSnapshot);
const updateChatDynamicPromptMock = mock(realChatApi.updateChatDynamicPrompt);
const selectMessageVariantMock = mock(realChatApi.selectMessageVariant);
const fetchBootstrapMock = mock(realBootstrapActions.fetchBootstrapAction);
const toastErrorMock = mock(realSonner.toast.error);

mock.module("./insights-completion-actions.js", () => ({
  ...realInsightsCompletionActions,
  startInsightsCompletionRefreshFromSnapshot: startCompletionRefreshMock,
}));
mock.module("./bootstrap-actions.js", () => ({
  ...realBootstrapActions,
  fetchBootstrapAction: fetchBootstrapMock,
}));
mock.module("../../api/chat-api.js", () => ({
  ...realChatApi,
  deleteChat: deleteChatMock,
  forkBranch: forkBranchMock,
  generateObjectiveTasks: generateObjectiveTasksMock,
  generateReply: generateReplyMock,
  sendChatMessage: sendChatMessageMock,
  updateChatDynamicPrompt: updateChatDynamicPromptMock,
  selectMessageVariant: selectMessageVariantMock,
}));
mock.module("../../api/agent-chat-api.js", () => ({
  ...realAgentChatApi,
  forkBranchSidechat: forkBranchSidechatMock,
}));
mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: toastErrorMock },
}));

let deleteChatAction: typeof import("./chat-actions.js").deleteChatAction;
let forkBranchAction: typeof import("./chat-actions.js").forkBranchAction;
let generateObjectiveTasksAction: typeof import("./chat-actions.js").generateObjectiveTasksAction;
let generateReplyAction: typeof import("./chat-actions.js").generateReplyAction;
let sendChatMessageAction: typeof import("./chat-actions.js").sendChatMessageAction;
let switchModeAction: typeof import("./chat-actions.js").switchModeAction;
let updateChatDynamicPromptAction: typeof import("./chat-actions.js").updateChatDynamicPromptAction;
let selectVariantAction: typeof import("./chat-actions.js").selectVariantAction;
let waitForPendingVariantSelections: typeof import("./chat-actions.js").waitForPendingVariantSelections;
beforeAll(async () => {
  ({ deleteChatAction, forkBranchAction, generateObjectiveTasksAction, generateReplyAction, sendChatMessageAction, switchModeAction, updateChatDynamicPromptAction, selectVariantAction, waitForPendingVariantSelections } = await import("./chat-actions.js"));
});

const chatId = (id: string) => id as ChatId;
const characterId = (id: string) => id as CharacterId;

/** Minimal ChatListItem for the chats list — only the fields switchModeAction reads. */
function listItem(id: string, mode: "rp" | "coauthor", charId = "char-1", lastMessageAt = "2026-01-01T00:00:00.000Z"): ChatListItem {
  return {
    id: chatId(id),
    title: `Chat ${id}`,
    characterId: characterId(charId),
    characterName: "Character",
    subtitle: "",
    activeBranchLabel: "main",
    mode,
    messageCount: 0,
    lastMessageAt,
    updatedAt: lastMessageAt,
  };
}

/**
 * Seed the snapshot store with a chats list + optionally an active chat. The
 * active chat mirrors the matching list item's id/characterId/mode, because
 * switchModeAction (after SURFACE_REGISTRY step 4) reads `activeChat.mode` to
 * detect the coauthor bucket — it no longer reads navMode for that. Pass
 * activeId = null (the default) to leave the snapshot without an active chat.
 */
function seed(chats: ChatListItem[], activeId: string | null = null): void {
  const active = activeId ? chats.find((c) => c.id === chatId(activeId)) ?? null : null;
  const snap: AppSnapshot = {
    chats,
    ...(active
      ? { activeChat: wireChat({ id: active.id, characterId: active.characterId, mode: active.mode }) }
      : {}),
  };
  useSnapshotStore.getState().ingestSnapshot(snap);
}

beforeEach(() => {
  deleteChatMock.mockReset();
  // The bootstrap stub must be (re)installed every test: with the typed mock
  // the impl starts as the REAL fetchBootstrapAction, and a fire-and-forget
  // `void fetchBootstrapAction()` (deleteChatAction) would hit the gateway.
  fetchBootstrapMock.mockReset();
  fetchBootstrapMock.mockResolvedValue(undefined);
  forkBranchMock.mockReset();
  forkBranchSidechatMock.mockReset();
  generateObjectiveTasksMock.mockReset();
  generateReplyMock.mockReset();
  sendChatMessageMock.mockReset();
  startCompletionRefreshMock.mockReset();
  updateChatDynamicPromptMock.mockReset();
  selectMessageVariantMock.mockReset();
  toastErrorMock.mockReset();
  useSnapshotStore.getState().clear();
  useContextPreviewStore.setState({ entries: {} });
  useCoauthorTurnStore.setState({ turnsByChat: {} });
  useChatStore.getState().setActiveChatId(null);
  useChatStore.getState().setSelectedCharacterId(null);
  useNavigationStore.getState().setMode("play");
});

describe("committed assistant completion refresh", () => {
  test("starts the scoped refresh after a non-streaming send snapshot is ingested", async () => {
    // `variants` is required on the wire (AppMessage derives from the RPC
    // type); the ingest path reads it (IG-CF10 shadow stamp) — the double
    // must carry a minimal array to honor the contract.
    const snapshot: AppSnapshot = { messages: [wireMessage("msg_1")] };
    sendChatMessageMock.mockResolvedValueOnce(snapshot);

    await sendChatMessageAction(chatId("chat-1"), "Hello");

    expect(startCompletionRefreshMock).toHaveBeenCalledWith(chatId("chat-1"), snapshot);
  });

  test("hydrates committed co-author proposals after a non-streaming send", async () => {
    useChatStore.getState().setActiveChatId(chatId("chat-1"));
    // The carrier toolCall carries the operation INPUT (args); the non-streaming
    // hydration path (syncCommittedCoauthorTurn → extractPersistedCoauthorActivities)
    // must reconstruct the SAME name+input+output shape the streaming path builds.
    const editArgs = { edits: [{ search: "old", replace: "new" }], summary: "Updated examples" };
    const snapshot: AppSnapshot = {
      activeChat: wireChat({ id: chatId("chat-1"), characterId: characterId("char-1"), mode: "coauthor" }),
      messages: [
        wireMessage("user_1", { role: "user", authorType: "user", content: "edit examples" }),
        wireMessage("assistant_call", {
          content: "",
          toolCalls: [{ id: "call_1", name: "edit_examples", args: editArgs }],
        }),
        wireMessage("tool_1", {
          role: "tool",
          authorType: "tool",
          content: JSON.stringify({
            target: "profile",
            proposed: "# EXAMPLES\nUpdated",
            summary: "Updated examples",
          }),
          toolCallId: "call_1",
        }),
        wireMessage("assistant_final", { content: "Done" }),
      ],
    };
    sendChatMessageMock.mockResolvedValueOnce(snapshot);
    useCoauthorTurnStore.getState().upsertActivity("chat-1", {
      toolCallId: "old_call",
      toolName: "write_profile",
      status: "done",
    });

    await sendChatMessageAction(chatId("chat-1"), "edit examples");

    expect(useCoauthorTurnStore.getState().getActivities("chat-1")).toEqual([{
      toolCallId: "call_1",
      toolName: "edit_examples",
      args: editArgs,
      status: "done",
      target: "profile",
      proposed: "# EXAMPLES\nUpdated",
      summary: "Updated examples",
      greetingIndex: undefined,
      isAdd: undefined,
    }]);
  });

  test("starts the scoped refresh after a non-streaming generate-reply snapshot is ingested", async () => {
    const snapshot: AppSnapshot = { messages: [wireMessage("msg_2")] };
    generateReplyMock.mockResolvedValueOnce(snapshot);

    await generateReplyAction(chatId("chat-1"));

    expect(startCompletionRefreshMock).toHaveBeenCalledWith(chatId("chat-1"), snapshot);
  });
});

describe("generateObjectiveTasksAction", () => {
  test("does not ingest a snapshot that resolves after cancellation", async () => {
    let resolveRequest: (snapshot: AppSnapshot) => void = () => {};
    generateObjectiveTasksMock.mockImplementationOnce(() => new Promise<AppSnapshot>((resolve) => { resolveRequest = resolve; }));
    const controller = new AbortController();

    const pending = generateObjectiveTasksAction(chatId("chat-1"), controller.signal);
    controller.abort();
    resolveRequest({ activeChat: wireChat({ id: chatId("stale-chat") }) });
    await pending;

    expect(useSnapshotStore.getState().activeChat).toBeNull();
  });
});

describe("forkBranchAction", () => {
  test("joins identical pending forks but permits another fork after settlement", async () => {
    let resolveFirst: (snapshot: AppSnapshot) => void = () => {};
    forkBranchMock.mockImplementationOnce(() => new Promise<AppSnapshot>((resolve) => { resolveFirst = resolve; }));

    const first = forkBranchAction(chatId("chat-1"), "message-1");
    const duplicate = forkBranchAction(chatId("chat-1"), "message-1");
    expect(forkBranchMock).toHaveBeenCalledTimes(1);

    resolveFirst({});
    await Promise.all([first, duplicate]);

    forkBranchMock.mockResolvedValueOnce({});
    await forkBranchAction(chatId("chat-1"), "message-1");
    expect(forkBranchMock).toHaveBeenCalledTimes(2);
  });

  test("clears a rejected fork so the user can retry", async () => {
    forkBranchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(forkBranchAction(chatId("chat-1"), "message-1")).rejects.toThrow("offline");

    forkBranchMock.mockResolvedValueOnce({});
    await forkBranchAction(chatId("chat-1"), "message-1");
    expect(forkBranchMock).toHaveBeenCalledTimes(2);
  });
});

describe("forkBranchAction copySidechat (SC-21)", () => {
  /** Seed the store's active branch (the copy SOURCE) and resolve the fork
   *  with a snapshot whose active branch (the copy TARGET) is `targetId`. */
  function seedForkBranches(sourceId: string, targetId: string): void {
    useSnapshotStore.getState().ingestSnapshot({
      activeBranch: wireBranch({ id: brandId<ChatBranchId>(sourceId) }),
    });
    forkBranchMock.mockResolvedValueOnce({
      activeBranch: wireBranch({ id: brandId<ChatBranchId>(targetId) }),
    });
  }

  test("without the flag the sidechat is never copied (today's flow)", async () => {
    seedForkBranches("br-1", "br-2");
    await forkBranchAction(chatId("chat-1"), "message-1");
    expect(forkBranchMock).toHaveBeenCalledTimes(1);
    expect(forkBranchSidechatMock).not.toHaveBeenCalled();
  });

  test("with the flag the copy POSTs source→target AFTER the fork, in that order", async () => {
    seedForkBranches("br-1", "br-2");
    forkBranchSidechatMock.mockResolvedValueOnce({ copiedThreads: [] });
    await forkBranchAction(chatId("chat-1"), "message-1", { copySidechat: true });
    expect(forkBranchMock).toHaveBeenCalledTimes(1);
    expect(forkBranchSidechatMock).toHaveBeenCalledTimes(1);
    expect(forkBranchSidechatMock).toHaveBeenCalledWith(chatId("chat-1"), "br-1", "br-2");
    expect(forkBranchMock.mock.invocationCallOrder[0]).toBeLessThan(
      forkBranchSidechatMock.mock.invocationCallOrder[0]!,
    );
  });

  test("a failed copy toasts and the fork still stands (no rollback, no throw)", async () => {
    seedForkBranches("br-1", "br-2");
    forkBranchSidechatMock.mockRejectedValueOnce(new Error("copy offline"));
    await forkBranchAction(chatId("chat-1"), "message-1", { copySidechat: true });
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("copy offline");
    expect(useSnapshotStore.getState().activeBranch?.id).toBe("br-2" as ChatBranchId);
  });

  test("two rapid flagged forks ride one request: one fork, one copy", async () => {
    useSnapshotStore.getState().ingestSnapshot({
      activeBranch: wireBranch({ id: brandId<ChatBranchId>("br-1") }),
    });
    let resolveFork: (snapshot: AppSnapshot) => void = () => {};
    forkBranchMock.mockImplementationOnce(() => new Promise<AppSnapshot>((resolve) => { resolveFork = resolve; }));
    forkBranchSidechatMock.mockResolvedValueOnce({ copiedThreads: [] });

    const first = forkBranchAction(chatId("chat-1"), "message-1", { copySidechat: true });
    const duplicate = forkBranchAction(chatId("chat-1"), "message-1", { copySidechat: true });
    expect(forkBranchMock).toHaveBeenCalledTimes(1);
    resolveFork({ activeBranch: wireBranch({ id: brandId<ChatBranchId>("br-2") }) });
    await Promise.all([first, duplicate]);

    expect(forkBranchMock).toHaveBeenCalledTimes(1);
    expect(forkBranchSidechatMock).toHaveBeenCalledTimes(1);
    expect(forkBranchSidechatMock).toHaveBeenCalledWith(chatId("chat-1"), "br-1", "br-2");
  });
});

describe("switchModeAction", () => {
  test("within-bucket play→build flips mode and does not reselect a chat", async () => {
    useChatStore.getState().setActiveChatId(chatId("rp-1"));
    seed([listItem("rp-1", "rp")], "rp-1");
    useNavigationStore.getState().setMode("play");

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useChatStore.getState().activeChatId).toBe(chatId("rp-1"));
    expect(switched).toEqual([]);
  });

  test("no-op when the requested mode equals the current mode", async () => {
    useChatStore.getState().setActiveChatId(chatId("rp-1"));
    seed([listItem("rp-1", "rp")], "rp-1");
    useNavigationStore.getState().setMode("play");

    const switched: ChatId[] = [];
    await switchModeAction("play", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("play");
    expect(switched).toEqual([]);
  });

  test("F-5: exiting coauthor→build selects the RP chat for the same character", async () => {
    // Active chat is coauthor; "back to editor" must cross to the RP chat. The
    // boundary is detected from activeChat.mode (chatMode), NOT navMode.
    useChatStore.getState().setActiveChatId(chatId("co-1"));
    seed([
      listItem("co-1", "coauthor", "char-1", "2026-02-01T00:00:00.000Z"),
      listItem("rp-1", "rp", "char-1", "2026-01-01T00:00:00.000Z"),
    ], "co-1");

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useChatStore.getState().activeChatId).toBe(chatId("rp-1"));
    expect(switched).toEqual([chatId("rp-1")]);
  });

  test("F-5: picks the most-recent RP chat when several exist for the character", async () => {
    useChatStore.getState().setActiveChatId(chatId("co-1"));
    seed([
      listItem("co-1", "coauthor", "char-1", "2026-03-01T00:00:00.000Z"),
      listItem("rp-old", "rp", "char-1", "2026-01-01T00:00:00.000Z"),
      listItem("rp-new", "rp", "char-1", "2026-02-01T00:00:00.000Z"),
    ], "co-1");

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useChatStore.getState().activeChatId).toBe(chatId("rp-new"));
    expect(switched).toEqual([chatId("rp-new")]);
  });

  test("F-5: with no RP chat for the character, clears activeChatId to the placeholder", async () => {
    useChatStore.getState().setActiveChatId(chatId("co-1"));
    seed([listItem("co-1", "coauthor", "char-1")], "co-1");

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useChatStore.getState().activeChatId).toBeNull();
    expect(switched).toEqual([]);
  });

  test("F-5: only considers chats of the active character (ignores other characters' RP chats)", async () => {
    useChatStore.getState().setActiveChatId(chatId("co-1"));
    seed([
      listItem("co-1", "coauthor", "char-1"),
      listItem("rp-other", "rp", "char-2"),
    ], "co-1");

    await switchModeAction("build", { switchChat: async () => {} });

    expect(useChatStore.getState().activeChatId).toBeNull();
  });

  test("no active chat: flips mode only, no reselection", async () => {
    // switchModeAction's sole production caller (CoauthorTopBar "back to editor")
    // requires an active coauthor chat, so an absent active chat is unreachable
    // in practice — the contract here is simply: flip mode, switch no chat.
    seed([listItem("rp-1", "rp", "char-1")], null);

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useChatStore.getState().activeChatId).toBeNull();
    expect(switched).toEqual([]);
  });

  // The old "symmetric build→coauthor" case is intentionally gone. After
  // SURFACE_REGISTRY step 4, "coauthor" is a ChatMode (on the chat), not an
  // AppMode (navMode), so switchModeAction cannot be asked for "coauthor".
  // Switching TO a coauthor chat is done by selecting it in the sidebar
  // (switchChatAction), not by switchModeAction; the registry renders the
  // coauthor surface from activeChat.mode directly.
});

describe("deleteChatAction", () => {
  test("syncs the refreshed chats list so the deleted chat leaves no ghost", async () => {
    // Seed two chats and make the to-be-deleted one active.
    seed([listItem("c1", "rp"), listItem("c2", "rp")]);
    useChatStore.getState().setActiveChatId(chatId("c1"));

    // Backend returns the post-delete chats list (ChatListResponse) — this is
    // the ghost-chat fix: delete previously returned 204 with no body, so the
    // list refresh relied on a racy fire-and-forget bootstrap.
    deleteChatMock.mockResolvedValue({ chats: [listItem("c2", "rp")] });
    await deleteChatAction(chatId("c1"));

    const state = useSnapshotStore.getState();
    expect(state.chatsById["c1"]).toBeUndefined();       // deleted chat is gone (no ghost)
    expect(state.chatIds).toEqual([chatId("c2")]);         // sibling remains
    expect(useChatStore.getState().activeChatId).toBeNull(); // active cleared
  });
});

describe("selectVariantAction (ordered per-message persist)", () => {
  /** Deferred gate for one selectMessageVariant call: the mock resolves only
   *  when the test releases it, so the suite can observe whether the NEXT
   *  queued POST starts before the previous one settled. */
  function gateCalls(): Array<{ promise: Promise<unknown>; resolve(): void }> {
    const gates: Array<{ promise: Promise<unknown>; resolve(): void }> = [];
    selectMessageVariantMock.mockImplementation(() => {
      let resolve!: (value: AppSnapshot) => void;
      const promise = new Promise<AppSnapshot>((res) => { resolve = res; });
      gates.push({ promise, resolve: () => { resolve({}); } });
      return promise;
    });
    return gates;
  }

  const flush = () => new Promise<void>((res) => setTimeout(res, 0));

  test("rapid back-and-forth swipes persist SEQUENTIALLY — the last swipe is the last write (live defect 2026-09-27)", async () => {
    const gates = gateCalls();
    const first = selectVariantAction(chatId("c1"), "m1", 0);
    const second = selectVariantAction(chatId("c1"), "m1", 1);
    const third = selectVariantAction(chatId("c1"), "m1", 0);
    await flush();
    // Only the FIRST POST started — 2nd/3rd wait for its settlement. The old
    // code fired all three in parallel: arrival order was the browser's to
    // decide, and the DB could land on an EARLIER swipe than the last seen
    // (owner live hit: swiped back and forth, restarted the server, reopened
    // — the image slot showed the wrong variant's image).
    expect(selectMessageVariantMock.mock.calls.length).toBe(1);
    gates[0].resolve();
    await flush();
    expect(selectMessageVariantMock.mock.calls.length).toBe(2);
    gates[1].resolve();
    await flush();
    expect(selectMessageVariantMock.mock.calls.length).toBe(3);
    gates[2].resolve();
    await Promise.all([first, second, third]);
    // Arrival order mirrors swipe order — the last write is variant 0.
    expect(selectMessageVariantMock.mock.calls.map((c) => c[2])).toEqual([0, 1, 0]);
  });

  test("waitForPendingVariantSelections waits for the whole queue, not just the in-flight POST", async () => {
    const gates = gateCalls();
    void selectVariantAction(chatId("c2"), "m1", 0);
    void selectVariantAction(chatId("c2"), "m1", 1);
    await flush();
    expect(selectMessageVariantMock.mock.calls.length).toBe(1);
    let waited = false;
    const waiter = waitForPendingVariantSelections(chatId("c2")).then(() => { waited = true; });
    gates[0].resolve();
    await flush();
    // First POST settled but the second is still queued — the fetch guard
    // must NOT read the snapshot yet (it would miss the queued selection).
    expect(waited).toBe(false);
    gates[1].resolve();
    await waiter;
    expect(waited).toBe(true);
  });

  test("a failed POST toasts and never poisons the queue — the next swipe still persists", async () => {
    selectMessageVariantMock.mockImplementationOnce(() => Promise.reject(new Error("server restarted")));
    selectMessageVariantMock.mockImplementation(async () => ({}));
    const failed = selectVariantAction(chatId("c3"), "m1", 1);
    const next = selectVariantAction(chatId("c3"), "m1", 0);
    await Promise.all([failed, next]);
    expect(selectMessageVariantMock.mock.calls.length).toBe(2);
    expect(selectMessageVariantMock.mock.calls[1][2]).toBe(0);
    expect(toastErrorMock.mock.calls.length).toBe(1);
  });
});

describe("updateChatDynamicPromptAction", () => {
  test("ingests the snapshot and invalidates the active context preview through syncSnapshot", async () => {
    const snapshot: AppSnapshot = {
      activeChat: wireChat({ id: chatId("chat-1"), characterId: characterId("char-1"), mode: "rp", dynamicPrompt: "per-chat content" }),
      activeBranch: wireBranch({ id: brandId<ChatBranchId>("branch-1") }),
    };
    updateChatDynamicPromptMock.mockResolvedValueOnce(snapshot);
    useContextPreviewStore.setState({
      entries: {
        "chat-1::branch-1": { status: "success", preview: null, error: null },
      },
    });

    await updateChatDynamicPromptAction(chatId("chat-1"), "per-chat content");

    expect(updateChatDynamicPromptMock).toHaveBeenCalledWith(chatId("chat-1"), "per-chat content");
    expect(useSnapshotStore.getState().activeChat?.dynamicPrompt).toBe("per-chat content");
    expect(useContextPreviewStore.getState().entries["chat-1::branch-1"]).toBeUndefined();
  });

  test("rejected PATCH propagates the error (caller handles it)", async () => {
    updateChatDynamicPromptMock.mockRejectedValueOnce(new Error("offline"));
    await expect(updateChatDynamicPromptAction(chatId("chat-1"), "content")).rejects.toThrow("offline");
  });
});
