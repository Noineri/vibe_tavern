import { describe, expect, test } from "bun:test";
import type { ChatId, ChatMode, CharacterId } from "@vibe-tavern/domain";
import type { ChatListItem } from "../api/types.js";
import { pickNextChatAfterDelete } from "./next-chat-pick.js";

const chatId = (id: string) => id as ChatId;
const characterId = (id: string) => id as CharacterId;

function chat(input: {
  id: string;
  character?: string;
  mode?: ChatMode;
  updatedAt?: string;
}): ChatListItem {
  return {
    id: chatId(input.id),
    title: `Chat ${input.id}`,
    characterId: characterId(input.character ?? "char-1"),
    characterName: "Character",
    subtitle: "",
    activeBranchLabel: "main",
    mode: input.mode ?? "rp",
    messageCount: 0,
    lastMessageAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("pickNextChatAfterDelete", () => {
  test("picks the freshest remaining chat of the same character and mode", () => {
    const chats = [
      chat({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" }),
      chat({ id: "b", updatedAt: "2026-02-01T00:00:00.000Z" }),
      chat({ id: "deleted", updatedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(pickNextChatAfterDelete(chats, "deleted", "char-1", "rp")?.id).toBe(chatId("b"));
  });

  test("never picks chats of another character", () => {
    const chats = [
      chat({ id: "other", character: "char-2", updatedAt: "2026-05-01T00:00:00.000Z" }),
      chat({ id: "mine", character: "char-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(pickNextChatAfterDelete(chats, "gone", "char-1", "rp")?.id).toBe(chatId("mine"));
  });

  test("deleting an RP chat opens the next RP chat, never a fresher co-author chat (fix pin)", () => {
    // The reported defect: deleting an RP chat after talking to the co-author
    // opened the co-author chat — the pick was character-scoped but mode-blind.
    const chats = [
      chat({ id: "rp-old", mode: "rp", updatedAt: "2026-01-01T00:00:00.000Z" }),
      chat({ id: "rp-deleted", mode: "rp", updatedAt: "2026-02-01T00:00:00.000Z" }),
      chat({ id: "coauthor-fresh", mode: "coauthor", updatedAt: "2026-04-01T00:00:00.000Z" }),
    ];
    expect(pickNextChatAfterDelete(chats, "rp-deleted", "char-1", "rp")?.id).toBe(chatId("rp-old"));
  });

  test("deleting a co-author chat opens the next co-author chat, never the RP chats", () => {
    const chats = [
      chat({ id: "rp-fresh", mode: "rp", updatedAt: "2026-05-01T00:00:00.000Z" }),
      chat({ id: "coauthor-deleted", mode: "coauthor", updatedAt: "2026-02-01T00:00:00.000Z" }),
      chat({ id: "coauthor-old", mode: "coauthor", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(pickNextChatAfterDelete(chats, "coauthor-deleted", "char-1", "coauthor")?.id).toBe(chatId("coauthor-old"));
  });

  test("mode isolation covers every chat mode", () => {
    const chats = [
      chat({ id: "novel-a", mode: "novel", updatedAt: "2026-01-01T00:00:00.000Z" }),
      chat({ id: "group-a", mode: "group", updatedAt: "2026-04-01T00:00:00.000Z" }),
      chat({ id: "novel-deleted", mode: "novel", updatedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(pickNextChatAfterDelete(chats, "novel-deleted", "char-1", "novel")?.id).toBe(chatId("novel-a"));
  });

  test("no same-mode chat of the character left → null (server bootstrap pick applies, F-7 unchanged)", () => {
    const chats = [
      chat({ id: "coauthor-fresh", mode: "coauthor", updatedAt: "2026-04-01T00:00:00.000Z" }),
      chat({ id: "rp-deleted", mode: "rp", updatedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(pickNextChatAfterDelete(chats, "rp-deleted", "char-1", "rp")).toBeNull();
  });

  test("deleted chat absent from the list (deletedMode null) → mode-blind pick, the pre-fix path", () => {
    const chats = [
      chat({ id: "rp-a", mode: "rp", updatedAt: "2026-01-01T00:00:00.000Z" }),
      chat({ id: "coauthor-fresh", mode: "coauthor", updatedAt: "2026-04-01T00:00:00.000Z" }),
    ];
    expect(pickNextChatAfterDelete(chats, "ghost", "char-1", null)?.id).toBe(chatId("coauthor-fresh"));
  });

  test("returns null when nothing of the character remains", () => {
    const chats = [chat({ id: "other", character: "char-2" })];
    expect(pickNextChatAfterDelete(chats, "gone", "char-1", "rp")).toBeNull();
  });
});
