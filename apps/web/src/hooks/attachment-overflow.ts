import { attachmentPromptTokens, type Attachment } from "@vibe-tavern/domain";
import { countTokens } from "../utils/tokenizer.js";

/** Uses the context meter's budget and total, never a second context formula. */
export function estimateAttachmentOverflow({ totalUsed, availableBudget, attachments }: {
  totalUsed: number;
  availableBudget: number;
  attachments: readonly Attachment[];
}) {
  const attachedTokens = attachmentPromptTokens(attachments, countTokens);
  return {
    attachedTokens,
    freeTokens: Math.max(0, availableBudget - totalUsed),
    overflow: availableBudget > 0 && attachedTokens > 0 && totalUsed + attachedTokens > availableBudget,
  };
}
