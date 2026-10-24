// Single-attachment edits for the agent message store (CA-4a2).
// The read and set rewrite share a synchronous transaction: no await can
// interleave a sibling edit between them. Assets belong to the API layer.
import { eq, sql } from 'drizzle-orm';
import { applyAttachmentPatch, parseStoredAttachments, type Attachment, type AttachmentPatch } from '@vibe-tavern/domain';
import type { AppDb } from '../db-connection.js';
import { experienceCopilotMessages } from '../db-schema.js';

export async function findMessageAttachment(db: AppDb, messageId: string, attachmentId: string): Promise<Attachment | null> {
  const row = db.select({ attachmentsJson: experienceCopilotMessages.attachmentsJson })
    .from(experienceCopilotMessages).where(eq(experienceCopilotMessages.id, messageId)).get();
  return parseStoredAttachments(row?.attachmentsJson)?.find((attachment) => attachment.id === attachmentId) ?? null;
}

/** Re-read the entire set inside the transaction, then edit just one member.
 * A missing target is idempotent and never rewrites the column. */
function editMessageAttachment(
  db: AppDb,
  messageId: string,
  attachmentId: string,
  edit: (attachment: Attachment) => Attachment | null,
): Attachment | null {
  return db.transaction((tx) => {
    const row = tx.select({ attachmentsJson: experienceCopilotMessages.attachmentsJson })
      .from(experienceCopilotMessages).where(eq(experienceCopilotMessages.id, messageId)).get();
    const attachments = parseStoredAttachments(row?.attachmentsJson) ?? [];
    const index = attachments.findIndex((attachment) => attachment.id === attachmentId);
    if (index === -1) return null;
    const original = attachments[index];
    const updated = edit(original);
    if (updated === null) attachments.splice(index, 1);
    else attachments[index] = updated;
    tx.update(experienceCopilotMessages)
      .set({ attachmentsJson: attachments.length ? JSON.stringify(attachments) : null })
      .where(eq(experienceCopilotMessages.id, messageId)).run();
    return updated ?? original;
  });
}

export async function updateMessageAttachment(db: AppDb, messageId: string, attachmentId: string, patch: AttachmentPatch): Promise<Attachment | null> {
  return editMessageAttachment(db, messageId, attachmentId, (attachment) => applyAttachmentPatch(attachment, patch));
}

export async function removeMessageAttachment(db: AppDb, messageId: string, attachmentId: string): Promise<Attachment | null> {
  return editMessageAttachment(db, messageId, attachmentId, () => null);
}

/** Fork copies share asset ids. Check every row, including archived threads
 * and prompt-excluded attachments, before deleting a physical asset. */
export async function hasMessageAttachmentAssetReference(db: AppDb, assetId: string): Promise<boolean> {
  return db.select({ id: experienceCopilotMessages.id }).from(experienceCopilotMessages)
    .where(sql`exists (
      select 1 from json_each(case when json_valid(${experienceCopilotMessages.attachmentsJson}) then ${experienceCopilotMessages.attachmentsJson} else '[]' end) as attachment
      where case when attachment.type = 'object' then json_extract(attachment.value, '$.assetId') end = ${assetId}
    )`).limit(1).get() !== undefined;
}
