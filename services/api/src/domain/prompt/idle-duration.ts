interface TimestampedChatMessage {
  role: string;
  createdAt: string;
}

/**
 * ST's idle duration starts before the current user turn.
 * When a user message is the latest stored message, select the preceding user
 * turn; otherwise select the latest user message on the active branch.
 */
export function priorUserMessageCreatedAt(messages: readonly TimestampedChatMessage[]): string | null {
  const userMessages = messages.filter((message) => message.role === "user");
  const priorUserMessage = messages.at(-1)?.role === "user"
    ? userMessages.at(-2)
    : userMessages.at(-1);
  return priorUserMessage?.createdAt ?? null;
}
