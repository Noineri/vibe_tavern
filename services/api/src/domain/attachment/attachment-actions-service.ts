import { isTextMime, type Attachment, type AttachmentPatch } from "@vibe-tavern/domain";
import type { AttachmentAssetLoader } from "../../infrastructure/ai/vision-gate.js";
import { countTokensDefault } from "../../infrastructure/ai/tokenizer-service.js";
import { DomainError, notFound, validation } from "../../shared/errors.js";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

export type { AttachmentPatch } from "@vibe-tavern/domain";

/** Each surface resolves its own message/variant ownership and persists only
 * the patch. The service neither imports a store nor replaces an attachment set. */
export interface AttachmentMessagePort {
  find(messageId: string, attachmentId: string): Promise<Attachment | null>;
  update(messageId: string, attachmentId: string, patch: AttachmentPatch): Promise<Attachment>;
}

export interface AttachmentTarget {
  messageId: string;
  attachmentId: string;
}

export interface AttachmentSummaryGenerateInput {
  systemPrompt: string;
  text: string;
  signal?: AbortSignal;
}

/** The caller owns provider/model resolution and its ordinary error handling. */
export type AttachmentSummaryGenerate = (input: AttachmentSummaryGenerateInput) => Promise<string>;

export interface SummarizeAttachmentInput extends AttachmentTarget {
  generate: AttachmentSummaryGenerate;
  assetLoader: AttachmentAssetLoader;
  signal?: AbortSignal;
}

export const ATTACHMENT_ACTION_ERROR_CODE = {
  notText: "attachment_not_text",
  assetMissing: "attachment_asset_missing",
  summaryEmpty: "attachment_summary_empty",
} as const;

async function requireTextAttachment(port: AttachmentMessagePort, target: AttachmentTarget): Promise<Attachment> {
  const attachment = await port.find(target.messageId, target.attachmentId);
  if (attachment === null) throw notFound("Attachment");
  if (attachment.type !== "file" || !isTextMime(attachment.mimeType)) {
    throw validation("Only text-file attachments support this action.", { code: ATTACHMENT_ACTION_ERROR_CODE.notText });
  }
  return attachment;
}

/** One full-file model call, then one patch. Cancellation and provider errors
 * leave the stored summary untouched, even if generate resolves after abort. */
export async function summarize(port: AttachmentMessagePort, input: SummarizeAttachmentInput): Promise<Attachment> {
  input.signal?.throwIfAborted();
  const attachment = await requireTextAttachment(port, input);
  input.signal?.throwIfAborted();
  const buffer = await input.assetLoader(attachment.assetId);
  input.signal?.throwIfAborted();
  if (buffer === null) {
    // notFound() has no details argument; preserve the NotFound HTTP family
    // while carrying the action's machine-readable code.
    throw new DomainError({
      kind: "NotFound",
      resource: "AttachmentAsset",
      message: `The asset for attachment "${attachment.name}" is no longer available.`,
      details: { code: ATTACHMENT_ACTION_ERROR_CODE.assetMissing },
    });
  }
  const systemPrompt = await loadPromptAsset("attachment-summarize.md");
  input.signal?.throwIfAborted();
  const summary = (await input.generate({
    systemPrompt,
    text: new TextDecoder().decode(buffer),
    signal: input.signal,
  })).trim();
  input.signal?.throwIfAborted();
  if (!summary) {
    throw validation("The model returned an empty summary.", { code: ATTACHMENT_ACTION_ERROR_CODE.summaryEmpty });
  }
  return port.update(input.messageId, input.attachmentId, {
    description: summary,
    summaryTokenCount: countTokensDefault(summary),
  });
}

export async function clearSummary(port: AttachmentMessagePort, input: AttachmentTarget): Promise<Attachment> {
  await requireTextAttachment(port, input);
  return port.update(input.messageId, input.attachmentId, { description: null, summaryTokenCount: null });
}

export async function setIncluded(
  port: AttachmentMessagePort,
  input: AttachmentTarget & { included: boolean },
): Promise<Attachment> {
  await requireTextAttachment(port, input);
  return port.update(input.messageId, input.attachmentId, { includeInPrompt: input.included });
}
