/**
 * The RP builder for the lightbox's action seam (CA-4g2) — the EXACT calls
 * `AttachmentGrid`'s Lightbox made inline before the seam: the chat routes
 * (`"_"` chat id — the server resolves the chat from the message row) with
 * their original lazy imports, and the `useSnapshotStore.updateMessage`
 * canonical-data writes. Every RP caller goes through this builder, so the
 * RP lightbox's behavior is byte-identical to the pre-seam inline code.
 */
import type { Attachment } from "@vibe-tavern/domain";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import type { LightboxImageActions } from "./AttachmentGrid.js";

export function chatLightboxActions(messageId: string, messageAttachments: readonly Attachment[]): LightboxImageActions {
  return {
    saveDescription: async (att, text) => {
      const { updateAttachmentDescription } = await import("../../api/chat-api.js");
      await updateAttachmentDescription("_", messageId, att.id, text);
    },
    regenerateDescription: async (att, signal) => {
      const { regenerateAttachmentDescription } = await import("../../api/chat-api.js");
      const { description } = await regenerateAttachmentDescription("_", messageId, att.id, { signal });
      return description;
    },
    remove: async (att) => {
      const { deleteAttachment } = await import("../../api/chat-api.js");
      await deleteAttachment("_", messageId, att.id);
    },
    applyLocal: (next) => {
      useSnapshotStore.getState().updateMessage(messageId, { attachments: next });
    },
  };
}
