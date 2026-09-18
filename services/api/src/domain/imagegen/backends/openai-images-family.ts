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

// ─── SiliconFlow (PE-1 unit 2) ────────────────────────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "SiliconFlow" (doc-verified
 *  2026-09-07) + supervisor live re-verification 2026-09-18:
 *  - POST /v1/images/generations, Bearer — path OpenAI-images-style but the
 *    schema is SiliconFlow's own: size rides `image_size` with PER-MODEL
 *    string enums; this table publishes the documented UNION (per-model
 *    subsets vary — the capability grid and this table stay in lockstep,
 *    pinned by the test); userSizes ride verbatim (IG-20a);
 *  - `response_format` is NOT documented for this endpoint → never sent;
 *  - response is `{images: [{url}], timings, seed}` — NOT OpenAI's data[]
 *    envelope (normalized via the envelope option); the URL is valid
 *    1 hour → downloaded server-side immediately (house rule); the
 *    response-level `seed` (the effective seed) rides onto the result;
 *  - num_inference_steps (1–50/1–100 per model), guidance_scale (Qwen
 *    0–20), seed (0–9999999999), negative_prompt (Qwen / Z-Image / Ultra
 *    only — sent only when the caller provided one) map from the
 *    request's steps/cfgScale/seed/negativePrompt;
 *  - `cfg` (Qwen text-in-image), batch_size, output_format and friends
 *    have NO seam in ImageGenGenerateRequest → never sent (no invented
 *    contract fields);
 *  - model listing: GET /v1/models (Bearer) — the card documents no
 *    image discriminator on the API ("Image" tags live in their console)
 *    → listed UNFILTERED. */
export const SILICONFLOW_IMAGE_SIZES: ReadonlyMap<string, { width: number; height: number }> = new Map([
  ["512x512", { width: 512, height: 512 }],
  ["512x1024", { width: 512, height: 1024 }],
  ["576x1024", { width: 576, height: 1024 }],
  ["720x1280", { width: 720, height: 1280 }],
  ["720x1440", { width: 720, height: 1440 }],
  ["768x512", { width: 768, height: 512 }],
  ["768x1024", { width: 768, height: 1024 }],
  ["928x1664", { width: 928, height: 1664 }],
  ["960x1280", { width: 960, height: 1280 }],
  ["1024x576", { width: 1024, height: 576 }],
  ["1024x768", { width: 1024, height: 768 }],
  ["1024x1024", { width: 1024, height: 1024 }],
  ["1056x1584", { width: 1056, height: 1584 }],
  ["1140x1472", { width: 1140, height: 1472 }],
  ["1328x1328", { width: 1328, height: 1328 }],
  ["1472x1140", { width: 1472, height: 1140 }],
  ["1584x1056", { width: 1584, height: 1056 }],
  ["1664x928", { width: 1664, height: 928 }],
]);

const SILICONFLOW_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "SiliconFlow",
  size: { kind: "grid", param: "image_size", sizes: SILICONFLOW_IMAGE_SIZES },
  responseFormat: { kind: "never" },
  envelope: "siliconflow-images",
  modelsPath: "models",
  stepsWire: "num_inference_steps",
  guidanceWire: "guidance_scale",
  seedWire: "seed",
  negativePromptWire: "negative_prompt",
  probeModelNoun: "models",
};

// ─── NanoGPT (PE-1 unit 3) ─────────────────────────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "NanoGPT" (doc-verified
 *  2026-09-07 — their own openapi.json) + supervisor live re-verification
 *  2026-09-18:
 *  - POST /api/v1/images/generations, Bearer — OpenAI-images shape
 *    (model/prompt/n/size/response_format); NO documented size grid → a
 *    complete W×H goes on the wire verbatim as the free-form "WxH" string
 *    (incomplete/unset omits the field — vendor default);
 *  - response_format IS documented → b64_json requested (URL lifetime
 *    unstated; every url entry still downloads server-side — house rule
 *    regardless);
 *  - model listing is a DIFFERENT path: GET /api/v1/image-models — public
 *    no-auth, already image-scoped (no filter); the Bearer key is sent
 *    anyway (the endpoint accepts it);
 *  - no negative prompt / steps / seed / sampler surface on the card → no
 *    wire names. */
const NANOGPT_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "NanoGPT",
  size: { kind: "verbatim", param: "size" },
  responseFormat: { kind: "always", value: "b64_json" },
  envelope: "openai-data",
  modelsPath: "image-models",
  probeModelNoun: "image models",
};

