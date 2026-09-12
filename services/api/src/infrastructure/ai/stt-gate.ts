/**
 * @module infrastructure/ai/stt-gate
 *
 * STT twin of the vision gate (STT_PLAN ST-6): converts audio attachments
 * into persisted transcripts. The mirror is deliberately SIMPLER than the
 * vision path — there is no capability routing at all:
 *
 *  • Voice notes (`purpose === "voice"`, the default) are ALWAYS transcribed
 *    by the configured STT profile before the turn is assembled; the
 *    transcript is persisted into `Attachment.description` (the same
 *    "text populated by a secondary model" field image descriptions use) and
 *    rendered into the prompt as a text part by
 *    `resolveMultimodalContent`'s audio branch.
 *  • Music/ambient clips are playback-only media — never transcribed here,
 *    never injected into the prompt (design decision D2: "always transcribe
 *    voice, never send native audio" applies to voice notes only).
 *
 * An undescribed voice note reaching prompt assembly means no STT profile
 * was configured (or the transcription failed) → `VoiceTranscribeUnavailableError`
 * — the honest configuration error, the mirror of `VisionNotSupportedError`.
 */

import { composeVoiceTranscript, type Attachment } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a voice-note attachment is present but cannot be transcribed:
 * no STT profile is configured, or the transcription step failed.
 *
 * Caught by the route handler (HTTP 422) and the streaming path (SSE error
 * event) — the exact surfacing `VisionNotSupportedError` uses.
 */
export class VoiceTranscribeUnavailableError extends Error {
  constructor(
    public readonly attachmentNames: string[],
  ) {
    super(
      `Cannot process voice messages: no speech-to-text profile is available ` +
      `for transcription (or transcription failed). ` +
      `Attached: ${attachmentNames.join(", ")}`,
    );
    this.name = "VoiceTranscribeUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// transcribeAttachments — the describeAttachments mirror
// ---------------------------------------------------------------------------

/**
 * The transcription call the executor makes per voice-note attachment.
 *
 * Bound upstream (chat-adapter) to the resolved voice-message STT profile:
 * the full `transcribeSttAudio` path (own key → endpoint/vendor auto-match →
 * backend). Receives the loaded audio bytes; returns the transcript and —
 * when the profile is an emotion-capable backend with the toggle on (ST-7) —
 * the tone annotation phrase produced in the same pass.
 */
export type VoiceTranscriber = (audio: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}) => Promise<{ transcript: string; annotation?: string }>;

/** `purpose` discriminator with the domain default applied: absent = voice. */
function isVoiceNote(attachment: Attachment): boolean {
  return attachment.type === "audio" && (attachment.purpose ?? "voice") === "voice";
}

/**
 * Transcribe voice-note audio attachments via the configured STT profile.
 * Returns a map of attachmentId → persisted description: the transcript
 * (stripped of surrounding whitespace), plus — when the transcriber produced
 * a tone annotation (ST-7: emotion-capable backend + profile toggle on) — a
 * trailing `[Voice tone: …]` line the prompt audio branch emits verbatim
 * (see `composeVoiceTranscript`). Empty transcripts are kept as empty
 * strings so the caller can distinguish "transcribed to nothing" from
 * "not transcribed".
 *
 * Mirrors `describeAttachments` (vision-gate): called by the executor when
 * voice-note attachments are present and a profile-backed transcriber is
 * configured; the executor persists the results through the SAME
 * `onAttachmentDescriptions` seam image descriptions use. Never touches
 * music/ambient clips — they are playback-only media, not prompt input.
 */
export async function transcribeAttachments(
  attachments: Attachment[],
  transcriber: VoiceTranscriber,
  assetLoader: (assetId: string) => Promise<Buffer | null>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const att of attachments) {
    if (!isVoiceNote(att)) continue;
    // Abort early between clips — mirrors the describe path's cancellation
    // check (avoids loading + transcribing clips queued after a cancel).
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const loaded = await assetLoader(att.assetId);
    if (!loaded) throw new Error(`Asset not found: ${att.name}`);

    const { transcript, annotation } = await transcriber({
      buffer: loaded,
      mimeType: att.mimeType,
      fileName: att.name,
    });
    results.set(att.id, composeVoiceTranscript(transcript, annotation));
  }

  return results;
}
