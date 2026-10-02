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
import {
  makeRawBinaryImageBackend,
  POLLINATIONS_LEGACY_HOST,
  POLLINATIONS_LEGACY_OPTIONS,
} from "./raw-binary.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../../providers/provider-transport.js";

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

// ─── DeepInfra (PE-1 unit 6) ──────────────────────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "DeepInfra" (doc-verified
 *  2026-09-07) + supervisor live re-verification 2026-09-18 — **DRIFT
 *  FOUND (2 facts, logged in the research report)**:
 *  - the canonical generation path in the CURRENT openapi.json is
 *    `POST /v1/images/generations` — the card's `/v1/openai/images/
 *    generations` is no longer in the spec (legacy alias); with the
 *    preset endpoint `https://api.deepinfra.com/v1` the shared transport
 *    hits the canonical path exactly;
 *  - `response_format` now documents BOTH b64_json (default) and url —
 *    b64 stays what VT requests (zero expiry surface; url's "expires
 *    after about a day" note makes it strictly worse here);
 *  - `size` is a free-form "WxH" string (default 1024x1024 — the vendor's
 *    default, never ours; no closed grid documented) → verbatim WxH;
 *  - `quality`/`style` are compatibility-only params (ignored by DeepInfra)
 *    and have no contract seam anyway → never sent; no negative_prompt on
 *    this surface → no wire name;
 *  - model listing: GET /v1/models public no-auth (bare-array shape), the
 *    freshest FLUX/Qwen lineup of the cloud group; the card's
 *    t2i-vs-edit/video suffix ideas are HEURISTICS, not documented
 *    discriminators → listed UNFILTERED (unfiltered truth beats a guessed
 *    filter). */
const DEEPINFRA_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "DeepInfra",
  size: { kind: "verbatim", param: "size" },
  responseFormat: { kind: "always", value: "b64_json" },
  envelope: "openai-data",
  modelsPath: "models",
  probeModelNoun: "models",
};

// ─── Recraft (PE-1 unit 7) ──────────────────────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Recraft" (doc-verified
 *  2026-09-07 — endpoints.md read in full) + supervisor live
 *  re-verification 2026-09-18 (unchanged):
 *  - base `https://external.api.recraft.ai/v1`, Bearer — OpenAI-images
 *    CLIENT compatible (their examples use the OpenAI SDK verbatim);
 *  - `size` is `WxH` (or `w:h`) free-form, auto-selected when omitted —
 *    the supported-values Appendix was never fetched → verbatim WxH;
 *  - `response_format` url (default) | b64_json; URL lifetime unstated on
 *    the endpoints page → b64_json requested (bytes inline);
 *  - **`negative_prompt` is V2/V3-ONLY — the V4/4.1 family (the default
 *    `recraftv4_1` and everything current) REJECTS it** → no wire name:
 *    the adapter NEVER sends the field for any model (capability row
 *    false; a V2/V3 escape hatch is not worth a footgun);
 *  - `random_seed` IS documented (not `seed`) → seedWire; sent only when
 *    the caller set one;
 *  - `style`/`style_id`/`style_match`/`style_references`/`text_layout`/
 *    `controls` have NO seam in ImageGenGenerateRequest → never sent (no
 *    invented contract fields);
 *  - model listing: GET /v1/models is NOT on the endpoints page but IS
 *    live (existence probe 2026-09-18 → 401 auth-missing, not 404); no
 *    documented response shape → listed UNFILTERED, tolerant parsing. */
const RECRAFT_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "Recraft",
  size: { kind: "verbatim", param: "size" },
  responseFormat: { kind: "always", value: "b64_json" },
  envelope: "openai-data",
  modelsPath: "models",
  seedWire: "random_seed",
  probeModelNoun: "models",
};

