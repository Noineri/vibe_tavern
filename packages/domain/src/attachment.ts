// ─── Attachment types ───────────────────────────────────────────────────────
//
// Core domain types for file attachments in chat messages.
// The `type` field determines how the prompt pipeline handles the attachment.
// `mimeType` is the actual content type used for provider-specific formatting.

import { log } from "./logger.js";

/** Determines how the prompt pipeline processes this attachment. */
export type AttachmentType = "image" | "file" | "video" | "audio";

/** Intent of an audio attachment (STT_PLAN ST-1): `voice` notes are
 *  transcribed and prompt-visible; `music`/`ambient` clips are playback-only
 *  and never transcribed or injected into the prompt. Absent purpose means
 *  "voice" — the default (the executor transcribes only `purpose === "voice"`). */
export type AudioPurpose = "voice" | "music" | "ambient";

/** A single file attached to a chat message. */
export interface Attachment {
  /** Unique attachment ID (used to correlate vision descriptions back to specific attachments). */
  id: string;
  /** Reference to the stored asset file in AssetService. */
  assetId: string;
  /** Kind of attachment — determines pipeline handling (image → ImagePart, file → TextPart, video → frame extraction, audio → voice transcript). */
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
   * For audio attachments this field carries the STT transcript (STT_PLAN ST-6).
   */
  description?: string | null;
  /** Audio-only: intent discriminator (`voice` | `music` | `ambient`).
   *  Absent = "voice" (the default — see {@link AudioPurpose}). */
  purpose?: AudioPurpose;
  /** Audio-only: clip length in milliseconds (voice-message bubble UI). */
  durationMs?: number;
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

// STT_PLAN ST-1: audio attachments (voice notes, music, ambient loops). Only
// `purpose === "voice"` clips are transcribed (ST-6); music/ambient stay
// playback-only. `audio/x-m4a` and `audio/m4a` both listed — iOS/FFmpeg
// exporters disagree on the canonical m4a type (STT_DESIGN AUDIO_MIMES).
const AUDIO_MIMES = new Set([
  "audio/webm",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/x-m4a",
  "audio/m4a",
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
  if (AUDIO_MIMES.has(mimeType)) return "audio";
  return "file";
}

/** Check whether a MIME type represents inline-able text content. */
export function isTextMime(mimeType: string): boolean {
  return TEXT_MIMES.has(mimeType);
}

// ─── Stored attachment parsing ──────────────────────────────────────────────

/**
 * Parse a stored `attachmentsJson` column into typed {@link Attachment}s.
 *
 * Backfills a stable `id` on legacy rows that were persisted without one
 * (pre-fix Zod stripped the client-provided id). Without a stable id, vision
 * descriptions collide on `undefined` keys and the edit/regenerate UI gate
 * (`att.id`) fails. The generated id is volatile across reads — callers that
 * need persistence should write the normalized value back.
 *
 * Returns `undefined` when the column is empty or holds no attachments so
 * callers can omit the field entirely from their DTOs.
 */
export function parseStoredAttachments(raw: string | null | undefined): Attachment[] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.tag("attachments").warn("failed to parse attachmentsJson: %s", err instanceof Error ? err.message : String(err));
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  return parsed.map((a) =>
    a && typeof a === "object" && "id" in a && typeof a.id === "string" && a.id
      ? (a as Attachment)
      : { ...(a as object), id: crypto.randomUUID() } as Attachment,
  );
}
