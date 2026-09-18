/**
 * Static image-gen backend capability table (IMAGE_GENERATION_PLAN IG-4/IG-11).
 *
 * Pure data, no I/O — the WEB-SAFE source of truth for what each image-gen
 * backend supports. Lives in the domain leaf (the STT/TTS preset-table
 * precedent: `stt-presets.ts`) because the Providers editor (apps/web)
 * snapshots it onto profiles on create/backend-switch (the create contract
 * carries the capability mirror) and renders capability-gated controls from
 * it without a live round-trip — importing it from services/api would drag
 * the server barrel (db, bun:sqlite) into the browser bundle. The backend
 * FACTORY registry stays in services/api (`imagegen-registry.ts`) and
 * re-exports this table so API-side consumers have one import path.
 *
 * The flags describe OUR integration surface, not raw vendor potential.
 * The vendor-set size lists are the vendors' documented grids verbatim
 * (research-report cards, doc-verified 2026-09-07): OpenRouter documents
 * aspect ratios with pixel grids for six of them — the adapter maps a
 * selected W×H back onto the exact ratio string via this same table (the
 * other ratios exist upstream but carry no documented pixel grid, so they
 * are not offered); the OpenAI-images protocol's GPT Image grid is
 * 1024x1024 / 1536x1024 / 1024x1536 (arbitrary W×H exists on gpt-image-2
 * only — not assumed for Custom endpoints).
 */

import { IMAGE_GEN_BACKENDS } from "./entities.js";
import type { ImageGenBackendType, ImageGenCapabilityFlags, ImageGenParamRange } from "./entities.js";

/** Global default slider ranges for the advanced numeric params
 *  (IMAGE_GENERATION_PLAN IG-CF5) — the single named constants block both
 *  the editor pane and its tests import (no scattered literals): steps
 *  1–150 step 1, CFG 1–30 step 0.5, CLIP-skip 1–12 step 1. Per-backend
 *  overrides (currently all empty — no vendor publishes limits) live on
 *  each row's `paramRanges` and win over these when present. LoRA strength
 *  (CG-C3): 0–2 step 0.05 — the FT-A5 single-slider range (0 mutes, 1 the
 *  trained weight, 2 exaggeration) feeding both strength_model and
 *  strength_clip on ComfyUI. */
export const IMAGE_GEN_PARAM_RANGES: Record<
  "steps" | "cfgScale" | "clipSkip" | "loraStrength",
  ImageGenParamRange
> = {
  steps: { min: 1, max: 150, step: 1 },
  cfgScale: { min: 1, max: 30, step: 0.5 },
  clipSkip: { min: 1, max: 12, step: 1 },
  loraStrength: { min: 0, max: 2, step: 0.05 },
};

/** ADetailer face-model presets (IG-CF15/PG-4 v1) — the extension's own
 *  README face-model table verbatim (Bing-su/adetailer, the 2D/realistic
 *  face rows + the bundled mediapipe faces; hand/person models are out of
 *  the v1 face-fix scope). The first entry is the preset default; the
 *  ultralytics .pt files must exist in the server's models/adetailer dir
 *  (the extension's download button), the mediapipe faces need nothing. */
export const IMAGE_GEN_ADETAILER_FACE_MODELS = [
  "face_yolov8n.pt",
  "face_yolov8s.pt",
  "mediapipe_face_full",
  "mediapipe_face_short",
  "mediapipe_face_mesh",
] as const;

/** The face-model preset sent when the overlay enables ADetailer without
 *  picking a model (the UI default = the extension's commonly shipped
 *  lightweight face detector). */
export const IMAGE_GEN_ADETAILER_DEFAULT_MODEL: (typeof IMAGE_GEN_ADETAILER_FACE_MODELS)[number] =
  IMAGE_GEN_ADETAILER_FACE_MODELS[0];

/** Match an A1111 `/sdapi/v1/extensions` entry name against the ADetailer
 *  extension (case-insensitive substring — the family's dirnames vary:
 *  `adetailer`, `sd-webui-adetailer`, forks). */