// ─── Z.AI (PE-2 unit 1) ─────────────────────────────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Z.AI" (doc-verified
 *  2026-09-07; re-verified unchanged 2026-09-18) + supervisor live
 *  existence probes 2026-09-18:
 *  - `POST https://api.z.ai/api/paas/v4/images/generations` (exactly the
 *    VT `zai` LLM preset baseUrl + the family path), Bearer — the same
 *    credentials as the existing `zai`/`zai-coding` LLM presets (creds
 *    overlap; the ImageGenProviderPreset type has no hint field, so the
 *    overlap is expressed by the shared baseUrl, nothing else);
 *  - models `glm-image`, `cogview-4-250304` — the card documents NO
 *    image-model list endpoint (the docs index lists chat models only,
 *    UNVERIFIED) → STATIC catalog; the creds probe rides the CHAT
 *    `GET /models` (live existence-probed 2026-09-18: 401 auth wall, not
 *    404) — auth check only, the image count comes from the static enum;
 *  - `size`: per-model documented enums — glm-image 7 values (custom
 *    1024–2048 divisible-by-32 pairs in range) + cogview-4 7 values
 *    (custom 512–2048 div-16). The grid publishes the documented UNION
 *    (the SiliconFlow per-model-union precedent); in-range custom pairs
 *    ride VERBATIM via the profile's IG-20a user sizes;
 *  - `quality` (hd|standard) and `user_id` have NO contract seam → never
 *    sent; no negative/steps/seed/sampler surface → no wire names;
 *  - response: `data[0].url` ONLY (link expires after 30 days — still
 *    downloaded server-side per the cloud-URL-expiry rule; the envelope
 *    normalizer's url path), plus a root `content_filter` array the
 *    parser ignores (severity levels 0–3 — no VT surface in v1);
 *  - NO `response_format` param on the card → policy "never". */
export const ZAI_IMAGE_SIZES: ReadonlyMap<string, { width: number; height: number }> = new Map([
  // glm-image enum (documented default 1280x1280)
  ["1280x1280", { width: 1280, height: 1280 }],
  ["1568x1056", { width: 1568, height: 1056 }],
  ["1056x1568", { width: 1056, height: 1568 }],
  ["1472x1088", { width: 1472, height: 1088 }],
  ["1088x1472", { width: 1088, height: 1472 }],
  ["1728x960", { width: 1728, height: 960 }],
  ["960x1728", { width: 960, height: 1728 }],
  // cogview-4 enum (documented default 1024x1024)
  ["1024x1024", { width: 1024, height: 1024 }],
  ["768x1344", { width: 768, height: 1344 }],
  ["864x1152", { width: 864, height: 1152 }],
  ["1344x768", { width: 1344, height: 768 }],
  ["1152x864", { width: 1152, height: 864 }],
  ["1440x720", { width: 1440, height: 720 }],
  ["720x1440", { width: 720, height: 1440 }],
]);

const ZAI_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "Z.AI",
  size: { kind: "grid", param: "size", sizes: ZAI_IMAGE_SIZES },
  responseFormat: { kind: "never" },
  envelope: "openai-data",
  modelsPath: "models",
  staticModels: [
    { id: "glm-image", label: "GLM Image" },
    { id: "cogview-4-250304", label: "CogView-4" },
  ],
  probeModelNoun: "image models",
};

// ─── Volcengine Ark / Doubao Seedream (PE-2 unit 3) ─────────────────────

/** Card: IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Volcengine Ark" (doc-
 *  verified 2026-09-07 — the 104KB t2i page read in full via r.jina.ai;
 *  re-fetched 2026-09-18, model roster and params unchanged) + supervisor
 *  live no-key probe 2026-09-18 (POST /api/v3/images/generations → clean
 *  401 AuthenticationError — the invalid-post probe's discrimination
 *  basis):
 *  - `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`
 *    (the preset endpoint + the family path — exact match), Bearer Ark
 *    API key (a SEPARATE key from the TTS volcengine speech service);
 *  - one endpoint for all Seedream models (`model` selects). Static
 *    catalog: only `doubao-seedream-5-0-pro-260628` carries a documented
 *    full id on this page (5.0 lite / 4.5 / 4.0 exist but their ids are
 *    NOT on it) — no invented ids; the model field stays free-text for
 *    the rest;
 *  - **5.0 pro additionally accepts RU + 13 languages** (the card's
 *    differentiator for RU-locale users);
 *  - `size`: explicit `WxH` pixels (per-model total-pixel ranges, AR
 *    [1/16,16] — vendor-validated) or tier tokens (1K/2K/…) — the
 *    explicit form is what VT sends (verbatim); tier tokens and the
 *    AR-in-prompt quirk have no v1 seam;
 *  - `response_format` url (default, valid 24 h) | b64_json → b64_json
 *    requested (bytes inline, zero expiry surface); response
 *    data[]{url|b64_json,size,output_format,z_index} — the openai-data
 *    envelope handles both entry kinds;
 *  - **NAMED DECISION (watermark)**: `watermark` defaults TRUE upstream
 *    (stamps an "AI 生成" mark bottom-right); VT sends `watermark: false`
 *    on every request via constantParams — a self-hosted local-first app
 *    does not ship watermarked art silently. The card flagged the
 *    off-switch as an owner decision; flipping to the vendor default is a
 *    one-line change here;
 *  - no negative/seed/sampler/steps/cfg surface (prompt-driven model) →
 *    no wire names. sequential_image_generation / stream / tools /
 *    optimize_prompt_options / image refs / layer_decomposition have no
 *    v1 seam → never sent. */
