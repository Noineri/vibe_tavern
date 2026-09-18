import { IMAGE_GEN_BACKENDS, PROVIDER_PRESET_GROUP, PROVIDER_TYPE } from "@vibe-tavern/domain";
import type { ImageGenBackendType, ProviderPresetGroup, ProviderPresetId } from "@vibe-tavern/domain";

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  type: string;
  baseUrl: string;
  group: ProviderPresetGroup;
  noApiKey?: boolean;
  requiresAuthForModels?: boolean;
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
   *  its segments from the groups present here — v1 has no `native` rows,
   *  so no Native segment renders). */
  group: ProviderPresetGroup;
  /** True when the API key is optional at connect time (A1111 keyless
   *  default; `--api-auth` may add basic auth — the field still renders). */
  keyOptional?: boolean;
  /** True when the backend has NO auth surface at all (comfyui core —
   *  the adapter fails closed on a non-empty key): the key field is
   *  HIDDEN, not marked optional (owner decision 2026-09-18 — an
   *  "optional" label on a field that must stay empty is a lie). */
  noApiKey?: boolean;
}

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
    id: "openrouter",
    label: "OpenRouter",
    backend: IMAGE_GEN_BACKENDS.OpenRouter,
    baseUrl: "https://openrouter.ai/api/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  {
    id: "openai",
    label: "OpenAI",
    backend: IMAGE_GEN_BACKENDS.OpenAiImages,
    baseUrl: "https://api.openai.com/v1",
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
    group: PROVIDER_PRESET_GROUP.cloud,
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
    group: PROVIDER_PRESET_GROUP.cloud,
  },
  // NVIDIA hosted catalog — per-model genai paths (ai.api.nvidia.com,
  // the same key as the LLM nvcat preset family): FLUX trio + SDXL +
  // SD3-medium, three distinct request schemas (PE-2 card + live probes).
  {
    id: "nim",
    label: "NVIDIA",
    backend: IMAGE_GEN_BACKENDS.Nim,
    baseUrl: "https://ai.api.nvidia.com/v1",
    group: PROVIDER_PRESET_GROUP.cloud,
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
];

/** Image-gen preset lookup by row slug. */
export function getImageGenProviderPreset(id: string): ImageGenProviderPreset | undefined {
  return IMAGE_GEN_PROVIDER_PRESETS.find((preset) => preset.id === id);
}
