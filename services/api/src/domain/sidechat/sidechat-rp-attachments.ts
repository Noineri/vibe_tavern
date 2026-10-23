import type { RecentMessage } from "@vibe-tavern/prompt-pipeline";
import { renderAttachmentsAsText, type AttachmentAssetLoader } from "../../infrastructure/ai/vision-gate.js";

/** Live RP prompt visibility is already derived by buildPipelineContext.
 * Render once per message per load, independently of frozen event batches or
 * summary-coverage splits. Never read attachment JSON or run vision/STT here. */
export async function buildRpAttachmentBlocks(
	messages: readonly Pick<RecentMessage, "id" | "attachments">[],
	assetLoader?: AttachmentAssetLoader,
): Promise<ReadonlyMap<string, readonly string[]>> {
	const blocksByMessage = new Map<string, readonly string[]>();
	for (const message of messages) {
		if (!message.attachments?.length || blocksByMessage.has(message.id)) continue;
		blocksByMessage.set(message.id, await renderAttachmentsAsText(message.attachments, assetLoader));
	}
	return blocksByMessage;
}