// ─── ElectronHub (PE-1 unit 4) ───────────────────────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "ElectronHub" (doc-verified
 *  2026-09-07 — Fern docs + inline OpenAPI yaml) + supervisor live
 *  re-verification 2026-09-18 (unchanged):
 *  - POST /v1/images/generations, Bearer (`ek-` keys) — OpenAI-images
 *    compat: required [model, prompt]; the documented `size` enum is
 *    DALL-E-shaped (256²…1792×1024) while the live catalog is SD-family +
 *    nano-banana/qwen/z-image — per-model size behavior is UNVERIFIED on
 *    the card, so the grid publishes the DOCUMENTED five-value enum (the
 *    contract their OpenAPI states), userSizes ride verbatim (IG-20a),
 *    off-grid fails closed;
 *  - `response_format` documents url (default) | b64_json; URL lifetime
 *    UNVERIFIED → b64_json requested (bytes inline, house rule regardless);
 *  - response is the OpenAI `{created, data[]{url|b64_json,
 *    revised_prompt}}` shape;
 *  - no steps/guidance/seed/negative_prompt surface on their OpenAPI → no
 *    wire names;
 *  - model listing: GET /v1/models — public no-auth, ~594 rows (~125
 *    image verified live); the card documents NO discriminator → listed
 *    UNFILTERED (unfiltered truth beats a guessed filter). */
export const ELECTRONHUB_IMAGE_SIZES: ReadonlyMap<string, { width: number; height: number }> = new Map([
  ["256x256", { width: 256, height: 256 }],
  ["512x512", { width: 512, height: 512 }],
  ["1024x1024", { width: 1024, height: 1024 }],
  ["1792x1024", { width: 1792, height: 1024 }],
  ["1024x1792", { width: 1024, height: 1792 }],
]);

const ELECTRONHUB_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "ElectronHub",
  size: { kind: "grid", param: "size", sizes: ELECTRONHUB_IMAGE_SIZES },
  responseFormat: { kind: "always", value: "b64_json" },
  envelope: "openai-data",
  modelsPath: "models",
  probeModelNoun: "models",
};

// ─── Pollinations unified gateway (PE-1 unit 5) ──────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Pollinations" (doc-verified
 *  2026-09-07; unified-surface caveat CLOSED via the live openapi.json)
 *  + supervisor live re-verification 2026-09-18 (APIDOCS.md re-fetched,
 *  /v1/models re-probed):
 *  - POST /v1/images/generations on gen.pollinations.ai, Bearer — **an API
 *    key is REQUIRED for generation** (live probe → 401 "A valid API key is
 *    required"; anonymous lives on only on the legacy GET surface, which
 *    is a SEPARATE PE-3 unit, not this row);
 *  - OpenAI-images shape: `prompt` required, `model`, `size` "WxH"
 *    free-form (no closed grid documented), `n` max 1 (v1 requests carry
 *    no count anyway), `response_format` url | b64_json → b64_json
 *    requested (bytes inline; gateway URL lifetime unstated); `quality` /
 *    `resolution` / `safe` have NO seam in ImageGenGenerateRequest → never
 *    sent (no invented contract fields);
 *  - no negative_prompt / steps / seed / sampler surface on the gateway
 *    docs → no wire names;
 *  - model listing: GET /v1/models public — entries carry a `category`
 *    field (live-verified 2026-09-18: 403 models, 59 category="image"
 *    among text/image/audio/video/3d) — a DOCUMENTED discriminator, so
 *    this is the one family row that FILTERS (category === "image");
 *    entries carry `title`/`description` enrichment (parser reads title). */
const POLLINATIONS_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "Pollinations",
  size: { kind: "verbatim", param: "size" },
  responseFormat: { kind: "always", value: "b64_json" },
  envelope: "openai-data",
  modelsPath: "models",
  modelFilter: (id, entry) => entry.category === "image",
  probeModelNoun: "image models",
};

// ─── Registration (one factory closure per OPTIONS row) ──────────────────────

/** The PE-1 OPTIONS table — one row per family slug. Grows one row per
 *  wave unit (togetherai → siliconflow → nanogpt → electronhub →
 *  pollinations → deepinfra → recraft); every row's slug exists in
 *  IMAGE_GEN_BACKENDS and carries a capability row in the domain table. */
const PE1_FAMILY: ReadonlyArray<{ slug: ImageGenBackendType; options: OpenAiImagesFamilyOptions }> = [
  { slug: IMAGE_GEN_BACKENDS.TogetherAi, options: TOGETHERAI_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.SiliconFlow, options: SILICONFLOW_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.NanoGpt, options: NANOGPT_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.ElectronHub, options: ELECTRONHUB_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.Pollinations, options: POLLINATIONS_OPTIONS },
];

for (const { slug, options } of PE1_FAMILY) {
  registerImageGenBackend(slug, (config: ImageGenAdapterConfig): ImageGenBackend =>
    makeOpenAiImagesFamilyBackend(options, config),
  );
}