const VOLCENGINE_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "Volcengine Ark",
  size: { kind: "verbatim", param: "size" },
  responseFormat: { kind: "always", value: "b64_json" },
  envelope: "openai-data",
  staticModels: [{ id: "doubao-seedream-5-0-pro-260628", label: "Seedream 5.0 Pro" }],
  constantParams: { watermark: false },
  probe: { kind: "invalid-post" },
};

// ─── Registration (one factory closure per OPTIONS row) ──────────────────────

/** Named NanoGPT factory — exported for the route-test registry dance
 *  (imagegen-routes.test.ts resets the process-global registry in
 *  beforeEach and re-registers the factories it exercises; the
 *  openRouterImageGenFactory / a1111Factory twin). */
export const nanoGptImageGenFactory = (config: ImageGenAdapterConfig): ImageGenBackend =>
  makeOpenAiImagesFamilyBackend(NANOGPT_OPTIONS, config);

/** The PE-1 OPTIONS table — one row per family slug. Grows one row per
 *  wave unit (togetherai → siliconflow → nanogpt → electronhub →
 *  pollinations → deepinfra → recraft); every row's slug exists in
 *  IMAGE_GEN_BACKENDS and carries a capability row in the domain table. */
const PE1_FAMILY: ReadonlyArray<{ slug: ImageGenBackendType; options: OpenAiImagesFamilyOptions }> = [
  { slug: IMAGE_GEN_BACKENDS.TogetherAi, options: TOGETHERAI_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.SiliconFlow, options: SILICONFLOW_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.NanoGpt, options: NANOGPT_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.ElectronHub, options: ELECTRONHUB_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.DeepInfra, options: DEEPINFRA_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.Recraft, options: RECRAFT_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.Zai, options: ZAI_OPTIONS },
  { slug: IMAGE_GEN_BACKENDS.Volcengine, options: VOLCENGINE_OPTIONS },
];

for (const { slug, options } of PE1_FAMILY) {
  registerImageGenBackend(slug, (config: ImageGenAdapterConfig): ImageGenBackend =>
    makeOpenAiImagesFamilyBackend(options, config),
  );
}

// ─── Pollinations: the two-tier slug (PE-3 unit 1) ──────────────────────────
// The card's verdict is a TWO-tier adapter: the keyed unified gateway above
// (gen.pollinations.ai, this family's row) + the legacy anonymous GET-binary
// tier (image.pollinations.ai, the PE-3 raw-binary arm). One slug, two
// presets — the tier is selected by the profile's baseUrl host (PE-1 log's
// named decision: the legacy tier completes the family in PE-3).
registerImageGenBackend(
  IMAGE_GEN_BACKENDS.Pollinations,
  (config: ImageGenAdapterConfig): ImageGenBackend => {
    try {
      const host = new URL(normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "")).host;
      if (host === POLLINATIONS_LEGACY_HOST) {
        return makeRawBinaryImageBackend(POLLINATIONS_LEGACY_OPTIONS, config);
      }
    } catch {
      // Unparseable endpoint → the unified row surfaces its config error.
    }
    return makeOpenAiImagesFamilyBackend(POLLINATIONS_OPTIONS, config);
  },
);
