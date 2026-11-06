import { brandId, effectiveContextBudget } from "@vibe-tavern/domain";
import type { MessageId, PromptPresetId, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { LiveChatRegenerateInput } from "./live-chat-reply-input.js";

/** The assemblePromptPreview options shape for ONE regeneration (structural —
 *  the caller passes them to `ChatRuntime.assemblePromptPreview`; this module
 *  stays domain-leaf and imports no runtime type). */
export interface RegenerationPromptOptions {
  excludeMessageId: MessageId;
  model: string;
  contextBudget: number | null;
  responseReserve: number;
  presetId?: PromptPresetId;
  requestInstruction?: string | null;
}

/**
 * Regeneration prompt options shared by BOTH orchestrator regeneration paths
 * (DMT-13). Extracted from live-chat-orchestrator.ts, which previously
 * duplicated this exact derivation in `regenerateMessage` and
 * `regenerateMessageStream` — one derivation, two consumers, so the paths
 * cannot drift (the orchestrator is over the arch-gate size baseline and may
 * not grow, hence the sibling-module extraction, same pattern as
 * live-chat-reply-prompt.ts / live-chat-stream-start.ts).
 *
 * Derives the options for ONE regeneration:
 * - `excludeMessageId` — the target message stays out of the history exactly
 *   as in ordinary regeneration (the caller's pinned target, never a later
 *   visible-branch change);
 * - `presetId` — the per-request preset override rides when supplied
 *   (Wave Q1b), chat row untouched;
 * - `requestInstruction` — the DMT-13 one-shot instruction rides ONLY when
 *   the caller supplied it (absent/null/blank = ordinary regeneration
 *   byte-for-byte); it is a request-local assembly input, never persisted.
 */
export function regenerationPromptOptions(
  input: LiveChatRegenerateInput,
  provider: { profile: StoredProviderProfileRecord; model: string },
): RegenerationPromptOptions {
  return {
    excludeMessageId: brandId<MessageId>(input.messageId),
    model: provider.model,
    contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
    responseReserve: provider.profile.maxTokens,
    presetId: input.presetId,
    requestInstruction: input.requestInstruction,
  };
}
