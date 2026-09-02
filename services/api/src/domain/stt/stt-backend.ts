/**
 * @module stt/stt-backend
 *
 * Backend contract for speech-to-text. Each backend (whisper-browser,
 * openai-compat) implements this interface; the registry (stt-registry.ts)
 * is the single source of truth for per-backend capability flags and factory
 * lookup. Mirrors the TTS backend contract and the providers
 * protocol-registry pattern.
 */

import type { SttProfileConfig } from "@vibe-tavern/domain";

/** Where a transcription actually executes. The v1 roster spans exactly two
 *  spots: the user's browser (whisper-browser, transformers.js) or a server
 *  we call (openai-compat). Kept as an `as const` object + derived type —
 *  no TS enum. */
export const STT_TRANSPORT = {
  Server: "server",
  Client: "client",
} as const;
export type SttTransport = (typeof STT_TRANSPORT)[keyof typeof STT_TRANSPORT];

/** Static capability flags per backend slug, surfaced to the UI for
 *  feature-detection — the server-side STT twin of
 *  `TTS_BACKEND_CAPABILITIES` (which lives in `@vibe-tavern/domain`; STT
 *  keeps them here because ST-1 landed only the slug/profile types in domain
 *  and this unit owns the backend surface). `transport` and the boolean
 *  flags describe OUR integration, not the vendor's endpoint capabilities. */
export interface SttBackendCapabilities {
  /** Where the transcription executes: `"server"` (openai-compat) or
   *  `"client"` (in-browser whisper-browser). */
  transport: SttTransport;
  /** Talks the OpenAI-compatible `/v1/audio/transcriptions` shape. */
  openaiCompatible: boolean;
  /** Whether our integration yields incremental partial transcripts.
   *  Both v1 backends are single-shot — the transcript arrives whole — so
   *  the flag is `false` for the entire v1 roster. */
  supportsStreaming: boolean;
  /** Whether the backend annotates tone/emotion into the transcript
   *  (ST-7 seam). Pure-ASR backends (whisper-browser, openai-compat) are
   *  `false`; the UI hides and forces off the toggle for them. */
  emotionAnnotation: boolean;
  /** Whether a server/cloud backend requires its own API key. In-browser
   *  whisper needs none; openai-compat may resolve its key via auto-key
   *  reuse at the adapter (ST-5). */
  requiresApiKey: boolean;
}

/** Input for one transcription call: raw audio bytes plus the MIME type
 *  needed to forward/transcode them. Server backends receive `audio` parsed
 *  from multipart; the client-side backend path lives in the app, not here. */
export interface SttTranscribeOptions {
  /** MIME type of the audio payload ("audio/webm", "audio/mp3", ...). */
  mime: string;
  /** Optional language hint (BCP-47-ish) — passed through when the backend
   *  supports it, otherwise ignored. */
  language?: string;
}

/** A transcription result. `text` is the transcript; `language` is present
 *  when the backend reports it back (OpenAI-compatible responses carry it);
 *  `annotation` carries the tone/emotion phrase a Gemini-class understanding
 *  backend produced in the SAME pass (ST-7) — present only when the profile
 *  toggle was on and the backend actually annotated. */
export interface SttTranscribeResult {
  text: string;
  language?: string;
  annotation?: string;
}

/** Probe outcome — normalized so callers never catch an "unreachable"
 *  backend as an exception boundary; failures are reported as
 *  `{ ok: false, detail }`. */
export interface SttProbeResult {
  ok: boolean;
  detail?: string;
}

/** One entry in a live model catalog (OpenAI-compatible `/models` payloads,
 *  filtered to transcription-capable models). */
export interface SttModelInfo {
  id: string;
  label: string;
  /** Aggregator enrichment (OpenRouter-style /models payloads): free-tier
   *  flag and human description parsed when present — plain
   *  OpenAI-compatible servers simply omit them. */
  isFree?: boolean;
  description?: string;
}

export type SttBackendFactory = (config: SttProfileConfig) => SttBackend;

export interface SttBackend {
  /** Transcribe one audio payload into text. `audio` is the raw bytes and
   *  `options.mime` its format; models/language/key are resolved from the
   *  profile config by the factory. */
  transcribe(
    audio: Buffer | ArrayBuffer,
    options: SttTranscribeOptions,
  ): Promise<SttTranscribeResult>;
  /** Live model discovery for OpenAI-compatible endpoints (ST-5). Optional —
   *  in-browser whisper has a fixed transformers.js model id, so it omits
   *  this. */
  listModels?(): Promise<SttModelInfo[]>;
  /** Verify the backend is reachable/configurable (mirrors TTS `probe`). */
  probe(): Promise<SttProbeResult>;
  /** Release any held resources (sessions, caches). Idempotent-safe. */
  dispose(): Promise<void>;
}
