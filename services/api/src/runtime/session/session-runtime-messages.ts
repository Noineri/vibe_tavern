import type { DiceRoll, ExperienceAttachmentRow, Message, StoreContainer } from "@vibe-tavern/db";
import { toExperienceMessageReport, type ChatBranchId } from "@vibe-tavern/domain";
import { storeRollToSnapshot } from "../../domain/dice/dice-service.js";
import { storeAttachmentToReportSnapshot } from "../../domain/interactive/experience-report-snapshot.js";
import { mapMessageDto, type MessageDto } from "./session-runtime-dto.js";

/** Shared snapshot/chat read seam. Batch reads only user-message attachment ids,
 * never queries a live session, and never exposes hidden checkpoint columns. */
export async function buildMessagesWithVariants(
  stores: StoreContainer,
  messages: Message[],
  branchId: ChatBranchId,
): Promise<MessageDto[]> {
  const userMessageIds = messages.filter((m) => m.role === "user").map((m) => m.id);
  const [variantsByMessage, diceRollsByMessage, attachmentsByMessage] = await Promise.all([
    stores.messages.getVariantsByBranch(branchId),
    userMessageIds.length > 0
      ? stores.diceRolls.getRollsForMessages(userMessageIds)
      : Promise.resolve(new Map<string, DiceRoll[]>()),
    userMessageIds.length > 0
      ? stores.experiences.getAttachmentsForMessages(userMessageIds)
      : Promise.resolve(new Map<string, ExperienceAttachmentRow[]>()),
  ]);
  return messages.map((message) => {
    const variants = variantsByMessage.get(message.id) ?? [];
    if (message.role !== "user") return mapMessageDto(message, variants);
    const rolls = diceRollsByMessage.get(message.id);
    const reports = (attachmentsByMessage.get(message.id) ?? []).flatMap((attachment) => {
      const report = storeAttachmentToReportSnapshot(attachment);
      return report ? [toExperienceMessageReport(report)] : [];
    });
    return mapMessageDto(message, variants,
      rolls && rolls.length > 0 ? rolls.map(storeRollToSnapshot) : undefined, reports);
  });
}
