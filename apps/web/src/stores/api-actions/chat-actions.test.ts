import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";
import type { AppSnapshot, ChatListItem } from "../../app-client.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { useNavigationStore } from "../navigation-store.js";
import { deleteChatAction, switchModeAction } from "./chat-actions.js";

// Mocks for the deleteChatAction tests below. `deleteChat` returns the
// backend's ChatListResponse ({ chats }); the fire-and-forget bootstrap is
// stubbed so it can't race the assertion. Other app-client exports stay real
// (spread), so the switchModeAction tests in this file are unaffected.
const { deleteChatMock } = vi.hoisted(() => ({ deleteChatMock: vi.fn() }));
vi.mock("../../app-client.js", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("../../app-client.js");
  return { ...actual, deleteChat: deleteChatMock };
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
 * Seed the snapshot store with a chats list + optionally an active chat.
 * switchModeAction reads `chatsById`, `chatIds` (recency-sorted on ingest),
 * and `activeChat.characterId`, so this is all the state it needs.
 */
function seed(chats: ChatListItem[], activeChatCharacterId: string | null = "char-1"): void {
  const snap = {
    chats,
    ...(activeChatCharacterId !== null
      ? { activeChat: { characterId: characterId(activeChatCharacterId) } }
      : {}),
  } as unknown as AppSnapshot;
  useSnapshotStore.getState().ingestSnapshot(snap);
}

beforeEach(() => {
  useSnapshotStore.getState().clear();
  useChatStore.getState().setActiveChatId(null);
  useChatStore.getState().setSelectedCharacterId(null);
  useNavigationStore.getState().setMode("play");
});

describe("switchModeAction", () => {
  test("within-bucket play→build flips mode and does not reselect a chat", async () => {
    useChatStore.getState().setActiveChatId(chatId("rp-1"));
    seed([listItem("rp-1", "rp")]);
    useNavigationStore.getState().setMode("play");

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useChatStore.getState().activeChatId).toBe(chatId("rp-1"));
    expect(switched).toEqual([]);
  });

  test("no-op when the requested mode equals the current mode", async () => {
    useChatStore.getState().setActiveChatId(chatId("rp-1"));
    seed([listItem("rp-1", "rp")]);
    useNavigationStore.getState().setMode("play");

    const switched: ChatId[] = [];
    await switchModeAction("play", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("play");
    expect(switched).toEqual([]);
  });

  test("F-5: exiting coauthor→build selects the RP chat for the same character", async () => {
    // A character has both a co-author chat (active) and an RP chat.
    useChatStore.getState().setActiveChatId(chatId("co-1"));
    seed([
      listItem("co-1", "coauthor", "char-1", "2026-02-01T00:00:00.000Z"),
      listItem("rp-1", "rp", "char-1", "2026-01-01T00:00:00.000Z"),
    ]);
    useNavigationStore.getState().setMode("coauthor");

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
    ]);
    useNavigationStore.getState().setMode("coauthor");

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useChatStore.getState().activeChatId).toBe(chatId("rp-new"));
    expect(switched).toEqual([chatId("rp-new")]);
  });

  test("F-5: with no RP chat for the character, clears activeChatId to the placeholder", async () => {
    useChatStore.getState().setActiveChatId(chatId("co-1"));
    seed([listItem("co-1", "coauthor", "char-1")]);
    useNavigationStore.getState().setMode("coauthor");

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
    ]);
    useNavigationStore.getState().setMode("coauthor");

    await switchModeAction("build", { switchChat: async () => {} });

    expect(useChatStore.getState().activeChatId).toBeNull();
  });

  test("symmetric: switching build→coauthor selects the co-author chat for the character", async () => {
    useChatStore.getState().setActiveChatId(chatId("rp-1"));
    seed([
      listItem("rp-1", "rp", "char-1"),
      listItem("co-1", "coauthor", "char-1"),
    ]);
    useNavigationStore.getState().setMode("build");

    const switched: ChatId[] = [];
    await switchModeAction("coauthor", { switchChat: async (id) => { switched.push(id); } });

    expect(useNavigationStore.getState().mode).toBe("coauthor");
    expect(useChatStore.getState().activeChatId).toBe(chatId("co-1"));
    expect(switched).toEqual([chatId("co-1")]);
  });

  test("falls back to selectedCharacterId when no active chat is mounted", async () => {
    // No active chat (activeChat null), but a character is selected — the
    // selectedCharacterId is the anchor for the reselection.
    useChatStore.getState().setSelectedCharacterId("char-1");
    seed([listItem("rp-1", "rp", "char-1")], null);
    useNavigationStore.getState().setMode("coauthor");

    const switched: ChatId[] = [];
    await switchModeAction("build", { switchChat: async (id) => { switched.push(id); } });

    expect(useChatStore.getState().activeChatId).toBe(chatId("rp-1"));
    expect(switched).toEqual([chatId("rp-1")]);
  });
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
