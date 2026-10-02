import type { ChatMode } from "@vibe-tavern/domain";
import type { ChatListItem } from "../api/types.js";

/**
 * Pick the chat to switch to after a delete: the freshest remaining chat of
 * the same character AND the same chat mode as the deleted one, `updatedAt`
 * descending (the sidebar "recent" order). Same-mode scoping is the fix for
 * the BUILD_MODE_F5_RESTORE_REPORT B defect: a fresher co-author chat used to
 * win over the character's RP chats after an RP delete (and vice versa) —
 * the modes must never cross (owner 2026-09-30: «они не должны пересекаться»).
 * Extracted from `useCharacterController.handleDeleteChat` so the pick is
 * unit-testable; the hook keeps the delete/switch choreography.
 *
 * `deletedMode: null` covers the defensive path where the deleted chat is not
 * in the list at all (no mode to match): the pick stays mode-blind, exactly
 * the pre-fix behavior for that path.
 */
export function pickNextChatAfterDelete(
  chats: readonly ChatListItem[],
  deletedChatId: string,
  characterId: string,
  deletedMode: ChatMode | null,
): ChatListItem | null {
  const remaining = chats
    .filter(
      (c) =>
        c.id !== deletedChatId &&
        c.characterId === characterId &&
        (deletedMode === null || c.mode === deletedMode),
    )
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return remaining[0] ?? null;
}
