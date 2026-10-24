import {
  DEFAULT_DEEPGRAM_STT_MODEL,
  DEFAULT_ELEVENLABS_STT_MODEL,
  DEFAULT_GEMINI_STT_MODEL,
  DEFAULT_NVIDIA_STT_MODEL,
  IMAGE_GEN_BACKENDS,
  PROVIDER_PRESET_GROUP,
  PROVIDER_TYPE,
  STT_BACKENDS,
} from "@vibe-tavern/domain";
import type { ImageGenBackendType, ProviderPresetGroup, ProviderPresetId, SttBackendType } from "@vibe-tavern/domain";

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  type: string;
  baseUrl: string;
  group: ProviderPresetGroup;
  noApiKey?: boolean;
  requiresAuthForModels?: boolean;
  /** Response length applied when the preset is picked (user-editable after,
   *  never clamped). Set only where the provider's wire needs a non-generic
   *  first-request value (NAI-3c: NovelAI's 150 = every tier accepts). */
  defaultMaxTokens?: number;
}

export const PRESET_GROUPS: Array<{ id: ProviderPresetGroup; label: string }> = [
  { id: PROVIDER_PRESET_GROUP.cloud, label: "Cloud" },
  { id: PROVIDER_PRESET_GROUP.native, label: "Native" },
  { id: PROVIDER_PRESET_GROUP.local, label: "Local" },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.openai.com/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "openrouter", label: "OpenRouter", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://openrouter.ai/api/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "deepseek", label: "DeepSeek", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.deepseek.com", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "groq", label: "Groq", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.groq.com/openai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "xai", label: "xAI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.x.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "mistral", label: "Mistral AI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.mistral.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "fireworks", label: "Fireworks", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.fireworks.ai/inference/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "perplexity", label: "Perplexity", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.perplexity.ai", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "moonshot", label: "Moonshot", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.moonshot.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "kimi", label: "Kimi", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.kimi.com/coding/v1", group: PROVIDER_PRESET_GROUP.cloud, requiresAuthForModels: true },
  { id: "ai21", label: "AI21", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.ai21.com/studio/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "mimo", label: "Xiaomi MiMo", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.xiaomimimo.com/v1", group: PROVIDER_PRESET_GROUP.cloud, requiresAuthForModels: true },
  { id: "nanogpt", label: "NanoGPT", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://nano-gpt.com/api/v1", group: PROVIDER_PRESET_GROUP.cloud, requiresAuthForModels: true },
  { id: "chutes", label: "Chutes", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://llm.chutes.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "electronhub", label: "ElectronHub", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.electronhub.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "novelai", label: "NovelAI", type: PROVIDER_TYPE.novelai, baseUrl: "https://text.novelai.net", group: PROVIDER_PRESET_GROUP.native, requiresAuthForModels: true, defaultMaxTokens: 150 },
  { id: "novelai_oa", label: "NovelAI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://text.novelai.net/oa/v1", group: PROVIDER_PRESET_GROUP.cloud, requiresAuthForModels: true },
  { id: "zai", label: "ZAI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.z.ai/api/paas/v4", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "zai-coding", label: "ZAI Coding", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.z.ai/api/coding/paas/v4", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "siliconflow", label: "SiliconFlow", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.siliconflow.com/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "togetherai", label: "Together AI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://api.together.xyz/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "pollinations", label: "Pollinations", type: PROVIDER_TYPE.openaiCompat, baseUrl: "https://gen.pollinations.ai/v1", group: PROVIDER_PRESET_GROUP.cloud },
  { id: "anthropic", label: "Anthropic Claude", type: PROVIDER_TYPE.anthropic, baseUrl: "https://api.anthropic.com/v1", group: PROVIDER_PRESET_GROUP.native, requiresAuthForModels: true },
  { id: "google", label: "Google AI Studio", type: PROVIDER_TYPE.google, baseUrl: "https://generativelanguage.googleapis.com", group: PROVIDER_PRESET_GROUP.native, requiresAuthForModels: true },
  { id: "google_interactions", label: "Google Interactions", type: PROVIDER_TYPE.googleInteractions, baseUrl: "https://generativelanguage.googleapis.com", group: PROVIDER_PRESET_GROUP.native, requiresAuthForModels: true },
  { id: "ollama", label: "Ollama", type: PROVIDER_TYPE.ollama, baseUrl: "http://localhost:11434", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "llamacpp", label: "llama.cpp server", type: PROVIDER_TYPE.llamaCpp, baseUrl: "http://localhost:8080", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "koboldcpp", label: "KoboldCPP", type: PROVIDER_TYPE.koboldCpp, baseUrl: "http://localhost:5001", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "unsloth", label: "Unsloth Studio", type: PROVIDER_TYPE.unsloth, baseUrl: "http://localhost:8888", group: PROVIDER_PRESET_GROUP.local, requiresAuthForModels: true },
  { id: "vllm", label: "vLLM", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:8000/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "ooba", label: "text-generation-webui", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:5000/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "tabby", label: "TabbyAPI", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:5000/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "aphrodite", label: "Aphrodite", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:2242/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
  { id: "lmstudio", label: "LM Studio", type: PROVIDER_TYPE.openaiCompat, baseUrl: "http://localhost:1234/v1", group: PROVIDER_PRESET_GROUP.local, noApiKey: true },
];

export const TYPE_LABELS: Record<string, string> = {
  [PROVIDER_TYPE.openaiCompat]: "OpenAI Compat",
  [PROVIDER_TYPE.anthropic]: "Anthropic",
  [PROVIDER_TYPE.google]: "Google API",
  [PROVIDER_TYPE.googleInteractions]: "Google Interactions",
  [PROVIDER_TYPE.ollama]: "Ollama",
  [PROVIDER_TYPE.llamaCpp]: "llama.cpp",
  [PROVIDER_TYPE.koboldCpp]: "KoboldCPP",
  [PROVIDER_TYPE.unsloth]: "Unsloth Studio",
  [PROVIDER_TYPE.novelai]: "NovelAI",
};

export function getVisibleProviderPresets(isArmServer: boolean): ProviderPreset[] {
  if (!isArmServer) return PROVIDER_PRESETS;
  return PROVIDER_PRESETS.filter((preset) => preset.group !== PROVIDER_PRESET_GROUP.local);
}

export function getVisiblePresetGroups(isArmServer: boolean): Array<{ id: ProviderPresetGroup; label: string }> {
  if (!isArmServer) return PRESET_GROUPS;
  return PRESET_GROUPS.filter((group) => group.id !== PROVIDER_PRESET_GROUP.local);
}

export function getPresetGroup(presetId: string): ProviderPresetGroup | null {
  return PROVIDER_PRESETS.find((f) => f.id === presetId)?.group ?? null;
}

// ─── Image generation presets (IMAGE_GENERATION_PLAN IG-11) ─────────────────

/** One named image-gen provider row. The v1 roster is locked to the three
 *  adapter arms (plan scope: OpenRouter + Custom cloud (OpenAI-images
 *  protocol) + A1111-compatible local) — every row rides one of the
 *  `IMAGE_GEN_BACKENDS` adapters, so unlike the LLM table there is no
 *  `type` discriminator: the backend slug IS the wire protocol. Facts are
 *  doc-verified from the research cards (IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH /
 *  IMAGE_GEN_LOCAL_BACKENDS_RESEARCH, both 2026-09-07). */
export interface ImageGenProviderPreset {
  /** Row slug — stored verbatim as the profile's `presetId` (the wire field
   *  exists, so no endpoint auto-detection is ever needed). */
  id: string;
  /** Vendor label (literal, brand names — the LLM-table precedent). */
  label: string;
  /** The adapter that executes this preset (one of IMAGE_GEN_BACKENDS). */
  backend: ImageGenBackendType;
  /** Prefilled base URL (user-editable after apply — local ports move). */
  baseUrl: string;
  /** Level-1 segment taxonomy (the LLM-tab group field; the picker derives
   *  its segments from the groups present here). The boundary follows the
   * app-wide canon (owner 2026-09-18: the LLM tab is the base taxonomy
   * — STT/TTS follow it, the image tab must too): native = rows speaking
   * a PROPRIETARY vendor wire (fal, Replicate, Google, BFL…); cloud = any
   * OpenAI-compatible surface — the OpenAI-images dialect family (incl.
   * the OpenAI reference row — the LLM-tab twin) AND chat-completions
   * transports (OpenRouter's modalities: a dedicated adapter executes
   * it, but the wire is the OpenAI chat surface — the canon classifies
   * by the wire, not by the adapter file) — with the free community
   * tiers kept INSIDE (owner ruling); local; derived Custom). */
  group: ProviderPresetGroup;
  /** True when the API key is optional at connect time (A1111 keyless
   *  default; `--api-auth` may add basic auth — the field still renders). */
  keyOptional?: boolean;
  /** True when the backend has NO auth surface at all (comfyui core —
   *  the adapter fails closed on a non-empty key): the key field is
   *  HIDDEN, not marked optional (owner decision 2026-09-18 — an
   *  "optional" label on a field that must stay empty is a lie). */
  noApiKey?: boolean;
  /** i18n key of a per-preset endpoint hint rendered under the endpoint
   *  field while this preset is active (URL-embedded placeholders the
   *  user must replace). Literal union — one data source; the form
   *  renders whatever the row carries. */
  endpointHintKey?: ImageGenEndpointHintKey;
}

/** Endpoint-hint i18n keys — the per-preset hints rendered under the
 *  provider form's endpoint field. */
export type ImageGenEndpointHintKey = "image_gen_endpoint_hint_cloudflare";

/** The v1 image-gen roster. Rows (doc-verified):
 *  - OpenRouter — chat-completions transport, https://openrouter.ai/api/v1
 *    (cloud card: aggregator, allowed alongside direct vendors);
 *  - OpenAI — the canonical /v1/images/generations target; the existing VT
 *    `openai` preset baseUrl matches directly (cloud card);
 *  - A1111-compatible — the /sdapi/v1 family (A1111 · Forge · Forge-Neo ·
 *    reForge · SD.Next), default port 7860, keyless by default (local
 *    card: "the A1111-family adapter's prime local target today"). */
export const IMAGE_GEN_PROVIDER_PRESETS: readonly ImageGenProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    backend: IMAGE_GEN_BACKENDS.OpenAiImages,
    baseUrl: "https://api.openai.com/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    backend: IMAGE_GEN_BACKENDS.OpenRouter,
    baseUrl: "https://openrouter.ai/api/v1",
    // Chat-completions + modalities IS the OpenAI chat-compat surface: the
    // wire rule puts this row in cloud (the LLM-tab twin), even though a
    // dedicated adapter executes it.
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  {
    id: "a1111",
    label: "A1111-compatible (Forge)",
    backend: IMAGE_GEN_BACKENDS.A1111,
    baseUrl: "http://127.0.0.1:7860",
    group: PROVIDER_PRESET_GROUP.local,
    keyOptional: true,
  },
  {
    id: "comfyui",
    label: "ComfyUI",
    backend: IMAGE_GEN_BACKENDS.ComfyUI,
    baseUrl: "http://127.0.0.1:8188",
    group: PROVIDER_PRESET_GROUP.local,
    // Core ComfyUI has no auth surface (the adapter fails closed on a
    // non-empty key) — the key field is HIDDEN for this row, not optional.
    noApiKey: true,
  },
  // PE-1 cloud family (IMAGEGEN_PROVIDER_EXPANSION_PLAN — labels are
  // literal brand names, the LLM-table precedent): Together AI —
  // api.together.ai, OpenAI-images transport with width/height int params
  // (card + 2026-09-18 live re-verification).
  {
    id: "togetherai",
    label: "Together AI",
    backend: IMAGE_GEN_BACKENDS.TogetherAi,
    baseUrl: "https://api.together.ai/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // SiliconFlow — https://api.siliconflow.com/v1, OpenAI-images-style path
  // with SiliconFlow's own request/response schema (image_size param,
  // images[].url envelope per the card + 2026-09-18 re-verification).
  {
    id: "siliconflow",
    label: "SiliconFlow",
    backend: IMAGE_GEN_BACKENDS.SiliconFlow,
    baseUrl: "https://api.siliconflow.com/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // NanoGPT — https://nano-gpt.com/api/v1 (same host as the LLM preset;
  // image-models listing path per the card + 2026-09-18 re-verification).
  {
    id: "nanogpt",
    label: "NanoGPT",
    backend: IMAGE_GEN_BACKENDS.NanoGpt,
    baseUrl: "https://nano-gpt.com/api/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // ElectronHub — https://api.electronhub.ai/v1, OpenAI-images-compat
  // (DALL-E-shaped documented size enum, b64_json requested; community
  // anime checkpoint catalog per the card + 2026-09-18 re-verification).
  {
    id: "electronhub",
    label: "ElectronHub",
    backend: IMAGE_GEN_BACKENDS.ElectronHub,
    baseUrl: "https://api.electronhub.ai/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // Pollinations unified gateway — https://gen.pollinations.ai/v1 (keyed
  // OpenAI-images surface; the legacy anonymous GET API is a separate PE-3
  // unit; image-model listing filtered by the documented category field).
  {
    id: "pollinations",
    label: "Pollinations",
    backend: IMAGE_GEN_BACKENDS.Pollinations,
    baseUrl: "https://gen.pollinations.ai/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // DeepInfra — https://api.deepinfra.com/v1; canonical path per the
  // 2026-09-18 re-verification (/v1/images/generations — the card's
  // /v1/openai/... prefix is a legacy alias), b64_json delivery.
  {
    id: "deepinfra",
    label: "DeepInfra",
    backend: IMAGE_GEN_BACKENDS.DeepInfra,
    baseUrl: "https://api.deepinfra.com/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // Recraft — external.api.recraft.ai/v1 (OpenAI-images client compat;
  // V4/4.1 model family, never negative_prompt; random_seed wire name).
  {
    id: "recraft",
    label: "Recraft",
    backend: IMAGE_GEN_BACKENDS.Recraft,
    baseUrl: "https://external.api.recraft.ai/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // Z.AI — the zai LLM preset's own base (api.z.ai/api/paas/v4, same
  // credentials): glm-image / cogview-4 on the OpenAI-images transport,
  // url-delivery + static model catalog (PE-2 card + 2026-09-18 probes).
  {
    id: "zai",
    label: "Z.AI",
    backend: IMAGE_GEN_BACKENDS.Zai,
    baseUrl: "https://api.z.ai/api/paas/v4",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // MiniMax — the TTS profile's own host (api.minimax.io, same
  // credentials): image-01 on MiniMax's own JSON surface (aspect-ratio
  // pixel map, base64 delivery, in-band base_resp errors — PE-2 card).
  {
    id: "minimax",
    label: "MiniMax",
    backend: IMAGE_GEN_BACKENDS.MiniMax,
    baseUrl: "https://api.minimax.io",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // Volcengine Ark — Seedream family on the Ark API (a SEPARATE key from
  // the volcengine TTS service): one endpoint, model field selects;
  // watermark off by named decision; b64_json delivery (PE-2 card).
  {
    id: "volcengine",
    label: "Volcengine Ark",
    backend: IMAGE_GEN_BACKENDS.Volcengine,
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // Alibaba DashScope intl — the documented non-workspace domain
  // (existence-probed live); a workspace URL
  // (https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1) pasted over
  // it works identically. Chat-shaped trio: qwen-image-3.0-pro (sync),
  // z-image-turbo (sync), wan2.7-image-pro (async + poll).
  {
    id: "dashscope",
    label: "DashScope",
    backend: IMAGE_GEN_BACKENDS.Dashscope,
    baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // NVIDIA hosted catalog — per-model genai paths (ai.api.nvidia.com,
  // the same key as the LLM nvcat preset family): FLUX trio + SDXL +
  // SD3-medium, three distinct request schemas (PE-2 card + live probes).
  {
    id: "nim",
    label: "NVIDIA",
    backend: IMAGE_GEN_BACKENDS.Nim,
    baseUrl: "https://ai.api.nvidia.com/v1",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // Pollinations legacy tier — the card's TWO-tier verdict, second row:
  // anonymous GET-binary zero-config surface (image.pollinations.ai,
  // same slug as the keyed unified row above; the tier is selected by
  // the baseUrl host). Anonymous generation live-verified 2026-09-18
  // (post-gateway-launch); key OPTIONAL — a Bearer raises rate limits.
  {
    id: "pollinations_free",
    label: "Pollinations (free)",
    backend: IMAGE_GEN_BACKENDS.Pollinations,
    baseUrl: "https://image.pollinations.ai",
    group: PROVIDER_PRESET_GROUP.cloud,
    keyOptional: true,
  },
  // Chutes — per-chute hosts (the model id IS the host slug:
  // https://{model}.chutes.ai/generate, flat JSON, raw PNG back); the
  // same cpk_ key as the LLM preset.
  {
    id: "chutes",
    label: "Chutes",
    backend: IMAGE_GEN_BACKENDS.Chutes,
    baseUrl: "https://chutes.ai",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // Hugging Face Inference Providers — one hf_ token routes the whole
  // meta-aggregator (fal/replicate/novita/…); raw bytes back; live Hub
  // picker (inference=warm text-to-image).
  {
    id: "hf",
    label: "Hugging Face",
    backend: IMAGE_GEN_BACKENDS.Hf,
    baseUrl: "https://router.huggingface.co",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // Google Gemini (Nano Banana) — Interactions API; the same AI Studio
  // key as the google LLM preset; image inline base64 (no URL expiry).
  {
    id: "google",
    label: "Google Gemini",
    backend: IMAGE_GEN_BACKENDS.Google,
    baseUrl: "https://generativelanguage.googleapis.com",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // Stability AI — v2beta Stable Image services (ultra/core/sd3.5),
  // multipart bodies, raw image bytes back.
  {
    id: "stability",
    label: "Stability AI",
    backend: IMAGE_GEN_BACKENDS.Stability,
    baseUrl: "https://api.stability.ai",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // Ideogram — typography-first native vendor; multipart + Api-Key
  // header; ephemeral signed URLs downloaded server-side.
  {
    id: "ideogram",
    label: "Ideogram",
    backend: IMAGE_GEN_BACKENDS.Ideogram,
    baseUrl: "https://api.ideogram.ai",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // Cloudflare Workers AI — the account id rides the URL path: replace
  // <ACCOUNT_ID> with your dashboard account id (Workers AI → Use REST
  // API). 10k Neurons/day free allocation.
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    backend: IMAGE_GEN_BACKENDS.Cloudflare,
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai",
    endpointHintKey: "image_gen_endpoint_hint_cloudflare",
    group: PROVIDER_PRESET_GROUP.native,
  },
  // AI Horde — crowdsourced free cluster; the key is OPTIONAL (anonymous
  // tier) — register at stablehorde.net only for priority.
  {
    id: "aihorde",
    label: "AI Horde (free)",
    backend: IMAGE_GEN_BACKENDS.Aihorde,
    baseUrl: "https://stablehorde.net/api",
    group: PROVIDER_PRESET_GROUP.cloud,
    keyOptional: true,
  },
  {
    id: "bfl",
    label: "Black Forest Labs (FLUX)",
    backend: IMAGE_GEN_BACKENDS.Bfl,
    baseUrl: "https://api.bfl.ai",
    group: PROVIDER_PRESET_GROUP.native,
  },
  {
    id: "fal",
    label: "fal.ai",
    backend: IMAGE_GEN_BACKENDS.Fal,
    baseUrl: "https://queue.fal.run",
    group: PROVIDER_PRESET_GROUP.native,
  },
  {
    id: "replicate",
    label: "Replicate",
    backend: IMAGE_GEN_BACKENDS.Replicate,
    baseUrl: "https://api.replicate.com",
    group: PROVIDER_PRESET_GROUP.native,
  },
  {
    id: "krea",
    label: "Krea",
    backend: IMAGE_GEN_BACKENDS.Krea,
    baseUrl: "https://api.krea.ai",
    group: PROVIDER_PRESET_GROUP.native,
  },
  {
    id: "leonardo",
    label: "Leonardo.Ai",
    backend: IMAGE_GEN_BACKENDS.Leonardo,
    baseUrl: "https://cloud.leonardo.ai/api/rest",
    group: PROVIDER_PRESET_GROUP.native,
  },
  {
    id: "luma",
    label: "Luma (uni-1)",
    backend: IMAGE_GEN_BACKENDS.Luma,
    baseUrl: "https://agents.lumalabs.ai",
    group: PROVIDER_PRESET_GROUP.native,
  },
  {
    id: "novita",
    label: "Novita AI (Qwen-Image)",
    backend: IMAGE_GEN_BACKENDS.Novita,
    baseUrl: "https://api.novita.ai",
    group: PROVIDER_PRESET_GROUP.native,
  },
  {
    id: "novelai",
    label: "NovelAI",
    backend: IMAGE_GEN_BACKENDS.NovelAi,
    baseUrl: "https://image.novelai.net",
    group: PROVIDER_PRESET_GROUP.native,
  },
];

/** Image-gen preset lookup by row slug. */
export function getImageGenProviderPreset(id: string): ImageGenProviderPreset | undefined {
  return IMAGE_GEN_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/**
 * STT provider preset table: named STT provider presets on the
 * OpenAI-compatible transport (STT_PROVIDER_EXPANSION_REPORT, SPE-1).
 *
 * The v1 STT roster shipped one catch-all `openai-compat` backend where every
 * cloud vendor was a manual base URL + key + model — the anti-pattern the
 * owner flagged: concrete providers must be named rows, exactly like the TTS
 * tab's named backends. But unlike TTS (12 backends, 12 wire shapes), all
 * verified transcription vendors speak the SAME OpenAI-compatible multipart
 * `/audio/transcriptions` surface, so they are PRESETS — pure data rows on the
 * one existing transport — not twelve new backends. Native-wire vendors
 * (Gemini, Deepgram, ElevenLabs, NVIDIA chat-audio) join as their own
 * backend types with their own preset rows (SPE-4..6, landed; gemini joined
 * its row in SPE-8). Only whisper-browser stays a named backend without a
 * preset row — it is the browser tier, not a provider.
 *
 * SPE-8 (owner directive 2026-09-05): the roster carries the LLM-tab group
 * taxonomy — every row has a `group` (cloud / native / local) and the
 * picker renders level-1 segments from it, exactly like the LLM provider
 * presets. The old SPE-1 line "gemini is not a preset" is superseded.
 *
 * The aggregator rule (owner, standing): an aggregator (OpenRouter) is ONE row
 * among named providers, never a substitute for them — every vendor with a
 * verified direct API gets its own preset row, OpenRouter included as itself.
 *
 * Pure data: no I/O, no secrets. The web picker is the only consumer.
 * All endpoint/model facts are doc-verified (sources inline in the report);
 * `baseUrl` is the value the openai-stt adapter expects — it appends
 * `/audio/transcriptions` itself.
 */

/** Auth header shape a preset's transport must send when a key is set.
 *  Optional: it is an instruction for the OpenAI-compatible transport
 *  only — a preset backed by a NATIVE adapter (deepgram/elevenlabs/nvidia)
 *  carries none, because its adapter owns the wire shape (Token /
 *  xi-api-key / Bearer hardcoded there). Bearer is the default every
 *  compat row uses; X-API-Key stays in the vocabulary for wire shapes that
 *  need it — the SPE-R pass confirmed no current row does, so no transport
 *  override is built: if a live probe ever 401s on Bearer, add the override
 *  then. */
export const STT_PRESET_AUTH_HEADER = {
  Bearer: "bearer",
  XApiKey: "x-api-key",
} as const;
export type SttPresetAuthHeader = (typeof STT_PRESET_AUTH_HEADER)[keyof typeof STT_PRESET_AUTH_HEADER];

/** How a preset's model list is sourced for the picker (SPE-3):
 *  - `static` — shipped list (the vendor's documented transcription roster);
 *  - `fetch` — live discovery via the backend's `listModels` (the openai-stt
 *    adapter already filters `GET {endpoint}/models?output_modalities=
 *    transcription`, which is OpenRouter's documented discovery shape);
 *  - `free-text` — user-typed model id (local servers: any
 *    OpenAI-compatible transcription server, whisper.cpp / faster-whisper /
 *    LocalAI / a Riva NIM container). */
export type SttPresetModelSource =
  | {
      kind: "static";
      /** Documented transcription models (picker order). */
      models: readonly string[];
      defaultModel: string;
    }
  | {
      kind: "fetch";
      defaultModel: string;
    }
  | {
      kind: "free-text";
      defaultModel: string;
    }
  | {
      kind: "server";
    };

/** Provider group — the LLM-tab taxonomy (SPE-8, owner directive
 *  2026-09-05): `cloud` = OpenAI-compatible transport rows,
 *  `native` = own-wire backend rows, `local` = the local-server row.
 *  The picker renders level-1 segments from this field. */
export const STT_PRESET_GROUP = {
  Cloud: "cloud",
  Native: "native",
  Local: "local",
} as const;
export type SttPresetGroup = (typeof STT_PRESET_GROUP)[keyof typeof STT_PRESET_GROUP];

/** One named provider row on the STT picker. */
export interface SttProviderPreset {
  /** Row slug — unique across the roster; doubles as the i18n key suffix
   *  (`stt_preset_<id>`). */
  id: string;
  /** Group for the level-1 segment taxonomy (SPE-8 — mirrors the LLM
   *  provider-presets `group` field). */
  group: SttPresetGroup;
  /** The transport backend that executes this preset (must exist in
   *  {@link STT_BACKENDS} — see the module note on native adapters). */
  backend: SttBackendType;
  /** Prefilled transcriptions base URL (adapter-normalized form: trailing
   *  slashes stripped, `/audio/transcriptions` appended by the adapter).
   *  Empty only for the local-server preset (user-filled field). */
  baseUrl: string;
  /** Auth header the OpenAI-compatible transport sends when a key is set
   *  (SPE-2 — optional: native-adapter presets carry none; see
   *  {@link STT_PRESET_AUTH_HEADER}). */
  authHeader?: SttPresetAuthHeader;
  /** Vendor slug for the auto-key rule — an STT profile without its own key
   *  reuses the same-vendor saved TTS/LLM profile key; `""` = no vendor
   *  match (whisper-browser aside, only the local preset has none). */
  vendor: string;
  /** Model sourcing for the picker. */
  modelSource: SttPresetModelSource;
  /** True when the API key is optional at connect time (local servers may
   *  run keyless — the openai-stt adapter already sends no Authorization
   *  header without a key). */
  keyOptional: boolean;
  /** SPE-6 flag: the preset's models transcribe ENGLISH SPEECH ONLY (the
   *  hosted NVIDIA omni card, owner-approved roster fact). The picker
   *  renders the EN-only hint and hides the language field; RU dictation
   *  stays on the other rows. */
  englishOnly?: boolean;
}

/** The named-provider roster. Every row is doc-verified
 *  (STT_PROVIDER_EXPANSION_REPORT, "Verdict" table): compat rows ride the
 *  one OpenAI-compatible transport, native-adapter vendors
 *  (gemini/deepgram/elevenlabs/nvidia) ride their own slugs (SPE-4..6,
 *  SPE-8), and the local row marks the local-server arm. Only
 *  whisper-browser is a named backend without a preset row (browser tier). */
export const STT_PROVIDER_PRESETS: readonly SttProviderPreset[] = [
  {
    id: "openai",
    group: STT_PRESET_GROUP.Cloud,
    backend: STT_BACKENDS.OpenAiCompat,
    baseUrl: "https://api.openai.com/v1",
    authHeader: STT_PRESET_AUTH_HEADER.Bearer,
    vendor: "openai",
    modelSource: {
      kind: "static",
      models: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-transcribe"],
      defaultModel: "whisper-1",
    },
    keyOptional: false,
  },
  {
    id: "openrouter",
    group: STT_PRESET_GROUP.Cloud,
    backend: STT_BACKENDS.OpenAiCompat,
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: STT_PRESET_AUTH_HEADER.Bearer,
    vendor: "openrouter",
    // Live roster via the documented discovery filter (20 models / 9
    // providers at 2026-09-05) — self-updating, nothing hardcoded. The
    // default is the first-party whisper entry of that roster.
    modelSource: {
      kind: "fetch",
      defaultModel: "openai/whisper-large-v3",
    },
    keyOptional: false,
  },
  {
    id: "groq",
    group: STT_PRESET_GROUP.Cloud,
    backend: STT_BACKENDS.OpenAiCompat,
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: STT_PRESET_AUTH_HEADER.Bearer,
    vendor: "groq",
    modelSource: {
      kind: "static",
      models: ["whisper-large-v3", "whisper-large-v3-turbo"],
      defaultModel: "whisper-large-v3",
    },
    keyOptional: false,
  },
  {
    id: "mistral",
    group: STT_PRESET_GROUP.Cloud,
    backend: STT_BACKENDS.OpenAiCompat,
    baseUrl: "https://api.mistral.ai/v1",
    authHeader: STT_PRESET_AUTH_HEADER.Bearer,
    vendor: "mistral",
    modelSource: {
      kind: "static",
      // Documented transcription roster (their API-reference model ids;
    // SPE-R note: their docs EXAMPLES drift across aliases like
    // voxtral-mini-latest / voxtral-2602, so revisit this list on the
    // first live connect — the documented ids stay the safe default
      // until a key verifies whether /v1/models supports the
      // output_modalities filter).
      models: ["voxtral-mini-3b-2507", "voxtral-small-24b-2507-stt"],
      defaultModel: "voxtral-mini-3b-2507",
    },
    keyOptional: false,
  },
  {
    id: "cartesia",
    group: STT_PRESET_GROUP.Cloud,
    backend: STT_BACKENDS.OpenAiCompat,
    // Their OpenAI-compatible drop-in lives at
    // https://api.cartesia.ai/audio/transcriptions (no /v1 segment) —
    // the adapter's append yields exactly that path.
    baseUrl: "https://api.cartesia.ai",
    // SPE-R correction (2026-09-05): Cartesia auth is Bearer — their own
    // /stt OpenAPI declares `APIKeyAuth {type: http, scheme: bearer}` and
    // the repo's live cartesia-tts adapter has been sending Bearer all
    // along. The earlier X-API-Key claim came from a migrate page that is
    // now unreachable (Vercel checkpoint); if a live transcription ever
    // 401s on Bearer, revisit a header override then.
    authHeader: STT_PRESET_AUTH_HEADER.Bearer,
    vendor: "cartesia",
    modelSource: {
      kind: "static",
      // Batch transcription is ink-whisper-only (ink-2 is websocket-only,
      // out of scope for single-shot dictation).
      models: ["ink-whisper"],
      defaultModel: "ink-whisper",
    },
    keyOptional: false,
  },
  {
    // "Local server" — the owner-required named row for any local
    // OpenAI-compatible transcription server (whisper.cpp server,
    // speaches, LocalAI, a Riva NIM ASR container); mirrors
    // the TTS tab's Local Server entry instead of hiding locals in the
    // old catch-all row.
    id: "local",
    group: STT_PRESET_GROUP.Local,
    backend: STT_BACKENDS.OpenAiCompat,
    baseUrl: "",
    authHeader: STT_PRESET_AUTH_HEADER.Bearer,
    vendor: "",
    modelSource: {
      kind: "free-text",
      defaultModel: "whisper-1",
    },
    keyOptional: true,
  },
  // ── Native-adapter presets (SPE-4..6) ───────────────────────────────────
  // These rows ride their OWN backend slugs — the adapter owns the wire
  // (endpoint, auth shape, payload), so `baseUrl` stays empty (no endpoint
  // field — the gemini-stt precedent) and `authHeader` is omitted. They
  // exist so the picker, model roster, auto-key hints and the EN-only flag
  // stay pure data over ONE roster instead of adapter-code constants.
  // SPE-8: gemini joins the native group — it moves from a segment option
  // to a preset row (the LLM-tab pattern: natives are rows, not segments).
  // Fetch roster via the gemini-stt listModels (fixed Gemini API endpoint,
  // no endpoint field — the ST-7 precedent all natives share).
  {
    id: "gemini",
    group: STT_PRESET_GROUP.Native,
    backend: STT_BACKENDS.Gemini,
    baseUrl: "",
    vendor: "gemini",
    modelSource: {
      kind: "fetch",
      defaultModel: DEFAULT_GEMINI_STT_MODEL,
    },
    keyOptional: false,
  },
  {
    id: "whisper-cpp",
    group: STT_PRESET_GROUP.Local,
    backend: STT_BACKENDS.WhisperCpp,
    // The project's own local server surface (`POST /inference`) —
    // SPE-9: own-wire locals are adapter territory, not an exclusion
    // note. Prefilled with the server's default host/port; the endpoint
    // stays editable (the Local arm). Also covers whisperfile (the
    // llamafile wraps this server).
    baseUrl: "http://127.0.0.1:8080",
    vendor: "",
    // The model is bound at server start (`-m`) — no request-side
    // model field; the picker shows the server-flags hint instead.
    modelSource: { kind: "server" },
    keyOptional: true,
  },
  {
    id: "deepgram",
    group: STT_PRESET_GROUP.Native,
    backend: STT_BACKENDS.Deepgram,
    baseUrl: "",
    vendor: "deepgram",
    modelSource: {
      kind: "fetch",
      // GET /v1/models → stt[] (live catalog; nova-3 is the default and
      // understands Russian natively — changelog-verified, SPE-R).
      defaultModel: DEFAULT_DEEPGRAM_STT_MODEL,
    },
    keyOptional: false,
  },
  {
    id: "elevenlabs",
    group: STT_PRESET_GROUP.Native,
    backend: STT_BACKENDS.ElevenLabs,
    baseUrl: "",
    vendor: "elevenlabs",
    modelSource: {
      kind: "static",
      // No STT discovery endpoint exists (/v1/models is the TTS catalog)
      // — the Scribe roster is shipped data (SPE-R).
      models: [DEFAULT_ELEVENLABS_STT_MODEL, "scribe-1"],
      defaultModel: DEFAULT_ELEVENLABS_STT_MODEL,
    },
    keyOptional: false,
  },
  {
    id: "nvidia",
    group: STT_PRESET_GROUP.Native,
    backend: STT_BACKENDS.Nvidia,
    baseUrl: "",
    vendor: "nvidia",
    modelSource: {
      kind: "static",
      // The hosted chat catalog does not mark audio capability — the
      // usable roster is the verified omni reference (SPE-6).
      models: [DEFAULT_NVIDIA_STT_MODEL],
      defaultModel: DEFAULT_NVIDIA_STT_MODEL,
    },
    keyOptional: false,
    englishOnly: true,
  },
];

/** Lookup by row slug (`undefined` when the id is not in the roster). */
export function getSttProviderPreset(id: string): SttProviderPreset | undefined {
  return STT_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Group of a preset row by slug (`null` for unknown ids) — mirrors the
 *  TTS `getTtsPresetGroup` helper so the picker filters rows by the
 *  level-1 segment. */
export function getSttPresetGroup(id: string): SttPresetGroup | null {
  return STT_PROVIDER_PRESETS.find((preset) => preset.id === id)?.group ?? null;
}

/** The preset row backing a NATIVE backend slug (gemini / deepgram /
 *  elevenlabs / nvidia), `undefined` for every non-native slug (compat
 *  presets are many per backend, whisper-browser is the browser tier
 *  without a row). The web recognition section and provider form use this
 *  for the static model roster and the EN-only flag — pure data, no
 *  adapter imports. */
export function getSttNativePreset(backend: SttBackendType): SttProviderPreset | undefined {
  if (backend === STT_BACKENDS.OpenAiCompat || backend === STT_BACKENDS.WhisperBrowser) {
    return undefined;
  }
  return STT_PROVIDER_PRESETS.find((preset) => preset.backend === backend);
}
