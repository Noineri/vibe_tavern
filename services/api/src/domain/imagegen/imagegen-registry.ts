/**
 * @module imagegen/imagegen-registry
 *
 * Image-gen backend registry — one {@link ImageGenBackend} factory per
 * {@link ImageGenBackendType}. The single source of truth for per-backend
 * capability flags and factory lookup. Mirrors the STT/TTS registries and
 * the providers protocol-registry pattern (IMAGE_GENERATION_PLAN IG-4).
 *
 * The v1 factories (openrouter, openai-images, a1111) register at import
 * time from their adapter modules (IG-5..IG-7) exactly like the STT/TTS
 * adapters; this unit ships the registry shaped-but-empty so each adapter
 * plugs in as one file. The static capability map below covers the FULL v1
 * roster as pure data — the Providers editor snapshots it onto profiles
 * (the domain `ImageGenCapabilityFlags` column) and renders
 * capability-gated controls from it without a live round-trip.
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import type { ImageGenBackendType, ImageGenCapabilityFlags } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenBackendFactory,
} from "./imagegen-backend.js";

export type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenBackendFactory,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenGeneratedImage,
  ImageGenProbeResult,
  ImageGenModelInfo,
  ImageGenSamplerInfo,
  ImageGenProgressInfo,
} from "./imagegen-backend.js";
export type { ImageGenBackendType, ImageGenCapabilityFlags } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Capability data
// ---------------------------------------------------------------------------

/**
 * Static capability flags for the FULL v1 image-gen roster — pure data, no
 * I/O; flags describe OUR integration surface, not raw vendor potential.
 *
 * The vendor-set size lists are the vendors' documented grids verbatim
 * (research-report cards, doc-verified 2026-09-07): OpenRouter documents
 * aspect ratios with pixel grids for six of them — the adapter maps a
 * selected W×H back onto the exact ratio string via this same table (the
 * other ratios exist upstream but carry no documented pixel grid, so they
 * are not offered); the OpenAI-images protocol's GPT Image grid is
 * 1024x1024 / 1536x1024 / 1024x1536 (arbitrary W×H exists on gpt-image-2
 * only — not assumed for Custom endpoints).
 */
export const IMAGE_GEN_BACKEND_CAPABILITIES: Record<ImageGenBackendType, ImageGenCapabilityFlags> = {
  [IMAGE_GEN_BACKENDS.OpenRouter]: {
    // Chat-completions transport (modalities), no negative/steps/seed/sampler
    // surface — per the OpenRouter card.
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: {
      kind: "vendor-set",
      // Documented pixel grids from the OpenRouter card (ratio → W×H):
      // 1:1, 2:3, 3:4, 9:16, 16:9, 21:9. Ratios without a documented grid
      // (3:2, 4:3, 4:5, 5:4) are NOT offered — no invented values.
      sizes: [
        "1024x1024",
        "832x1248",
        "864x1184",
        "768x1344",
        "1344x768",
        "1536x672",
      ],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    supportsImg2img: false,
    supportsInpaint: false,
  },
  [IMAGE_GEN_BACKENDS.OpenAiImages]: {
    // POST /v1/images/generations: prompt/size only in our v1 arm — no
    // negative prompt, no steps/seed/sampler surface.
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: {
      kind: "vendor-set",
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    supportsImg2img: false,
    supportsInpaint: false,
  },
  [IMAGE_GEN_BACKENDS.A1111]: {
    // /sdapi/v1/txt2img: full param surface — negative prompt, samplers
    // (GET /samplers), seed (reported back), free W×H integers, live
    // GET /progress. Keyless by default (--api-auth optional).
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: true,
    supportsLiveProgress: true,
    supportsImg2img: false,
    supportsInpaint: false,
  },
};

const KNOWN_SLUGS = new Set<string>(Object.values(IMAGE_GEN_BACKENDS));

function isKnownSlug(slug: string): slug is ImageGenBackendType {
  return KNOWN_SLUGS.has(slug);
}

/**
 * Return the static capability flags for a known backend slug.
 * Throws ImageGenUnknownBackendError for an unknown slug.
 */
export function getImageGenBackendCapabilities(slug: ImageGenBackendType): ImageGenCapabilityFlags {
  if (!isKnownSlug(slug)) {
    throw new ImageGenUnknownBackendError(slug);
  }
  return IMAGE_GEN_BACKEND_CAPABILITIES[slug];
}

// ---------------------------------------------------------------------------
// Factory registry
// ---------------------------------------------------------------------------

const factories = new Map<ImageGenBackendType, ImageGenBackendFactory>();

export class ImageGenUnknownBackendError extends Error {
  constructor(slug: string) {
    super(
      `Unknown image-gen backend '${slug}'. ` +
        `Supported backends: ${Object.values(IMAGE_GEN_BACKENDS).join(", ")}.`,
    );
    this.name = "ImageGenUnknownBackendError";
  }
}

export class ImageGenBackendNotRegisteredError extends Error {
  constructor(slug: ImageGenBackendType) {
    super(
      `Image-gen backend '${slug}' has no registered factory. ` +
        `Register it via registerImageGenBackend() before calling createImageGenBackend().`,
    );
    this.name = "ImageGenBackendNotRegisteredError";
  }
}

/**
 * Register a factory for a backend slug. Called by adapter modules at import
 * time. Overwrites a previous registration for the same slug (last writer
 * wins) — useful in tests that inject stubs.
 */
export function registerImageGenBackend(slug: ImageGenBackendType, factory: ImageGenBackendFactory): void {
  if (!isKnownSlug(slug)) {
    throw new ImageGenUnknownBackendError(slug);
  }
  factories.set(slug, factory);
}

/**
 * Create a backend instance for a slug + config.
 * Throws ImageGenUnknownBackendError for an unknown slug, or
 * ImageGenBackendNotRegisteredError for a known slug with no factory.
 */
export function createImageGenBackend(slug: string, config: ImageGenAdapterConfig): ImageGenBackend {
  if (!isKnownSlug(slug)) {
    throw new ImageGenUnknownBackendError(slug);
  }
  const factory = factories.get(slug);
  if (!factory) {
    throw new ImageGenBackendNotRegisteredError(slug);
  }
  return factory(config);
}

/**
 * List all known backend slugs (the v1 roster).
 */
export function listImageGenBackendSlugs(): ImageGenBackendType[] {
  return [...(Object.values(IMAGE_GEN_BACKENDS) as ImageGenBackendType[])];
}

/**
 * Reset all registrations. Test-only helper — not part of the public API
 * surface, but exported so imagegen-registry.test.ts can isolate
 * registrations between tests without relying on module reload.
 *
 * CAUTION (process-global state): services/api runs every test file in ONE
 * bun process — see the matching comments on the STT/TTS registry helpers.
 * imagegen-registry.test.ts snapshots before its first reset and restores in
 * afterAll so later files keep their import-time registrations.
 */
export function __resetImageGenRegistryForTests(): void {
  factories.clear();
}

/** Test-only: capture the current registrations so they can be restored after a reset. */
export function __snapshotImageGenRegistryForTests(): ReadonlyMap<ImageGenBackendType, ImageGenBackendFactory> {
  return new Map(factories);
}

/** Test-only: put the process back exactly as this file found it (see caution above). */
export function __restoreImageGenRegistryForTests(snapshot: ReadonlyMap<ImageGenBackendType, ImageGenBackendFactory>): void {
  factories.clear();
  for (const [slug, factory] of snapshot) {
    factories.set(slug, factory);
  }
}
