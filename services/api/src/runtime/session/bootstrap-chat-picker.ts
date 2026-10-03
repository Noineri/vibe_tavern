/**
 * Pick the chat the app boots into. Prefers the most-recent non-coauthor chat
 * so a reload enters the roleplay surface, falling back to the most recent chat
 * when every chat is a coauthor chat.
 */
export function pickBootstrapChatId<T extends string>(
  orderedIds: readonly T[],
  isCoauthor: (id: T) => boolean,
): T | null {
  if (orderedIds.length === 0) return null;
  return orderedIds.find((id) => !isCoauthor(id)) ?? orderedIds[0] ?? null;
}
