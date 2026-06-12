/**
 * Vision gate — converts image/video attachments into AI SDK content parts.
 *
 * Three paths:
 * 1. Primary model has vision → send as ImagePart directly
 * 2. No vision, but vision fallback model configured → describe first, then text
 *    (description is done by the executor before calling resolveMultimodalContent)
 * 3. No vision, no fallback → throw VisionNotSupportedError
 *
 * The executor handles path 2 (describeAttachments) separately.
 * This module handles paths 1 and 3.
 */

import type { Attachment } from "@vibe-tavern/domain";
import type { SdkMessage } from "./provider-executor-utils.js";
import { compressForVision, isCompressibleImage } from "../image-compress.js";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// Vision describe prompt resolution
// ---------------------------------------------------------------------------

const VISION_DESCRIBE_PROMPT_FILE = "vision-describe-ai-prompt.md";
let _cachedDefaultPrompt: string | null = null;

async function loadDefaultVisionDescribePrompt(): Promise<string> {
  if (_cachedDefaultPrompt !== null) return _cachedDefaultPrompt;

  const candidates = [
    process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR
      ? join(process.env.RP_PLATFORM_AI_ASSISTANT_PROMPTS_DIR, VISION_DESCRIBE_PROMPT_FILE)
      : null,
    join(resolve(process.execPath, ".."), "prompts", VISION_DESCRIBE_PROMPT_FILE),
    resolve(import.meta.dir, "..", "..", "assets", VISION_DESCRIBE_PROMPT_FILE),
    join(process.cwd(), "services", "api", "assets", VISION_DESCRIBE_PROMPT_FILE),
    resolve(import.meta.dir, "..", VISION_DESCRIBE_PROMPT_FILE),
    resolve(import.meta.dir, "..", "..", "..", "..", "out", "services", "api", VISION_DESCRIBE_PROMPT_FILE),
    join(process.cwd(), "out", "services", "api", VISION_DESCRIBE_PROMPT_FILE),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (await Bun.file(path).exists()) {
      _cachedDefaultPrompt = await Bun.file(path).text();
      return _cachedDefaultPrompt;
    }
  }

  _cachedDefaultPrompt = "Describe this image in detail.";
  return _cachedDefaultPrompt;
}

/**
 * Resolve the vision describe system prompt.
 *
 * Priority:
 * 1. `vision_describe` key in the preset's `aiAssistantPrompts` JSON
 * 2. Default `vision-describe-ai-prompt.md` file
 * 3. Hardcoded fallback
 */
export async function resolveVisionDescribePrompt(
  aiAssistantPrompts: Record<string, string> | null,
): Promise<string> {
  if (aiAssistantPrompts) {
    const override = aiAssistantPrompts["vision_describe"]?.trim();
    if (override) return override;
  }
  return loadDefaultVisionDescribePrompt();
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
): Promise<Array<{ type: "text"; text: string } | { type: "image"; image: Buffer; mediaType?: string }>> {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: Buffer; mediaType?: string }> = [];

  // Always include text content
  if (message.content) {
    parts.push({ type: "text", text: message.content });
  }

  if (!message.attachments?.length) return parts;

  // Collect image/video attachments that still need vision processing
  const visionAttachments = message.attachments.filter(
    (a) => a.type === "image" || a.type === "video",
  );

  // Handle already-described attachments (executor ran describeAttachments first)
  const describedAttachments = message.attachments.filter(
    (a) => a.description,
  );
  for (const att of describedAttachments) {
    parts.push({
      type: "text",
      text: `[Attached ${att.type}: ${att.name}]\n${att.description}`,
    });
  }

  if (visionAttachments.length === 0) return parts;

  // If we still have raw image/video attachments at this point, the primary
  // model MUST have vision. If it doesn't, the executor failed to describe
  // them (no vision model configured) — honest error.
  if (!gate.hasVision) {
    throw new VisionNotSupportedError(
      visionAttachments.map((a) => a.name),
    );
  }

  // Primary model has vision — load assets as ImageParts
  for (const att of visionAttachments) {
    if (att.description) continue; // already handled above
    let buffer = await assetLoader(att.assetId);
    if (!buffer) {
      throw new Error(`Asset file not found for attachment: ${att.name}`);
    }
    let mimeType = att.mimeType;

    // Compress large PNGs to JPEG for provider size limits
    if (isCompressibleImage(mimeType)) {
      try {
        const compressed = compressForVision(buffer, mimeType);
        buffer = compressed.buffer;
        mimeType = compressed.mimeType;
      } catch {
        // If compression fails, send original — let the provider decide
      }
    }

    parts.push({
      type: "image",
      image: buffer,
      mediaType: mimeType,
    });
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
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Lazy import to avoid circular deps at module level
  const { mapProfileToSdkModel } = await import("./provider-profile-mapper.js");
  const { generateText } = await import("ai");

  const { model } = mapProfileToSdkModel(profile, visionModel);
  const resolvedPrompt = systemPrompt?.trim() || "Describe this image in detail.";

  for (const att of attachments) {
    if (att.type !== "image" && att.type !== "video") continue;
    const buffer = await assetLoader(att.assetId);
    if (!buffer) throw new Error(`Asset not found: ${att.name}`);

    const response = await generateText({
      model,
      system: resolvedPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", image: buffer, mediaType: att.mimeType },
        ],
      }],
      maxOutputTokens: 1500,
    });

    results.set(att.id, response.text);
  }

  return results;
}
