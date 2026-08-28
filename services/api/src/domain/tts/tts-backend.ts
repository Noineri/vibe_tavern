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
}

export interface TtsProbeResult {
  ok: boolean;
  detail?: string;
}

export interface TtsCloneRequest {
  name: string;
  referenceAudio: Buffer;
  mimeType: string;
}

export type TtsBackendFactory = (config: TtsProfileConfig) => TtsBackend;

export interface TtsBackend {
  generate(req: TtsGenerateRequest): Promise<TtsAudioResult>;
  listVoices(): Promise<TtsVoiceInfo[] | null>;
  listModels?(): Promise<TtsModelInfo[]>;
  probe(): Promise<TtsProbeResult>;
  dispose(): Promise<void>;
  /**
   * Reserved seam (deferred owner decision): only a future cloning-capable
   * backend implements this. v1 ships none — callers must gate on
   * capabilities.supportsCloning before calling.
   */
  cloneVoice?(req: TtsCloneRequest): Promise<TtsVoiceInfo>;
}
