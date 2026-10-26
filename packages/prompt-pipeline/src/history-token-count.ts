import { attachmentPromptTokens } from "@vibe-tavern/domain";
import { estimateTokens } from "./compaction.js";
import type { RecentMessage } from "./types.js";

/** The existing text-only history representation; attachment content stays on
 *  its message for the executor, never copied into the history layer's text. */
export function formatRecentMessages(messages: ReadonlyArray<RecentMessage>): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
    .join("\n\n");
}

/** One history cost for compaction and the trace/meter: the exact formatted
 *  message text plus visible file weights. Attachments are filtered upstream. */
export function countHistoryTokens(messages: ReadonlyArray<RecentMessage>): number {
  return estimateTokens(formatRecentMessages(messages))
    + messages.reduce((total, message) => total + attachmentPromptTokens(message.attachments, estimateTokens), 0);
}
