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
  /** Prompt visibility, decided by {@link filterPromptVisibleAttachments}.
   *  Image-gen slots are opt-in (IG-18): absent or false = OFF; only true
   *  includes them. Enabling requires a description or generation prompt
   *  (server-enforced) for the non-vision executor path.
   *  Ordinary uploads are included when absent or true; explicit false
   *  excludes them. The text-file include route writes this flag in Wave 2. */
  includeInPrompt?: boolean;
  /** Text files only: token count of the file's full text, computed once by
   *  the server at upload (UTF-8 decode, BOM stripped, default encoder) and
   *  carried on the attachment. Absent on images, audio, video and on files
   *  uploaded before the count existed. */
  tokenCount?: number;
  /** Text files only: token count of the summary stored in {@link description}.
   *  Written by the server's summarize action together with the summary and
   *  cleared with it; absent while the file is not summarized. */
  summaryTokenCount?: number;
  /** Image-gen-only: slot provenance (IMAGE_GENERATION_PLAN IG-14, design:
   *  "a message carrying a single image attachment + provenance metadata:
   *  mode, profileId, model, effective params, seed") — exactly the design
   *  fields, no more. Rides the attachment entry the same way audio carries
   *  `purpose`/`durationMs`; regeneration (IG-18) reads it to rebuild a
   *  request. Absent on ordinary uploads. */
  imageGen?: ImageGenSlotProvenance;
}

/** Only action-owned fields: omitted means unchanged; a null summary count
 * asks the storage port to REMOVE the field, not persist a null count. */
export interface AttachmentPatch {
  description?: string | null;
  summaryTokenCount?: number | null;
  includeInPrompt?: boolean;
}

/** Apply the shared action patch without mutating the stored attachment. */
export function applyAttachmentPatch(attachment: Attachment, patch: AttachmentPatch): Attachment {
  const updated = { ...attachment };
  if (patch.description !== undefined) updated.description = patch.description;
  if (patch.includeInPrompt !== undefined) updated.includeInPrompt = patch.includeInPrompt;
  if (patch.summaryTokenCount === null) delete updated.summaryTokenCount;
  else if (patch.summaryTokenCount !== undefined) updated.summaryTokenCount = patch.summaryTokenCount;
  return updated;
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
  model?: string;  /** The FINAL assembled image prompt (IG-CF6): the exact text sent to the
   *  backend — template + macros + chip edits + assist all resolved. Stamped
   *  at generation time so the slot can show what was asked (owner
   *  2026-09-15: "the model's prompt is nowhere visible; it should also be
   *  displayed in the image slot"). Absent on legacy slots
   *  generated before CF6 — free-form JSON inside attachmentsJson, no
   *  migration. */
  prompt?: string;
  /** C-A (owner 2026-09-19, ruling recorded in the plan repo): the assist
   *  LLM model that AUTHORED the prompt — a deliberately unaccented note
   *  (the authoring model is stated plainly, without emphasis) —
   *  stamped only when the IG-15 assist actually fired for the run (lazy:
   *  free-mode and verbatim chip-edit runs never stamp it). Absent = the
   *  prompt is template/user text (or a legacy pre-C-A slot). Rendered as a
   *  quiet suffix on the MR-8 accordion header. */
  promptBy?: string;
  /** Effective generation params sent with the request. */
  params: {
    width?: number;
    height?: number;
    steps?: number;
    cfgScale?: number;
    cfgRescale?: number;
    sampler?: string;
    /** Schedule type (PG-3, A1111 dialect) — recorded when sent so a
     *  regenerated slot reproduces the same schedule. */
    scheduler?: string;
    /** Text-encoder file (CG-A2, ComfyUI DiT template) — recorded when
     *  sent so a regenerated slot reproduces the same sidecar. */
    encoderName?: string;
    /** VAE file (CG-A2, ComfyUI DiT template) — recorded when sent. */
    vaeName?: string;
    /** VAE override for swappable-slot dialects (IF-7b) — recorded when
     *  sent so a regenerated slot reproduces the same VAE. */
    vae?: string;
    /** Workflow template the backend RESOLVED for the generation (CG-A2,
     *  ComfyUI: "checkpoint" | "krea2-dit") — the adapter picks it by
     *  model auto-detect, so it is recorded from the RESULT, not the
     *  request. Absent on other backends and legacy slots. */
    template?: string;
    /** Enabled LoRAs of the run (CG-C2, capability-gated backends) —
     *  name + strength as sent, so a regenerated variant reproduces the
     *  same stack. Absent when the run carried none. */
    loras?: Array<{ name: string; strength: number }>;
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
  "audio/mp4",
  "audio/mpeg",
  "audio/x-wav",
  "audio/flac",
]);

/**
 * The ONE source of text-file attachment types: MIME -> stored extension.
 * Insertion order matters for {@link textMimeForExtension}: the first MIME
 * listed for an extension is its canonical one (`.jsonl` -> `application/x-ndjson`;
 * `text/x-jsonl` is accepted as an alias). The asset service derives its upload
 * allow-list, extension fallback and served Content-Type from this map.
 */
