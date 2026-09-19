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
    // (live 2026-09-18: 403 models, 59 image). PE-3 unit 1 completed the
    // TWO-tier family: the legacy anonymous GET-binary tier rides the
    // SAME slug, dispatched by baseUrl host (image.pollinations.ai) onto
    // the raw-binary arm — key OPTIONAL (Bearer raises rate limits).
    // Named decision: the legacy tier's documented `seed` stays unwired
    // (per-SLUG caps cannot diverge per tier; a seed control that does
    // nothing on the keyed tier is worse than a missing one).
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
  [IMAGE_GEN_BACKENDS.MiniMax]: {
    // PE-2 unit 2 — MiniMax card (doc-verified 2026-09-07 against the
    // live platform.minimax.io schema; re-verified 2026-09-18 incl. a
    // full JS-rendered re-read + a no-key live probe): POST
    // api.minimax.io/v1/image_generation (the TTS profile's own host,
    // creds overlap), Bearer. image-01 — the documented single-value enum
    // (and the profile default, the minimax-tts precedent). Sizing:
    // aspect_ratio enum with a documented pixel map (8 values, published
    // as the grid); user-added sizes ride width+height [512,2048] div 8
    // (aspect_ratio wins upstream, so the ratio form is preferred).
    // response_format base64 requested (url expires 24 h); entries ride
    // data.image_base64s (base64 mode; call-site-verified) with
    // image_urls as the fallback field. seed int64 — supported. FAILURES
    // RIDE base_resp.status_code INSIDE HTTP 200 (live 200+1004 login
    // fail — the adapter honors the in-band status everywhere). Model
    // discovery: documented OpenAI-compat GET /v1/models filtered to the
    // image-* family (the TTS speech-* precedent).
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: true,
    sizeSupport: {
      kind: "vendor-set",
      // Literal mirror of the arm's MINIMAX_ASPECT_RATIOS keys —
      // lockstep pinned by imagegen-pe2-providers.test.ts (the domain
      // leaf cannot import the services/api arm table).
      sizes: [
        "1024x1024",
        "1280x720",
        "1152x864",
        "1248x832",
        "832x1248",
        "864x1152",
        "720x1280",
        "1344x576",
      ],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.Volcengine]: {
    // PE-2 unit 3 — Volcengine Ark card (doc-verified 2026-09-07, the
    // 104KB t2i page in full; re-fetched 2026-09-18 unchanged) + live
    // no-key probe (clean 401 AuthenticationError): POST
    // ark.cn-beijing.volces.com/api/v3/images/generations, Bearer Ark key
    // (SEPARATE from the TTS volcengine speech key). One endpoint, model
    // field selects; static catalog = the one documented full id
    // (doubao-seedream-5-0-pro-260628 — 5.0 pro, the RU-prompt-capable
    // flagship); lite/4.5/4.0 ids not on the page → model field stays
    // free-text. size = explicit WxH (vendor-validated ranges), free.
    // response_format b64_json requested (url expires 24 h).
    // NAMED DECISION: watermark:false sent ALWAYS (vendor default true
    // stamps "AI 生成"; VT never ships watermarked art silently — flip is
    // one line in the family options). No negative/seed/sampler/steps
    // surface (prompt-driven). Probe = invalid-post creds discrimination.
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
  [IMAGE_GEN_BACKENDS.Dashscope]: {
    // PE-2 unit 4 — DashScope/Model Studio card (doc-verified 2026-09-07;
    // re-verified 2026-09-18 with the live z-image/wan2.7 API references
    // + the t2i guide re-read, and both paths existence-probed on the
    // intl non-workspace domain): CHAT-SHAPED bodies (input.messages +
    // parameters), two transports — SYNC multimodal-generation (qwen-
    // image-3.0-pro, z-image-turbo) and ASYNC image-generation +
    // X-DashScope-Async + task poll (wan2.7-image-pro, 3–5 s cadence,
    // 150 s budget inside the cloud timeout). Size format "W*H"
    // (ASTERISK — DashScope's own). negative_prompt: qwen-image ONLY
    // (wan REJECTS it, z-image documents none — dropped there, never
    // folded into the prompt). seed: z-image t2i ONLY ([0, 2147483647]).
    // watermark:false for wan (the guide's own example value — the
    // Volcengine twin named decision). prompt_extend NEVER sent (vendor
    // per-model defaults stand). Delivery: 24 h OSS URLs, downloaded
    // server-side. Static trio catalog; invalid-post probe on the sync
    // path (live 401 without key).
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
  [IMAGE_GEN_BACKENDS.Nim]: {
    // PE-2 unit 5 — NVIDIA hosted card (doc-verified 2026-09-07 from the
    // owner's MHTML saves of the three endpoint pages — the docs hub is
    // SPA-walled; wall re-confirmed 2026-09-18) + supervisor live probes
    // of all five per-model paths (401 auth-wall = exists):
    // ai.api.nvidia.com/v1/genai/{publisher}/{model}. THREE request
    // schemas: FLUX family (width/height 768–1344 ints, cfg_scale, seed,
    // steps; NO negative surface — dropped), SDXL (text_prompts
    // {text,weight} with weight −1 AS the negative prompt — the only
    // mechanism; width/height FIXED 1024 never sent; cfg_scale; **the
    // one hosted vendor with a sampler param** — enum DDIM /
    // K_EULER_ANCESTRAL / K_LMS / K_DPM_2_ANCESTRAL, static listSamplers),
    // SD3-medium (negative_prompt first-class; aspect_ratio enum — W×H
    // maps by exact fraction else NEAREST documented ratio, a named
    // decision; cfg_scale). Shared: seed (≥0), steps 5–100. Response
    // artifacts[].base64 (official docs + call-site verified; data[].
    // b64_json mirror parsed as fallback); 202 async NVCF observed on
    // these endpoints — NOT v1, clear typed error. Static five-model
    // catalog; invalid-post probe on the flux.1-dev path.
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
  [IMAGE_GEN_BACKENDS.Chutes]: {
    // PE-3 unit 2 — Chutes card (doc-verified 2026-09-07; llms.txt index
    // + per-chute guide re-verified live 2026-09-18) + supervisor probes
    // (POST without key → 401 live). Per-chute dedicated hosts: the model
    // id IS the host slug (https://{slug}.chutes.ai/generate), flat JSON,
    // raw image/png bytes back. Schema from the z-image-turbo guide
    // (prompt, width/height, num_inference_steps def 9 "stay near",
    // guidance_scale def 0, seed; shift/max_sequence_length have no VT
    // seam). NO negative field on the verified chute — off (per-chute
    // extras on other chutes are undocumented on their generate
    // endpoints — never invented). Static four-chute catalog (image
    // chutes are NOT in llm.chutes.ai/v1/models); free-text model covers
    // new community chutes.
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
  [IMAGE_GEN_BACKENDS.Hf]: {
    // PE-3 unit 3 — Hugging Face Inference Providers card (doc-verified
    // 2026-09-07; router 401-unauth re-probed live 2026-09-18): one hf_
    // token, meta-aggregator routing — POST router.huggingface.co/
    // hf-inference/models/{id} with {inputs, parameters:{negative_prompt,
    // width, height, num_inference_steps, guidance_scale, seed}}, raw
    // image bytes back. scheduler: documented but its VT seam is the
    // A1111-dialect schedule control and no enum is documented — never
    // sent (named decision). Picker: public Hub API inference=warm +
    // pipeline_tag=text-to-image + sort=trendingScore (drift pinned live
    // 2026-09-18: the card's sort=trending now 400s).
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
  [IMAGE_GEN_BACKENDS.Google]: {
    // PE-4 unit 1 — Google Gemini (Nano Banana) card (doc-verified
    // 2026-09-07; re-verified live 2026-09-18, page updated 2026-09-17):
    // the Interactions API is the primary surface — POST /v1beta/
    // interactions, x-goog-api-key, image inline base64 in steps[].
    // response_format {aspect_ratio (10-value set), image_size 1K/2K/4K}.
    // No negative/seed/steps/cfg/sampler surface. **Imagen DRIFT: shut
    // down on the Gemini API (2026-09-17 doc update) — the card's
    // imagen :predict tier is dead; Interactions-only arm.** Named
    // decisions: store:false always (no vendor-side retention of one-shot
    // prompts); the 512px image_size tier (3.1-Flash-only) never sent —
    // the size seam cannot diverge per model; image-model discovery =
    // GET /v1beta/models filtered by the -image suffix.
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
  [IMAGE_GEN_BACKENDS.Stability]: {
    // PE-4 unit 2 — Stability AI card (doc-verified 2026-09-07 from an
    // owner MHTML; re-verified live 2026-09-18 — the JS wall is gone, full
    // API reference scraped): v2beta multipart generate services
    // ultra/core/sd3, Bearer + accept image/* → RAW bytes. Negative on
    // all three, seed, 9-value aspect enum (nearest mapping), cfg_scale
    // sd3-only. style_preset/output_format/steps/sampler: no VT seam or
    // no surface — never sent. Soft drift pinned: sd3.5-flash documented
    // in the model description, absent from the schema enum. Static
    // 6-entry catalog (no public v2beta listing; v1 engines = legacy
    // SDXL family). api.stability.ai TLS-unreachable from the dev
    // machine — probe discrimination pinned from documented codes
    // (401/403 rejected, other 4xx accepted, 5xx fail).
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
  [IMAGE_GEN_BACKENDS.Ideogram]: {
    // PE-4 unit 3 — Ideogram card (doc-verified 2026-09-07; re-verified
    // live 2026-09-18: llms.txt + generate-v4/v3 pages + the OpenAPI 3.1
    // spec): multipart + Api-Key header (NOT Bearer), sync generation,
    // ephemeral signed url → server-side download. v3 = full classic
    // surface (negative_prompt, seed 0–2147483647, 69-value resolution
    // grid); v4 = typography-first (text_prompt + 38-value 2K grid — the
    // grid was MISSING from the .md render, spec-pinned). Named decision
    // (per-model divergence, the stability cfg_scale precedent):
    // negative/seed ride ONLY v3 — v4's request schema documents neither;
    // the caps keep them as v3's real surface, the v4 wire drops them
    // (test-pinned). aspect_ratio superseded by the resolution grid —
    // never sent. Errors = RFC 7807 problem-details (live-probed: 401 no
    // token / 400 prompt-required / 415 urlencoded rejected).
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
  [IMAGE_GEN_BACKENDS.Cloudflare]: {
    // PE-4 unit 4 — Cloudflare Workers AI card (doc-verified 2026-09-07;
    // re-verified live 2026-09-18: model pages as .md + per-model
    // schema-input.json + live endpoint probes — the card's
    // "params JS-collapsed" caveat CLOSED): POST /client/v4/accounts/
    // {ACCOUNT_ID}/ai/run/{model}, Bearer, JSON body, response wrapper
    // {result, success, errors} with result.image = base64. Per-family
    // surfaces (schema-pinned): schnell {prompt 1–2048, steps ≤8 def 4,
    // seed}; SDXL family {negative_prompt, width/height 256–2048,
    // num_steps ≤20 def 20, guidance def 7.5, seed}; flux-2 family
    // UNDOCUMENTED (page renders an empty multipart{}) — prompt only,
    // nothing invented (named decision). Per-model divergence: the
    // ideogram/stability precedent. Free tier 10k Neurons/day. Account
    // id in the URL — wrong id = 404 code 7003 (distinct from 401 code
    // 10000 bad token, live-pinned).
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
  [IMAGE_GEN_BACKENDS.Aihorde]: {
    // PE-4 unit 5 — AI Horde card (doc-verified 2026-09-07; re-verified
    // live 2026-09-18: swagger re-pulled + resolved through allOf chains,
    // heartbeat v5.1.11, models endpoint live, dry-run probe). Crowdsourced
    // free cluster: submit /v2/generate/async → poll check/{id} →
    // status/{id}; r2:true (URL delivery, server-side download),
    // shared:false pinned (LAION privacy). Anonymous key 0000000000 is a
    // first-class tier — keyless. The RICHEST SD surface of the cloud
    // roster: steps 1–500, cfg 0–100, 64-multiple dimensions,
    // seed-as-string, 41-value sampler enum (**drift: the card said 43 —
    // 41 live**), 11-value scheduler enum — the A1111-dialect scheduler
    // seam's first cloud landing. Negative rides the horde ` ### `
    // convention (guides-documented, swagger-silent). UX caveat surfaced
    // to the owner: crowdsourced queues can exceed the 3-min cloud
    // timeout (anonymous queues run minutes).
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: true,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {},
  },
};
