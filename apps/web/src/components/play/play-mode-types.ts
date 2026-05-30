export interface MessageBlockProps {
  /** Message ID — component reads data from store via useDisplayMessage(id) */
  messageId: string;
  /** Index in the list — used for separators and last-message checks */
  index: number;
}
