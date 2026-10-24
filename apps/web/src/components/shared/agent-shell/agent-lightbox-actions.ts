/**
 * The agent-shell builder for the lightbox's action seam (CA-4g2) — the
 * shell's twin of `chat-lightbox-actions.ts`: the three actions over the
 * CA-4g1 agent routes (thread-scoped, regenerate carrying the shell picker's
 * CURRENT profile + model) and `applyLocal` = the CA-4f context's settle
 * refresh — the ONE refetch path, never a second one (no snapshot-store
 * write: the agent shell owns no message store).
 */
import type { LightboxImageActions } from "../../chat/AttachmentGrid.js";
import {
  regenerateAgentAttachmentDescription,
  removeAgentAttachment,
  updateAgentAttachmentDescription,
} from "../../../api/agent-attachment-actions-api.js";
import type { AgentAttachmentActionsContextValue } from "./agent-attachment-actions-context.js";

export function agentLightboxActions(ctx: AgentAttachmentActionsContextValue, messageId: string): LightboxImageActions {
  const options = {
    ...(ctx.providerProfileId !== null ? { providerProfileId: ctx.providerProfileId } : {}),
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
  };
  return {
    saveDescription: async (att, text) => {
      await updateAgentAttachmentDescription(ctx.threadId, messageId, att.id, text);
    },
    regenerateDescription: async (att, signal) => {
      const { description } = await regenerateAgentAttachmentDescription(ctx.threadId, messageId, att.id, options, signal);
      return description;
    },
    remove: async (att) => {
      await removeAgentAttachment(ctx.threadId, messageId, att.id);
    },
    applyLocal: () => {
      ctx.refreshMessages();
    },
  };
}