export const TEXT_MIME_TO_EXT: Readonly<Record<string, string>> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "application/x-ndjson": "jsonl",
  "text/x-jsonl": "jsonl",
  "text/csv": "csv",
};

const TEXT_MIMES: ReadonlySet<string> = new Set(Object.keys(TEXT_MIME_TO_EXT));

const TEXT_EXT_TO_MIME: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [mime, ext] of Object.entries(TEXT_MIME_TO_EXT)) {
    if (!map.has(ext)) map.set(ext, mime);
  }
  return map;
})();

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

/** Sum the prompt weight of already-visible attachments without reading assets.
 *  Text files use their full count, or their summary count while summarized.
 *  Legacy summaries without a count use the caller's text estimator; legacy
 *  full files without a count and all non-text attachments weigh zero.
 *  Visibility belongs to {@link filterPromptVisibleAttachments}, not this helper. */
export function attachmentPromptTokens(
  attachments: ReadonlyArray<Attachment> | undefined,
  estimateText: (text: string) => number,
): number {
  let total = 0;
  for (const attachment of attachments ?? []) {
    if (!isTextMime(attachment.mimeType)) continue;
    total += attachment.description?.trim()
      ? (attachment.summaryTokenCount ?? estimateText(attachment.description))
      : (attachment.tokenCount ?? 0);
  }
  return total;
}

/** Canonical text MIME for a file extension (case-insensitive, with or without
 *  the leading dot), or null when the extension is not a text-attachment type. */
export function textMimeForExtension(extension: string): string | null {
  return TEXT_EXT_TO_MIME.get(extension.replace(/^\./, "").toLowerCase()) ?? null;
}

/** Canonical text MIME derived from a file name's extension, or null when the
 *  name has no extension or the extension is not a text-attachment type. */
export function textMimeForFileName(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? null : textMimeForExtension(fileName.slice(dot + 1));
}

/** Shared browser/server upload rule: OS text MIME guesses yield to a known
 *  text extension, but a reported media type always keeps its meaning. */
export function resolveAttachmentUploadMime(reportedMime: string, fileName: string): string {
  const mime = reportedMime.split(";", 1)[0].trim().toLowerCase();
  const media = IMAGE_MIMES.has(mime) || AUDIO_MIMES.has(mime)
    || mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/");
  return media ? mime : (textMimeForFileName(fileName) ?? mime);
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
 * the assembled prompt unless includeInPrompt is explicitly true. Ordinary
 * uploads (images, voice notes, files) are included when the flag is absent
 * or true, and excluded only by explicit false. This is the ONE visibility
 * rule for every prompt consumer. Without
 * this gate a slot in history would ride the executor's multimodal path
 * unconditionally: pixels for vision primaries, and a hard
 * VisionNotSupportedError on every later RP turn for non-vision primaries
 * (the slot's image is undescribed — the describe step covers only the
 * current user message's attachments). */
export function filterPromptVisibleAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((a) => a.imageGen !== undefined
    ? a.includeInPrompt === true
    : a.includeInPrompt !== false);
}

/** The shared stored-row projection used by RP and Co-Author history.
 * Empty columns omit the field; present columns retain RP's empty-list shape
 * even when every attachment is excluded or the JSON cannot be parsed. */
export function promptVisibleAttachmentsOf(raw: string | null | undefined): Attachment[] | undefined {
  if (!raw) return undefined;
  return promptVisibleAttachments(parseStoredAttachments(raw) ?? []);
}

/** The same prompt projection for consumers that already hold parsed rows. */
export function promptVisibleAttachments(attachments: Attachment[]): Attachment[] {
  return withImageGenPromptFallback(filterPromptVisibleAttachments(attachments));
}

/** Textual fallback for included image-gen slots (IMAGE_GENERATION_PLAN
 *  IG-CF9): when a slot IS included in the prompt (`includeInPrompt === true`
 *  — the explicit per-slot eye button, no auto-describing), its textual
 *  representation falls back to its OWN generation prompt (`description ??
 *  provenance.prompt`). Zero AI calls, semantically honest (the image is
 *  described by what was asked).
 *
 *  Apply AFTER {@link filterPromptVisibleAttachments} at assembly (the
 *  filter is the include gate; this function backfills text only). The
 *  backfilled description rides the EXISTING described-image text path
 *  (`[Image attachment: name]\nImage description: …`) with zero
 *  special-casing: on a non-vision primary the vision gate sends the prompt
 *  text instead of throwing VisionNotSupportedError, and on a vision primary
 *  the gate ignores the description and sends pixels as usual. Legacy slots
 *  without `prompt` are unaffected — they keep today's behavior. Pure: never
 *  mutates its input (untouched items keep their reference; backfilled items
 *  are shallow copies). */
export function withImageGenPromptFallback(attachments: Attachment[]): Attachment[] {
  return attachments.map((a) => {
    if (a.imageGen === undefined) return a;
    if (a.description?.trim()) return a;
    const prompt = a.imageGen.prompt;
    if (prompt === undefined || prompt.trim() === "") return a;
    return { ...a, description: prompt };
  });
}
