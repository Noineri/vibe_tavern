import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";
import type { AppSnapshot, ChatListItem } from "../../app-client.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { useNavigationStore } from "../navigation-store.js";
import { deleteChatAction, forkBranchAction, generateObjectiveTasksAction, switchModeAction } from "./chat-actions.js";

// Mocks for the deleteChatAction tests below. `deleteChat` returns the
// backend's ChatListResponse ({ chats }); the fire-and-forget bootstrap is
// stubbed so it can't race the assertion. Other app-client exports stay real
// (spread), so the switchModeAction tests in this file are unaffected.
const { deleteChatMock, forkBranchMock, generateObjectiveTasksMock } = vi.hoisted(() => ({ deleteChatMock: vi.fn(), forkBranchMock: vi.fn(), generateObjectiveTasksMock: vi.fn() }));
vi.mock("../../app-client.js", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("../../app-client.js");
  return { ...actual, deleteChat: deleteChatMock, forkBranch: forkBranchMock, generateObjectiveTasks: generateObjectiveTasksMock };
});
vi.mock("./bootstrap-actions.js", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("./bootstrap-actions.js");
  return { ...actual, fetchBootstrapAction: vi.fn().mockResolvedValue(undefined) };
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
  const snap = {
    chats,
    ...(active
      ? { activeChat: { id: active.id, characterId: active.characterId, mode: active.mode } }
      : {}),
  } as unknown as AppSnapshot;
  useSnapshotStore.getState().ingestSnapshot(snap);
}

beforeEach(() => {
  deleteChatMock.mockReset();
  forkBranchMock.mockReset();
  generateObjectiveTasksMock.mockReset();
  useSnapshotStore.getState().clear();
  useChatStore.getState().setActiveChatId(null);
  useChatStore.getState().setSelectedCharacterId(null);
  useNavigationStore.getState().setMode("play");
});

describe("generateObjectiveTasksAction", () => {
  test("does not ingest a snapshot that resolves after cancellation", async () => {
    let resolveRequest: (snapshot: AppSnapshot) => void = () => {};
    generateObjectiveTasksMock.mockImplementationOnce(() => new Promise<AppSnapshot>((resolve) => { resolveRequest = resolve; }));
    const controller = new AbortController();

    const pending = generateObjectiveTasksAction(chatId("chat-1"), controller.signal);
    controller.abort();
    resolveRequest({ activeChat: { id: chatId("stale-chat") } } as unknown as AppSnapshot);
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
    deleteChatMock.mockResolvedValue({ chats: [listItem("c2", "rp")] } as unknown as AppSnapshot);
    await deleteChatAction(chatId("c1"));

    const state = useSnapshotStore.getState();
    expect(state.chatsById["c1"]).toBeUndefined();       // deleted chat is gone (no ghost)
    expect(state.chatIds).toEqual([chatId("c2")]);         // sibling remains
    expect(useChatStore.getState().activeChatId).toBeNull(); // active cleared
  });
});
