/**
 * Agent attachment action clients (CA-4d1 routes, CA-4f web wiring) — the
 * agent-shell twin of `attachment-actions-api.ts`: the same four operations
 * on a SENT attachment, addressed by (threadId, messageId, attachmentId)
 * over `/api/experience-copilot/…` instead of the chat routes. Kind-agnostic
 * (every host's threads live on the same routes), so every host consumes
 * this one client — no per-kind copies.
 */
import type { Attachment } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

/** The summarize ladder's optional overrides (CA-4d1): the caller's CURRENT
 *  picker pair; absent fields fall back to the thread's last-used pair, then
 *  the profile default — server-side. */
export interface AgentAttachmentSummaryOptions {
  providerProfileId?: string;
  model?: string;
}

/** POST `…/summarize` — the LLM summary replaces the prompt text; returns
 *  the updated attachment (server counts the summary's tokens). */
export async function summarizeAgentAttachment(
  threadId: string,
  messageId: string,
  attachmentId: string,
  options: AgentAttachmentSummaryOptions,
  signal?: AbortSignal,
): Promise<Attachment> {
  const response = await client.api["experience-copilot"][":threadId"].messages[":messageId"].attachments[":attachmentId"].summarize.$post({
    param: { threadId, messageId, attachmentId },
    json: options,
    ...(signal !== undefined ? { init: { signal } } : {}),
  });
  return unwrapRpc(response);
}

/** POST `…/clear-summary` — drop summary + count, restore the full text. */
export async function clearAgentAttachmentSummary(
  threadId: string,
  messageId: string,
  attachmentId: string,
): Promise<Attachment> {
  const response = await client.api["experience-copilot"][":threadId"].messages[":messageId"].attachments[":attachmentId"]["clear-summary"].$post({
    param: { threadId, messageId, attachmentId },
  });
  return unwrapRpc(response);
}

/** PATCH `…/include-in-prompt` — exclude / restore the attachment. */
export async function setAgentAttachmentIncluded(
  threadId: string,
  messageId: string,
  attachmentId: string,
  included: boolean,
): Promise<{ ok: true }> {
  const response = await client.api["experience-copilot"][":threadId"].messages[":messageId"].attachments[":attachmentId"]["include-in-prompt"].$patch({
    param: { threadId, messageId, attachmentId },
    json: { includeInPrompt: included },
  });
  return unwrapRpc(response);
}

/** DELETE `…/:attachmentId` — remove the row, then the server deletes the
 *  physical asset when no other row references it (SC-20 forks share ids). */
export async function removeAgentAttachment(
  threadId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ ok: true }> {
  const response = await client.api["experience-copilot"][":threadId"].messages[":messageId"].attachments[":attachmentId"].$delete({
    param: { threadId, messageId, attachmentId },
  });
  return unwrapRpc(response);
}
