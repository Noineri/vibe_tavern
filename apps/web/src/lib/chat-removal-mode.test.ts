import { describe, expect, test } from "bun:test";
import type { ChatListItem } from "../api/types.js";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";
import { resolveChatRemovalMode } from "./chat-removal-mode.js";

// Regression seed (reported bug): a character created FROM a co-author chat
// carries its co-author chat alongside new RP chats. The old predicate counted
// ALL chats, so 1 co-author + 1 RP → count 2 → "delete" instead of "clear",
// orphaning the character's only RP chat on trash.

const CID = "char_a" as const;
const otherChar = "char_b" as const;

function chat(id: string, characterId: string, mode: ChatListItem["mode"]): ChatListItem {
  return {
    id: id as ChatId,
    title: id,
    characterId: characterId as CharacterId,
    characterName: id,
    subtitle: "",
    mode,
    lastMessageAt: "",
    updatedAt: "",
    activeBranchLabel: "",
    messageCount: 0,
  };
}

describe("resolveChatRemovalMode", () => {
  test("single RP chat → clear (preserve the character's last RP chat)", () => {
    const chats = [chat("rp1", CID, "rp")];
    expect(resolveChatRemovalMode(chats, "rp1" as ChatId, CID)).toBe("clear");
  });

  test("multiple RP chats for same character → delete the targeted one", () => {
    const chats = [chat("rp1", CID, "rp"), chat("rp2", CID, "rp")];
    expect(resolveChatRemovalMode(chats, "rp1" as ChatId, CID)).toBe("delete");
  });

  // ── Regression: co-author chats must not inflate the RP count ──────────
  test("1 RP + 1 coauthor → clear on the RP chat (coauthor excluded from count)", () => {
    const chats = [chat("rp1", CID, "rp"), chat("ca1", CID, "coauthor")];
    expect(resolveChatRemovalMode(chats, "rp1" as ChatId, CID)).toBe("clear");
  });

  test("2 RP + several coauthor → delete on an RP chat (counts RP only)", () => {
    const chats = [
      chat("rp1", CID, "rp"),
      chat("rp2", CID, "rp"),
      chat("ca1", CID, "coauthor"),
      chat("ca2", CID, "coauthor"),
    ];
    expect(resolveChatRemovalMode(chats, "rp1" as ChatId, CID)).toBe("delete");
  });

  // ── Co-author target is always deletable ───────────────────────────────
  test("lone coauthor chat → delete (deleting all coauthor chats is normal)", () => {
    const chats = [chat("ca1", CID, "coauthor")];
    expect(resolveChatRemovalMode(chats, "ca1" as ChatId, CID)).toBe("delete");
  });

  test("coauthor chat alongside RP → delete on the coauthor (not promoted to clear)", () => {
    const chats = [chat("rp1", CID, "rp"), chat("ca1", CID, "coauthor")];
    expect(resolveChatRemovalMode(chats, "ca1" as ChatId, CID)).toBe("delete");
  });

  // ── Scoping: other characters' chats don't count ───────────────────────
  test("RP chats of OTHER characters don't affect this character's count", () => {
    const chats = [
      chat("rp1", CID, "rp"),
      chat("other_rp", otherChar, "rp"),
      chat("other_rp2", otherChar, "rp"),
    ];
    expect(resolveChatRemovalMode(chats, "rp1" as ChatId, CID)).toBe("clear");
  });

  // ── Edge cases ─────────────────────────────────────────────────────────
  test("no chats list → delete (safe default)", () => {
    expect(resolveChatRemovalMode(undefined, "x" as ChatId, CID)).toBe("delete");
  });

  test("target chat absent, fallback characterId resolves scope", () => {
    const chats = [chat("rp1", CID, "rp")];
    // targetChatId not in list — fallback to characterId, count its RP chats
    expect(resolveChatRemovalMode(chats, "missing" as ChatId, CID)).toBe("clear");
  });

  test("target chat absent and no fallback characterId → delete", () => {
    expect(resolveChatRemovalMode([], "missing" as ChatId, undefined)).toBe("delete");
  });
});
