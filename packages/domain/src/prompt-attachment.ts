/** A server-resolved prompt preset snapshot owned by an agent message. */
export interface PromptAttachment {
  presetId: string;
  displayName: string;
  promptText: string;
}
