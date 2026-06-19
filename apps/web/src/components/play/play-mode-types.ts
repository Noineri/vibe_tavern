export interface MessageBlockProps {
  /** Message ID — component reads data from store via useDisplayMessage(id) */
  messageId: string;
  /** Index in the list — used for separators and last-message checks */
  index: number;
  /** True iff this is the first assistant message in the chat (greeting logic). Hoisted from MessageList (was an O(n²) per-block useMemo over messageOrder). */
  isFirstAssistant: boolean;
  /** True iff this is the last persisted message (gates regenerate/resend action buttons). Hoisted from MessageList (was derived from a useMessageOrder() subscription inside every block). */
  isLast: boolean;
  /** Role of the preceding persisted message, or null if none — drives the role-breakout separator. Hoisted from MessageList (was read via useMessageOrder() inside every block). */
  prevRole: string | null;
}
