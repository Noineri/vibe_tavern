import type { Attachment } from "@vibe-tavern/domain";
import type { WireAttachment } from "../api/chat-api.js";

/** Project a draft onto the send contract, never echo server-owned fields.
 * WireAttachment is inferred from the shared attachmentSchema. */
export function toSendAttachment(attachment: Attachment): WireAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    assetId: attachment.assetId,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.tokenCount !== undefined ? { tokenCount: attachment.tokenCount } : {}),
    ...(attachment.type === "audio" ? { purpose: attachment.purpose ?? "voice", durationMs: attachment.durationMs } : {}),
  };
}
