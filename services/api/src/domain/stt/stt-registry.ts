/**
 * @module stt/stt-registry
 *
 * STT backend registry — one {@link SttBackend} factory per
 * {@link SttBackendType}. The single source of truth for per-backend
 * capability flags and factory lookup. Mirrors the TTS backend registry and
 * the providers protocol-registry pattern.
 *
 * The v1 roster has no server-executable backend yet — the OpenAI-compatible
 * adapter lands in ST-5 — so the factory registry ships shaped-but-empty:
 * adapters call {@link registerSttBackend} at import time exactly like TTS
 * adapters, so the next unit plugs in one file. The static capability map
 * below (STT_BACKEND_CAPABILITIES) covers the FULL v1 roster, including the
 * client-side whisper-browser, as pure data — UI code renders capability
 * surfaces from it without a server round-trip.
 */

import { STT_BACKENDS, STT_BACKEND_EMOTION_CAPABILITY } from "@vibe-tavern/domain";
import type { SttBackendType, SttProfileConfig } from "@vibe-tavern/domain";

import { STT_TRANSPORT } from "./stt-backend.js";
import type {
  SttBackend,
  SttBackendCapabilities,
  SttBackendFactory,
} from "./stt-backend.js";

export type { SttBackend, SttBackendFactory } from "./stt-backend.js";
export type { SttBackendCapabilities, SttTransport } from "./stt-backend.js";
export { STT_TRANSPORT } from "./stt-backend.js";
export type { SttBackendType } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Capability data
// ---------------------------------------------------------------------------

/**
 * Static capability flags for the FULL STT roster — pure data, no I/O.
 * Exported so UI code can render capability surfaces (transport badge,
 * API-key field, emotion toggle) without a server round-trip; the
 * server-side STT twin of `TTS_BACKEND_CAPABILITIES` (which lives in
 * `@vibe-tavern/domain` for TTS — ST-1 landed only the slug/profile types in
 * domain, so STT keeps them here where this unit owns the backend surface —
 * EXCEPT the emotion flag, which lives in the domain map
 * STT_BACKEND_EMOTION_CAPABILITY so the web editor and this registry share
 * one source, ST-7).
 */
export const STT_BACKEND_CAPABILITIES: Record<SttBackendType, SttBackendCapabilities> = {
  [STT_BACKENDS.WhisperBrowser]: {
    transport: STT_TRANSPORT.Client,
    openaiCompatible: false,
    // Our transcribeBlob() path is single-shot — the transcript arrives
    // whole; the flag describes OUR transport, not transformers.js.
    supportsStreaming: false,
    emotionAnnotation: STT_BACKEND_EMOTION_CAPABILITY[STT_BACKENDS.WhisperBrowser],
    requiresApiKey: false,
  },
  [STT_BACKENDS.OpenAiCompat]: {
    transport: STT_TRANSPORT.Server,
    openaiCompatible: true,
    // /v1/audio/transcriptions is one multipart request/response — no
    // incremental partials on our adapter.
    supportsStreaming: false,
    emotionAnnotation: STT_BACKEND_EMOTION_CAPABILITY[STT_BACKENDS.OpenAiCompat],
    requiresApiKey: true,
  },
  [STT_BACKENDS.Gemini]: {
    transport: STT_TRANSPORT.Server,
    // Native Interactions REST audio understanding — NOT the OpenAI
    // transcription protocol (ST-7).
    openaiCompatible: false,
    // One Interactions request → one reply with the full transcript — no
    // incremental partials.
    supportsStreaming: false,
    // The first (and so far only) roster backend that annotates tone/
    // emotion alongside the transcript (ST-7).
    emotionAnnotation: STT_BACKEND_EMOTION_CAPABILITY[STT_BACKENDS.Gemini],
    requiresApiKey: true,
  },
};

const KNOWN_SLUGS = new Set<string>(Object.values(STT_BACKENDS));

function isKnownSlug(slug: string): slug is SttBackendType {
  return KNOWN_SLUGS.has(slug);
}

/**
 * Return the static capability flags for a known backend slug.
 * Throws SttUnknownBackendError for an unknown slug.
 */
export function getSttBackendCapabilities(slug: SttBackendType): SttBackendCapabilities {
  if (!isKnownSlug(slug)) {
    throw new SttUnknownBackendError(slug);
  }
  return STT_BACKEND_CAPABILITIES[slug];
}

// ---------------------------------------------------------------------------
// Factory registry
// ---------------------------------------------------------------------------

const factories = new Map<SttBackendType, SttBackendFactory>();

export class SttUnknownBackendError extends Error {
  constructor(slug: string) {
    super(
      `Unknown STT backend '${slug}'. ` +
        `Supported backends: ${Object.values(STT_BACKENDS).join(", ")}.`,
    );
    this.name = "SttUnknownBackendError";
  }
}

export class SttBackendNotRegisteredError extends Error {
  constructor(slug: SttBackendType) {
    super(
      `STT backend '${slug}' has no registered factory. ` +
        `Register it via registerSttBackend() before calling createSttBackend().`,
    );
    this.name = "SttBackendNotRegisteredError";
  }
}

/**
 * Register a factory for a backend slug. Called by adapter modules (ST-5)
 * at import time. Overwrites a previous registration for the same slug
 * (last writer wins) — useful in tests that inject stubs.
 */
export function registerSttBackend(slug: SttBackendType, factory: SttBackendFactory): void {
  if (!isKnownSlug(slug)) {
    throw new SttUnknownBackendError(slug);
  }
  factories.set(slug, factory);
}

/**
 * Create a backend instance for a slug + config.
 * Throws SttUnknownBackendError for an unknown slug, or
 * SttBackendNotRegisteredError for a known slug with no factory.
 */
export function createSttBackend(slug: string, config: SttProfileConfig): SttBackend {
  if (!isKnownSlug(slug)) {
    throw new SttUnknownBackendError(slug);
  }
  const factory = factories.get(slug);
  if (!factory) {
    throw new SttBackendNotRegisteredError(slug);
  }
  return factory(config);
}

/**
 * List all known backend slugs (the v1 roster).
 */
export function listSttBackendSlugs(): SttBackendType[] {
  return [...(Object.values(STT_BACKENDS) as SttBackendType[])];
}

/**
 * Reset all registrations. Test-only helper — not part of the public API
 * surface, but exported so stt-registry.test.ts can isolate registrations
 * between tests without relying on module reload.
 */
export function __resetSttRegistryForTests(): void {
  factories.clear();
}