export function hasAdetailerExtension(names: readonly string[]): boolean {
  return names.some((name) => name.toLowerCase().includes("adetailer"));
}

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
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
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
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
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
    localExecution: true,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
  },
  [IMAGE_GEN_BACKENDS.ComfyUI]: {
    // Raw ComfyUI API (COMFYUI_BACKEND_PLAN CG-A1..A3, C1, C2): flat form mapped
    // onto workflow templates — negative prompt, seed resolved client-side
    // and reported back, free W×H integers, live KSampler sampler/scheduler
    // unions (CG-A3). Keyless (core has no auth). WS step-bar progress +
    // POST /interrupt landed with CG-C1 (the a1111 progress-pill twin).
    // LoRAs landed with CG-C2: listLoras rides the family ladder, generate
    // threads enabled loras as LoraLoader nodes.
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: true,
    supportsLiveProgress: true,
    localExecution: true,
    supportsImg2img: false,
    supportsInpaint: false,
    supportsLoras: true,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
  },
  [IMAGE_GEN_BACKENDS.TogetherAi]: {
    // PE-1 (IMAGEGEN_PROVIDER_EXPANSION_PLAN) — Together AI card
    // (doc-verified 2026-09-07) + supervisor live re-verification
    // 2026-09-18: width/height INTEGER params (multiples of 8), NO closed
    // size grid documented → free W×H. steps/guidance_scale/seed/n are
    // documented request params (card defaults 20 / 3.5 — never shipped as
    // code defaults); negative_prompt is MODEL-DEPENDENT (yes on
    // FLUX.1-schnell / FLUX.1.1-pro, no on FLUX.2/Kontext) — conservative
    // TRUE with this caveat: the adapter sends the field only when the
    // caller provided one; a model that rejects it fails upstream, never
    // silently. No sampler-name surface (supportsSamplers = the a1111-style
    // sampler list, not steps/CFG sliders — those ride the ordinary
    // steps/cfgScale machinery). Card documents no step/CFG numeric limits
    // → paramRanges empty (global slider defaults).
    supportsNegativePrompt: true,
    supportsSamplers: false,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.SiliconFlow]: {
    // PE-1 unit 2 — SiliconFlow card (doc-verified 2026-09-07) + supervisor
    // live re-verification 2026-09-18: the path is OpenAI-images-style but
    // the request/response are SiliconFlow's own — size rides the
    // `image_size` string param with PER-MODEL enum grids; the capability
    // grid publishes the documented UNION (18 values, per-model subsets
    // vary — a size off a specific model's enum fails upstream, never
    // silently here); userSizes ride verbatim per IG-20a.
    // num_inference_steps (1–50 or 1–100 per model → union slider 1–100),
    // guidance_scale (Qwen; 0–20), seed (0–9999999999), negative_prompt
    // (Qwen / Z-Image / Ultra only — conservative-true with this caveat:
    // sent only when the caller provided one). Response is the
    // `{images: [{url}], timings, seed}` envelope (NOT OpenAI's data[]) —
    // normalized in the adapter; URL valid 1 hour → server-side download
    // (house rule). `cfg` (Qwen text-in-image) and batch_size have no
    // seam in ImageGenGenerateRequest → never sent (no invented fields).
    supportsNegativePrompt: true,
    supportsSamplers: false,
    supportsSeed: true,
    sizeSupport: {
      kind: "vendor-set",
      sizes: [
        "512x512", "512x1024", "576x1024", "720x1280", "720x1440",
        "768x512", "768x1024", "928x1664", "960x1280",
        "1024x576", "1024x768", "1024x1024",
        "1056x1584", "1140x1472", "1328x1328", "1472x1140",
        "1584x1056", "1664x928",
      ],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {
      // Card: num_inference_steps 1–50 (FLUX) or 1–100 (per model) — union.
      steps: { min: 1, max: 100, step: 1 },
      // Card: guidance_scale 0–20 (Qwen family).
      cfgScale: { min: 0, max: 20, step: 0.5 },
    },
  },
  [IMAGE_GEN_BACKENDS.NanoGpt]: {
    // PE-1 unit 3 — NanoGPT card (doc-verified 2026-09-07; their own
    // openapi.json) + supervisor live re-verification 2026-09-18:
    // POST /api/v1/images/generations, Bearer — OpenAI-images shape
    // (model/prompt/n/size/response_format); NO documented size grid →
    // free W×H (complete pair sent verbatim as the "WxH" string).
    // No negative prompt / steps / seed / sampler surface on the card →
    // all off. Model listing is a DIFFERENT path — GET /api/v1/image-models
    // (public no-auth; the adapter sends the Bearer key anyway — the
    // endpoint accepts it), already image-scoped so no filter ships.
    // Response URL lifetime unstated → b64_json requested + every url
    // entry downloaded server-side (house rule regardless).
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.ElectronHub]: {
    // PE-1 unit 4 — ElectronHub card (doc-verified 2026-09-07 — Fern docs +
    // inline OpenAPI yaml) + supervisor live re-verification 2026-09-18
    // (unchanged): OpenAI-images-compat POST /v1/images/generations, Bearer
    // (`ek-` keys). The documented `size` enum is DALL-E-shaped (5 values)
    // while the live catalog is SD-family/nano-banana/qwen/z-image —
    // per-model size behavior UNVERIFIED on the card → the grid publishes
    // the DOCUMENTED enum; a size off a specific model's real support fails
    // upstream, never silently here. response_format url-default |
    // b64_json documented; URL lifetime UNVERIFIED → adapter requests
    // b64_json (bytes inline). No steps/seed/sampler/negative_prompt
    // surface on their OpenAPI → all off. GET /v1/models public no-auth —
    // NO documented discriminator → catalog listed UNFILTERED (LLM rows
    // included; unfiltered truth beats a guessed filter).
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: {
      kind: "vendor-set",
      sizes: ["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.Pollinations]: {
    // PE-1 unit 5 — Pollinations card (doc-verified 2026-09-07; unified
    // gateway, gen.pollinations.ai) + supervisor live re-verification
    // 2026-09-18 (APIDOCS.md re-fetched, /v1/models re-probed): OpenAI-
    // images-shape POST /v1/images/generations with an API key REQUIRED
    // for generation (401 without — the anonymous zero-config surface is
    // the LEGACY GET API, a separate PE-3 unit). `size` is free-form
    // "WxH" (no closed grid documented) → free sizes. response_format
    // url|b64_json → adapter requests b64_json (gateway URL lifetime
    // unstated). quality/resolution/safe/n have no contract seam → never
    // sent. No negative/steps/seed/sampler surface → all off. Model
    // listing: GET /v1/models public with a DOCUMENTED `category`
    // discriminator — the one family row that FILTERS to category=image
    // (live 2026-09-18: 403 models, 59 image).
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.DeepInfra]: {
    // PE-1 unit 6 — DeepInfra card (doc-verified 2026-09-07) + supervisor
    // live re-verification 2026-09-18 with TWO logged drift facts: the
    // canonical path is now /v1/images/generations (the card's
    // /v1/openai/images/generations is a legacy alias, gone from the
    // current openapi.json), and response_format now documents url too
    // ("expires after about a day") — b64_json stays what VT requests
    // (zero expiry surface). Free-form WxH size (default 1024x1024 is the
    // vendor's, never ours). quality/style are compatibility-only (no
    // seam, never sent); no negative_prompt on this surface → off.
    // GET /v1/models public no-auth — the t2i-vs-edit suffix ideas are
    // heuristics, not documented discriminators → catalog listed
    // UNFILTERED.
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.Recraft]: {
    // PE-1 unit 7 — Recraft card (doc-verified 2026-09-07, endpoints.md in
    // full) + supervisor live re-verification 2026-09-18 (unchanged):
    // OpenAI-images-CLIENT-compatible POST on external.api.recraft.ai/v1
    // (their examples drive the OpenAI SDK verbatim). `size` WxH free-form
    // (auto-selected when omitted); response_format b64_json requested
    // (url lifetime unstated). **negative_prompt is V2/V3-ONLY — the V4/4.1
    // family (default recraftv4_1 and everything current) REJECTS it →
    // supportsNegativePrompt FALSE and the adapter never wires the field**
    // (a V2/V3 escape hatch is not worth a footgun on the default family).
    // `random_seed` IS documented (not `seed`) → supportsSeed true, sent
    // only when the caller set one. style/styles/text_layout/controls have
    // no contract seam → never sent. GET /v1/models is undocumented on the
    // endpoints page but live (existence probe 2026-09-18: 401, not 404)
    // → listed UNFILTERED with tolerant parsing.
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.Zai]: {
    // PE-2 unit 1 — Z.AI card (doc-verified 2026-09-07; re-verified
    // unchanged 2026-09-18) + supervisor live probes 2026-09-18: POST
    // api.z.ai/api/paas/v4/images/generations on the zai LLM preset's own
    // baseUrl (creds overlap — same key). Size = the documented per-model
    // enums' UNION (glm-image 7 + cogview-4 7; in-range custom pairs via
    // user sizes, IG-20a). Response is data[0].url ONLY (30-day expiry —
    // always downloaded server-side); NO response_format param on the
    // card. quality/user_id have no contract seam → never sent; no
    // negative/steps/seed/sampler surface. Static model catalog (the
    // docs index has no image-model list endpoint); creds probe rides the
    // chat GET /models (live existence-probed: 401, not 404).
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: {
      kind: "vendor-set",
      sizes: [
        "1280x1280",
        "1568x1056",
        "1056x1568",
        "1472x1088",
        "1088x1472",
        "1728x960",
        "960x1728",
        "1024x1024",
        "768x1344",
        "864x1152",
        "1344x768",
        "1152x864",
        "1440x720",
        "720x1440",
      ],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
};
