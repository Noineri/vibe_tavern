/**
 * Vision gate — converts image/video attachments into AI SDK content parts.
 *
 * Routing is decided by the PRIMARY model's vision capability, NOT by whether
 * a description exists (the description is only consulted on the non-vision
 * path). This asymmetry is what makes vision/non-vision model switching safe:
 *
 *  • Vision primary  → images are sent as ImageParts (pixels). The
 *    fallback-vision model describes them IN PARALLEL via the executor so a
 *    future non-vision reroll can ingest them as text. On the vision path the
 *    description is intentionally ignored — the vision model wants pixels.
 *  • Non-vision primary → the executor describes the image FIRST (via the
 *    configured fallback-vision model), then this gate sends only the textual
 *    description. A raw undescribed image reaching the non-vision path means
 *    no fallback was configured → VisionNotSupportedError.
 *
 * `describeAttachments` (the parallel/first describe step) lives here too; the
 * executor calls it and persists descriptions before/assembling each turn.
 */

import type { Attachment } from "@vibe-tavern/domain";
import type { ImagePart, TextPart } from "ai";
import type { SdkMessage } from "./provider-executor-utils.js";
import { prepareImageForVision } from "../../shared/image-compress.js";
import { resolveSystemPrompt } from "../../domain/ai-assistant/ai-assistant-prompts.js";
import { splitReasoningFromText, type ReasoningSplitState } from "../../domain/ai-assistant/reasoning-split.js";

// ---------------------------------------------------------------------------
// Vision describe prompt resolution
// ---------------------------------------------------------------------------

// `vision_describe` is a real AiAssistantMode, so its prompt resolves through
// the SAME fallback chain as the other modes (preset override → default .md),
// via the shared `resolveSystemPrompt`. This kills the duplicate candidate-path
// list + cache that used to live here, leaving a single source of truth for
// where prompt .md files are loaded from.

/**
 * Resolve the vision describe system prompt via the shared assistant fallback
 * chain (preset `vision_describe` override → default `vision-describe-ai-prompt.md`).
 */
export async function resolveVisionDescribePrompt(
  aiAssistantPrompts: Record<string, string> | null,
): Promise<string> {
  const { prompt } = await resolveSystemPrompt("vision_describe", { aiAssistantPrompts });
  return prompt;
}

/**
 * Strip model reasoning (<think>…</think>, reasoning markers) from a complete
 * (non-streaming) generated description. Reuses the assistant's splitter so the
 * describe path benefits from the same reasoning hygiene as the assistant modal.
 */
