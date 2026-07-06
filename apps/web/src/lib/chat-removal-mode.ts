import type { ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "../api/types.js";
import type { ChatRemovalMode } from "../hooks/use-character-controller.js";

/**
 * Pure decision: should the trash action on `targetChatId` "clear" (recreate
 * fresh, preserving the character's last RP chat) or "delete" (remove
 * outright)? Used by the character controller's `getChatRemovalMode`.
 *
 * Rule (per spec):
 * - Only **RP** chats are eligible for "clear on last chat". A co-author chat
 *   is always "delete" — deleting every co-author chat of a character is
 *   normal, intentional behavior (the co-author surface is a scratch/editor
 *   surface, not the persistent roleplay).
 * - For an RP target: if the character has ≤1 RP chat, "clear" (don't let the
 *   user orphan the character); otherwise "delete".
 * - `fallbackCharacterId` covers the active-chat edge where the target chat
 *   row may be absent from the list but the snapshot's `character.id` is the
 *   relevant scope.
 *
 * Extracted from the hook so this data-loss-adjacent decision is unit-testable
 * without mocking a dozen stores.
 */
export function resolveChatRemovalMode(
  chats: ChatListItem[] | undefined,
  targetChatId: ChatId,
  fallbackCharacterId: string | undefined,
): ChatRemovalMode {
  if (!chats) return "delete";
  const targetChat = chats.find((c) => c.id === targetChatId);
  const characterId = targetChat?.characterId ?? fallbackCharacterId;
  if (!characterId) return "delete";

  // Co-author (or any non-rp mode) → always deletable.
  if (targetChat && targetChat.mode !== "rp") return "delete";

  const rpChatCount = chats.filter(
    (c) => c.characterId === characterId && c.mode === "rp",
  ).length;
  return rpChatCount <= 1 ? "clear" : "delete";
}
