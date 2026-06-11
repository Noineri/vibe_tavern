// ─── Attachment types ───────────────────────────────────────────────────────
//
// Core domain types for file attachments in chat messages.
// The `type` field determines how the prompt pipeline handles the attachment.
// `mimeType` is the actual content type used for provider-specific formatting.

/** Determines how the prompt pipeline processes this attachment. */
export type AttachmentType = "image" | "file" | "video";

/** A single file attached to a chat message. */
export interface Attachment {
  /** Unique attachment ID (used to correlate vision descriptions back to specific attachments). */
  id: string;
  /** Reference to the stored asset file in AssetService. */
  assetId: string;
  /** Kind of attachment — determines pipeline handling (image → ImagePart, file → TextPart, video → frame extraction). */
  type: AttachmentType;
  /** Original filename as provided by the client. */
  name: string;
  /** MIME type (e.g. "image/png", "application/json"). Used for provider-specific formatting. */
  mimeType: string;
  /** File size in bytes. */
  sizeBytes: number;
  /**
   * Text description of the attachment, populated by the vision model
   * when the primary model lacks vision but a vision fallback model is configured.
   * Null = not yet described or not applicable.
   */
  description?: string | null;
}

// ─── MIME classification ────────────────────────────────────────────────────

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const VIDEO_MIMES = new Set([
  "video/webm",
  "video/mp4",
]);

const TEXT_MIMES = new Set([
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/yaml",
  "text/x-jsonl",
]);

/**
 * Classify a MIME type into a broad attachment category.
 * The pipeline uses `type` to decide processing; `mimeType` is kept
 * for provider-specific formatting (e.g. image format detection).
 */
export function classifyAttachment(mimeType: string): AttachmentType {
  if (IMAGE_MIMES.has(mimeType)) return "image";
  if (VIDEO_MIMES.has(mimeType)) return "video";
  return "file";
}

/** Check whether a MIME type represents inline-able text content. */
export function isTextMime(mimeType: string): boolean {
  return TEXT_MIMES.has(mimeType);
}
