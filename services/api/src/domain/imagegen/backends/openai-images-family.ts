/**
 * @module imagegen/backends/openai-images-family
 *
 * The OpenAI-images transport FAMILY — IMAGEGEN_PROVIDER_EXPANSION_PLAN
 * wave PE-1: cloud providers whose cards document the OpenAI-images request
 * shape (POST …/images/generations, Bearer) but carry per-provider deltas
 * over it. Each provider is ONE OPTIONS row on the shared parameterized
 * implementation (`makeOpenAiImagesFamilyBackend` in openai-images.ts) plus
 * its own backend slug — registered at import time (the a1111/openrouter
 * pattern), reached through image-gen-adapter.ts's side-effect import.
 *
 * Wire facts per provider trace to its card in
 * IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH (doc-verified 2026-09-07) with the
 * supervisor's 2026-09-18 live re-verification deltas applied where the
 * card drifted — cited per row below and in the capability-table comments
 * (packages/domain/src/imagegen-capabilities.ts).
 *
 * Registration discipline: importing this module makes every PE-1 slug
 * creatable via the image-gen registry (one factory closure per OPTIONS
 * row; the slugs live in IMAGE_GEN_BACKENDS, the capability rows in the
 * domain table — the compiler forces both per new slug).
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import type { ImageGenBackendType } from "@vibe-tavern/domain";

import type { ImageGenAdapterConfig, ImageGenBackend } from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { makeOpenAiImagesFamilyBackend } from "./openai-images.js";
import type { OpenAiImagesFamilyOptions } from "./openai-images.js";

// ─── Together AI (PE-1 unit 1) ───────────────────────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Together AI" (doc-verified
 *  2026-09-07) + supervisor live re-verification 2026-09-18:
 *  - POST /v1/images/generations, Bearer; OpenAI envelope
 *    `data[].url|b64_json` — `response_format` IS documented with enum
 *    url|base64 (NOT b64_json): "base64" requests inline bytes, dodging the
 *    hosted-URL lifetime question; a url entry still downloads server-side
 *    (house rule);
 *  - size is WIDTH/HEIGHT INTEGERS (multiples of 8), NOT a `size` string —
 *    no closed grid is documented → complete W×H rides verbatim as the two
 *    integer fields (user entries included, IG-20a verbatim philosophy),
 *    incomplete/unset omits both (vendor default, no invented values);
 *  - steps (card default 20), guidance_scale (card default 3.5), seed, n
 *    1–4, negative_prompt are documented request params — v1 sends
 *    steps/guidance/seed/negative_prompt ONLY when the caller set a value
 *    (never a default) and never sends n (v1 requests carry no count);
 *    negative_prompt is MODEL-DEPENDENT (yes on FLUX.1-schnell /
 *    FLUX.1.1-pro, no on FLUX.2/Kontext) — the capability row keeps the
 *    conservative-true + caveat treatment (sent only when provided);
 *  - model listing: GET /v1/models (Bearer) — the full serverless catalog;
 *    the card documents NO image-only discriminator → listed UNFILTERED
 *    (unfiltered truth beats a guessed filter);
 *  - image_loras / reference_images / edits = OUT of v1 scope (plan). */
const TOGETHERAI_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "Together AI",
  size: { kind: "width-height" },
  responseFormat: { kind: "always", value: "base64" },
  envelope: "openai-data",
  modelsPath: "models",
  stepsWire: "steps",
  guidanceWire: "guidance_scale",
  seedWire: "seed",
  negativePromptWire: "negative_prompt",
  probeModelNoun: "models",
};

// ─── Registration (one factory closure per OPTIONS row) ──────────────────────

/** The PE-1 OPTIONS table — one row per family slug. Grows one row per
 *  wave unit (togetherai → siliconflow → nanogpt → electronhub →
 *  pollinations → deepinfra → recraft); every row's slug exists in
 *  IMAGE_GEN_BACKENDS and carries a capability row in the domain table. */
const PE1_FAMILY: ReadonlyArray<{ slug: ImageGenBackendType; options: OpenAiImagesFamilyOptions }> = [
  { slug: IMAGE_GEN_BACKENDS.TogetherAi, options: TOGETHERAI_OPTIONS },
];

for (const { slug, options } of PE1_FAMILY) {
  registerImageGenBackend(slug, (config: ImageGenAdapterConfig): ImageGenBackend =>
    makeOpenAiImagesFamilyBackend(options, config),
  );
}