function stripReasoning(fullText: string): string {
  const state: ReasoningSplitState = {
    buffer: "",
    insideMarkerReasoning: false,
    insideThinkTag: false,
  };
  let text = "";
  for (const chunk of splitReasoningFromText(state, fullText)) {
    if (chunk.type === "text" && chunk.text) text += chunk.text;
  }
  for (const chunk of splitReasoningFromText(state, "", { flush: true })) {
    if (chunk.type === "text" && chunk.text) text += chunk.text;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Vision gate config
// ---------------------------------------------------------------------------

export interface VisionGateConfig {
  /** Whether the primary model supports vision natively. */
  hasVision: boolean;
  /** Vision model slug from the same provider profile (or null if not configured). */
  visionModel: string | null;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when image/video attachments are present but the model cannot process
 * them and no vision fallback model is configured.
 *
 * Caught by the route handler and returned as HTTP 422.
 */
export class VisionNotSupportedError extends Error {
  constructor(
    public readonly attachmentNames: string[],
  ) {
    super(
      `Cannot process images: the active model does not support vision ` +
      `and no vision model is configured in this provider profile. ` +
      `Attached: ${attachmentNames.join(", ")}`,
    );
    this.name = "VisionNotSupportedError";
  }
}

// ---------------------------------------------------------------------------
// resolveMultimodalContent
// ---------------------------------------------------------------------------

/**
 * Convert a message + its attachments into AI SDK ContentPart[].
 *
 * Image/video attachments that have already been described (type changed to
 * "file" with a description field) are handled as text — no further vision
 * processing needed.
 *
 * For raw image/video attachments:
 * - If hasVision → load asset and create ImagePart
 * - If no hasVision → throw VisionNotSupportedError
 *   (the executor should have already described them if a visionModel was set)
 */
export async function resolveMultimodalContent(
  message: SdkMessage,
  gate: VisionGateConfig,
  assetLoader: (assetId: string) => Promise<Buffer | null>,
): Promise<Array<TextPart | ImagePart>> {
  const parts: Array<TextPart | ImagePart> = [];

  // Always include text content
  if (message.content) {
    parts.push({ type: "text", text: message.content });
  }

  if (!message.attachments?.length) return parts;

  // ── Vision routing (ASYMMETRIC by design) ───────────────────────────────
  // The primary model's vision capability decides how image/video attachments
  // are rendered. `description` presence matters ONLY on the non-vision path.
  //
  //  • Vision primary  → images are sent as ImageParts (pixels) directly.
  //    The fallback-vision model describes them IN PARALLEL (executor path 2)
  //    purely so a FUTURE non-vision reroll can ingest them as text. The
  //    description is intentionally ignored for THIS send — the vision model
  //    wants the pixels. (Even a DB-loaded image with a persisted description
  //    is re-sent as an ImagePart when the active model has vision.)
  //
  //  • Non-vision primary → the fallback-vision model MUST have described the
  //    image first (executor runs describeAttachments before calling us). We
  //    send only the textual description — no pixels. A raw undescribed image
  //    reaching here means no fallback was configured (or the describe step
  //    failed) → VisionNotSupportedError.
  //
  // Routing invariant: the DB persists `type: "image"` + `description`; only
  // the executor's in-memory copy flips `type` to `"file"`. So we route by
  // `hasVision` first, then by `description` only on the non-vision path.
  const imageVideoAttachments = message.attachments.filter(
    (a) => a.type === "image" || a.type === "video",
  );
  const otherAttachments = message.attachments.filter(
    (a) => a.type !== "image" && a.type !== "video",
  );

  // Non-image/video attachments (e.g. files) → text when they carry a
  // description; otherwise dropped (no native multimodal handling). Same on
  // both paths — these never need vision.
  for (const att of otherAttachments) {
    if (att.description?.trim()) {
      parts.push({
        type: "text",
        text: `[Attached ${att.type}: ${att.name}]\n${att.description}`,
      });
    }
  }

  if (imageVideoAttachments.length === 0) return parts;

  if (gate.hasVision) {
    // Vision primary: always pixels, regardless of whether a description
    // exists (description is a parallel artifact for future non-vision rerolls).
    for (const att of imageVideoAttachments) {
      let buffer = await assetLoader(att.assetId);
      if (!buffer) {
        throw new Error(`Asset file not found for attachment: ${att.name}`);
      }
      let mimeType = att.mimeType;

      // Compress large PNGs to JPEG for provider size limits. Centralized in
      // prepareImageForVision so describeAttachments (gallery / non-vision
      // fallback) stays in sync — a prior drift left it sending raw images.
      const prepared = prepareImageForVision(buffer, mimeType);
      buffer = prepared.buffer;
      mimeType = prepared.mimeType;

      parts.push({
        type: "image",
        image: buffer,
        mediaType: mimeType,
      });
    }
    return parts;
  }

  // Non-vision primary: described images → textual description; raw → error.
  const describedImages = imageVideoAttachments.filter((a) => a.description?.trim());
  const rawImages = imageVideoAttachments.filter((a) => !a.description?.trim());

  for (const att of describedImages) {
    parts.push({
      type: "text",
      text: `[Image attachment: ${att.name}]\nImage description: ${att.description}`,
    });
  }

  if (rawImages.length > 0) {
    // The executor should have described these (vision fallback configured).
    // Reaching here means no fallback was set OR describe failed — honest error.
    throw new VisionNotSupportedError(rawImages.map((a) => a.name));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// describeAttachments — vision fallback path
// ---------------------------------------------------------------------------

/**
 * Describe image/video attachments using a vision fallback model.
 * Returns a map of attachmentId → description text.
 *
 * Called by the executor when attachments are present and a visionModel
 * is configured — regardless of whether the primary model has vision.
 */
export async function describeAttachments(
  attachments: Attachment[],
  visionModel: string,
  profile: { providerPreset: string; endpoint: string; apiKey: string | null },
  assetLoader: (assetId: string) => Promise<Buffer | null>,
  systemPrompt?: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Lazy import to avoid circular deps at module level
  const { mapProfileToSdkModel } = await import("./provider-profile-mapper.js");
  const { generateText } = await import("ai");

  const { model } = mapProfileToSdkModel(profile, visionModel);
  const resolvedPrompt = systemPrompt?.trim() || "Describe this image in detail.";

  for (const att of attachments) {
    if (att.type !== "image" && att.type !== "video") continue;
    const loaded = await assetLoader(att.assetId);
    if (!loaded) throw new Error(`Asset not found: ${att.name}`);

    // Compress before sending — providers reject large uncompressed images as
    // "too large". Gallery rows can be up to the 20MB upload cap, and this same
    // path serves the chat non-vision fallback, so the shared
    // prepareImageForVision seam (same one resolveMultimodalContent uses) is
    // mandatory here. Never throws — falls back to original bytes on failure.
    const { buffer, mimeType } = prepareImageForVision(loaded, att.mimeType);

    // Abort early if a cancellation arrived between images. generateText
    // itself takes abortSignal, but checking here avoids the per-image load
    // + compression work for images queued after the user cancelled.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const response = await generateText({
      model,
      system: resolvedPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", image: buffer, mediaType: mimeType },
        ],
      }],
      maxOutputTokens: 1500,
      abortSignal: signal,
    });

    // Strip reasoning (<think>…, markers) so chain-of-thought never leaks into
    // the persisted description. Vision models frequently emit reasoning when
    // describing images; without this it floods the lightbox caption and the
    // model's context on subsequent turns.
    const cleaned = stripReasoning(response.text).trim();
    results.set(att.id, cleaned || response.text.trim());
  }

  return results;
}
