/**
 * @module tts/tts-backend
 *
 * Backend contract for text-to-speech. Each backend (kokoro, openai-compatible,
 * gemini, elevenlabs) implements this interface; the registry (tts-registry.ts)
 * is the single source of truth for per-backend capability flags and factory
 * lookup. Mirrors the providers protocol-registry pattern.
 */

import type { TtsProfileConfig } from "@vibe-tavern/domain";

export interface TtsGenerateRequest {
  text: string;
  voiceId: string;
  speed?: number;
  instructions?: string;
}

export interface TtsAudioResult {
  audio: Buffer | AsyncIterable<Buffer>;
  mime: string;
}

export interface TtsVoiceInfo {
  id: string;
  label: string;
  lang: string;
}

export interface TtsModelInfo {
  id: string;
  label: string;
  /** Aggregator enrichment (OpenRouter-style /models payloads): free-tier
   *  flag, human description and context length parsed when present —
   *  plain OpenAI-compatible servers simply omit them. */
  isFree?: boolean;
  description?: string;
  contextLength?: number;
  /** Per-model voice roster riding the catalog (D22): OpenRouter
   *  `supported_voices` / NanoGPT `supported_parameters.voices`. Aggregator
   *  servers have NO /audio/voices endpoint — the roster is model-scoped
   *  data. Omitted when the catalog reports none (null). */
  voices?: string[];
}

export interface TtsProbeResult {
  ok: boolean;
  detail?: string;
}

export interface TtsCloneRequest {
  name: string;
  referenceAudio: Buffer;
  mimeType: string;
  /** Transcript of the reference audio, for providers whose upload
   *  endpoint requires it (SiliconFlow `text`; MiniMax documents only a
   *  name+file flow). Optional — backends that need it enforce it. */
  referenceText?: string;
}

export type TtsBackendFactory = (config: TtsProfileConfig) => TtsBackend;

/** What a backend can do, surfaced to the UI for feature-detection.
 *  `supportsCloning` gates the profile-editor clone section; the optional
 *  hints (formats / maxSizeMb) drive client-side sample validation. */
export interface TtsBackendCapabilities {
  supportsCloning: boolean;
  /** Accepted sample file extensions (no dot), e.g. ["mp3", "wav"]. */
  formats?: string[];
  /** Maximum sample size in megabytes. */
  maxSizeMb?: number;
  /** Set when the clone upload requires the reference audio's transcript
   *  (SiliconFlow) — drives a conditional field in the shared clone form. */
  cloneRequiresReferenceText?: boolean;
  /** Clone-section caveat key for providers without their own backend slug
   *  (SiliconFlow lives inside openai-compatible): i18n key suffix on the
   *  client. Slugged backends (minimax) gate their hint on the slug instead. */
  cloneCaveatKey?: "siliconflow";
}

export interface TtsBackend {
  generate(req: TtsGenerateRequest): Promise<TtsAudioResult>;
  listVoices(): Promise<TtsVoiceInfo[] | null>;
  listModels?(): Promise<TtsModelInfo[]>;
  probe(): Promise<TtsProbeResult>;
  dispose(): Promise<void>;
  /** Declared AFTER the first listVoices call is the meaningful one for the
   *  openai-compat backend: clone support is learned from which voices
   *  route answered (the /voices library fallback = chatterbox-style upload
   *  endpoint). Callers surface capabilities in the voices response. */
  capabilities(): TtsBackendCapabilities;
  /** Only cloning-capable backends implement this; callers MUST gate on
   *  capabilities().supportsCloning before calling. */
  cloneVoice?(req: TtsCloneRequest): Promise<TtsVoiceInfo>;
}
