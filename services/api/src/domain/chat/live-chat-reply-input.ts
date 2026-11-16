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
  /**
   * DMT-13 (director message tools): the ONE-SHOT request instruction for a
   * SINGLE directed regeneration (request_message_swipe Allow). Assembled as
   * a budgeted `user` `in_chat` layer at depth 1 by the pure pipeline (see
   * PromptAssemblyContext.requestInstruction); absent/null/blank = today's
   * behavior exactly. INTERNAL per-request input — never a persisted chat
   * setting, never inherited: the next ordinary generation omits it. Wired
   * into assemblePromptPreview in DMT-13; the swipe delegate supplies it from
   * DMT-24. Not on LiveChatReplyInput: send/continue carry no instruction.
   */
  requestInstruction?: string | null;
}

export interface LiveChatContinueInput extends Omit<LiveChatReplyInput, "prefill"> {
  messageId: string;
  /** The selected variant's text — resolved server-side by the adapter. */
  continuationText: string;
}
