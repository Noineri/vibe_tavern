import type { PromptPresetId } from "@vibe-tavern/domain";
import type { LiveChatSendInput } from "./live-chat-send-input.js";

/** Reply paths reuse the send contract, without new-user-message state. */
export type LiveChatReplyInput = Pick<LiveChatSendInput,
  "chatId" | "profile" | "model" | "transport" | "prefill" | "signal" | "visionAssets" | "voiceTranscriber"
>;

export interface LiveChatRegenerateInput extends LiveChatReplyInput {
  messageId: string;
  /**
   * Optional per-request prompt preset override (Wave Q1b). When set, the
   * assembled prompt uses this preset instead of the chat's `promptPresetId`,
   * WITHOUT mutating the chat row. Undefined → existing cascade (unchanged).
   * Wired into assemblePromptPreview in Q1b; accepted here from Q1a so the
   * adapter can thread it without a second signature change.
   */
  presetId?: PromptPresetId;
}

export interface LiveChatContinueInput extends Omit<LiveChatReplyInput, "prefill"> {
  messageId: string;
  /** The selected variant's text — resolved server-side by the adapter. */
  continuationText: string;
}
