/**
 * @module tts/tts-registry
 *
 * TTS backend registry — one {@link TtsBackend} factory per
 * {@link TtsBackendSlug}. The single source of truth for per-backend
 * capability flags and factory lookup. Mirrors the providers
 * protocol-registry pattern.
 *
 * Capability flags live in `@vibe-tavern/domain` (TTS_BACKEND_CAPABILITIES);
 * this module re-exports accessors and owns factory registration. The
 * exhaustive Record in the domain means adding a TTS_BACKEND slug without
 * flags fails typecheck — the same lock-step prevention property as the
 * providers registry.
 */

import {
  TTS_BACKEND,
  TTS_BACKEND_CAPABILITIES,
} from "@vibe-tavern/domain";
import type {
  TtsBackendCapabilities,
  TtsBackendSlug,
  TtsProfileConfig,
  TtsTransport,
} from "@vibe-tavern/domain";

import type { TtsBackend, TtsBackendFactory } from "./tts-backend.js";

export type { TtsBackend, TtsBackendFactory } from "./tts-backend.js";
export type { TtsBackendCapabilities, TtsBackendSlug, TtsTransport } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Capability access
// ---------------------------------------------------------------------------

const KNOWN_SLUGS = new Set<string>(Object.values(TTS_BACKEND));

function isKnownSlug(slug: string): slug is TtsBackendSlug {
  return KNOWN_SLUGS.has(slug);
}

/**
 * Return the static capability flags for a known backend slug.
 * Throws TtsUnknownBackendError for an unknown slug.
 */
export function getTtsBackendCapabilities(slug: TtsBackendSlug): TtsBackendCapabilities {
  if (!isKnownSlug(slug)) {
    throw new TtsUnknownBackendError(slug);
  }
  return TTS_BACKEND_CAPABILITIES[slug];
}

// ---------------------------------------------------------------------------
// Factory registry
// ---------------------------------------------------------------------------

const factories = new Map<TtsBackendSlug, TtsBackendFactory>();

export class TtsUnknownBackendError extends Error {
  constructor(slug: string) {
    super(
      `Unknown TTS backend '${slug}'. ` +
        `Supported backends: ${Object.values(TTS_BACKEND).join(", ")}.`,
    );
    this.name = "TtsUnknownBackendError";
  }
}

export class TtsBackendNotRegisteredError extends Error {
  constructor(slug: TtsBackendSlug) {
    super(
      `TTS backend '${slug}' has no registered factory. ` +
        `Register it via registerTtsBackend() before calling createTtsBackend().`,
    );
    this.name = "TtsBackendNotRegisteredError";
  }
}

/**
 * Register a factory for a backend slug. Called by adapter modules
 * (TS-4/TS-5/TS-5b) at import time. Overwrites a previous registration for
 * the same slug (last writer wins) — useful in tests that inject stubs.
 */
export function registerTtsBackend(slug: TtsBackendSlug, factory: TtsBackendFactory): void {
  if (!isKnownSlug(slug)) {
    throw new TtsUnknownBackendError(slug);
  }
  factories.set(slug, factory);
}

/**
 * Create a backend instance for a slug + config.
 * Throws TtsUnknownBackendError for an unknown slug, or
 * TtsBackendNotRegisteredError for a known slug with no factory.
 */
export function createTtsBackend(slug: string, config: TtsProfileConfig): TtsBackend {
  if (!isKnownSlug(slug)) {
    throw new TtsUnknownBackendError(slug);
  }
  const factory = factories.get(slug);
  if (!factory) {
    throw new TtsBackendNotRegisteredError(slug);
  }
  return factory(config);
}

/**
 * List all known backend slugs (the v1 roster).
 */
export function listTtsBackendSlugs(): TtsBackendSlug[] {
  return [...(Object.values(TTS_BACKEND) as TtsBackendSlug[])];
}

/**
 * Reset all registrations. Test-only helper — not part of the public API
 * surface, but exported so tts-registry.test.ts can isolate registrations
 * between tests without relying on module reload.
 */
export function __resetTtsRegistryForTests(): void {
  factories.clear();
}

// Re-export domain helper for convenience (callers should not need to import
// @vibe-tavern/domain just for this pure URL classifier).
export { classifyOpenAiCompatTransport } from "@vibe-tavern/domain";


