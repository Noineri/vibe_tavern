// ─── Attachment types ───────────────────────────────────────────────────────
//
// Core domain types for file attachments in chat messages.
// The `type` field determines how the prompt pipeline handles the attachment.
// `mimeType` is the actual content type used for provider-specific formatting.

import { log } from "./logger.js";
import type { ImageGenerationMode } from "./entities.js";

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
  /** Image-gen-slot only (IMAGE_GENERATION_PLAN IG-18; design: "per-image
   *  'include in prompt' opt-in (default off — pure illustration)"). Absent =
   *  OFF — the assembly drops the slot's attachment from the RP prompt
   *  entirely (see {@link filterPromptVisibleAttachments}). Enabling requires
   *  a vision description (server-enforced) so the non-vision executor path
   *  always has text to send. Ordinary user uploads never carry this flag
   *  and keep their always-included behavior. */
  includeInPrompt?: boolean;
  /** Image-gen-only: slot provenance (IMAGE_GENERATION_PLAN IG-14, design:
   *  "a message carrying a single image attachment + provenance metadata:
   *  mode, profileId, model, effective params, seed") — exactly the design
   *  fields, no more. Rides the attachment entry the same way audio carries
   *  `purpose`/`durationMs`; regeneration (IG-18) reads it to rebuild a
   *  request. Absent on ordinary uploads. */
  imageGen?: ImageGenSlotProvenance;
}

/** Provenance stamped on every attachment of an image-gen slot message
 *  (IG-14). `params` = the effective values actually SENT to the backend
 *  (request overrides > per-mode size preset > profile default params; only
 *  fields the request carried — no invented values, the owner's constants
 *  ban); `seed` = the seed the backend REPORTED using (actuals differ from
 *  the requested `params.seed` when the vendor resolves its own). */
export interface ImageGenSlotProvenance {
  /** The generation-mode recipe the slot was built from. */
  mode: ImageGenerationMode;
  /** The image-gen profile used (regeneration target). */
  profileId: string;
  /** Effective model id (override > profile; absent = vendor default). */
  model?: string;
  /** Effective generation params sent with the request. */
  params: {
    width?: number;
    height?: number;
    steps?: number;
    cfgScale?: number;
    sampler?: string;
    seed?: number;
    clipSkip?: number;
  };
  /** Backend-reported actual seed (A1111 resolves -1; cloud vendors omit). */
  seed?: number;
}

// ─── Voice transcript + tone line (STT_PLAN ST-7) ─────────────────────────────

/** Marker prefix of the tone line a Gemini-class understanding backend
 *  appends to the persisted transcript (ST-7). Literal ENGLISH — stored data
 *  is literal English (house rule); the tone VALUE itself is model-generated
 *  text in the speech's language. */
export const VOICE_TONE_MARKER = "[Voice tone: ";

/** Compose the persisted `Attachment.description` for a transcribed voice
 *  note: the verbatim transcript, plus — when the backend produced a tone
 *  annotation and the profile toggle was on — a trailing bracketed line the
 *  prompt audio branch emits verbatim ("rides the prompt as a bracketed
 *  context line", ST-7). */
export function composeVoiceTranscript(transcript: string, tone?: string): string {
  const text = transcript.trim();
  const annotation = tone?.trim();
  if (text === "") return "";
  if (annotation === undefined || annotation === "") return text;
  return `${text}\n${VOICE_TONE_MARKER}${annotation}]`;
}

/** Split a persisted voice-note description back into transcript + tone.
 *  The inverse of {@link composeVoiceTranscript} — the chat bubble uses it to
 *  render the transcript block and the tone line separately. Tolerates
 *  descriptions without a tone line (pure-ASR backends) and a tone line in
 *  the middle of the text (treats everything after the marker as tone). */
export function splitVoiceTranscript(description: string): { transcript: string; tone: string | null } {
  const idx = description.indexOf(VOICE_TONE_MARKER);
  if (idx === -1) return { transcript: description, tone: null };
  const transcript = description.slice(0, idx).trim();
  let tone = description.slice(idx + VOICE_TONE_MARKER.length);
  if (tone.endsWith("]")) tone = tone.slice(0, -1);
  return { transcript, tone: tone.trim() === "" ? null : tone.trim() };
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

/** Prompt-visibility filter for message attachments (IG-18): generated image
 * slots are pure illustration by default — the attachment is dropped from
 * the assembled prompt unless the per-image opt-in is ON. Everything else
 * (user uploads, voice notes, files) keeps its existing behavior. Without
 * this gate a slot in history would ride the executor's multimodal path
 * unconditionally: pixels for vision primaries, and a hard
 * VisionNotSupportedError on every later RP turn for non-vision primaries
 * (the slot's image is undescribed — the describe step covers only the
 * current user message's attachments). */
export function filterPromptVisibleAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((a) => a.imageGen === undefined || a.includeInPrompt === true);
}

