import { PROVIDER_TYPE, type ProviderType } from "./platform-constants.js";

/**
 * Provider preset IDs used by the UI plus canonical ProviderType values used by
 * older profiles. Kept in domain so web/API make identical fail-closed choices.
 */
const PRESET_TO_PROVIDER_TYPE: Record<string, ProviderType> = {
  [PROVIDER_TYPE.openaiCompat]: PROVIDER_TYPE.openaiCompat,
  [PROVIDER_TYPE.anthropic]: PROVIDER_TYPE.anthropic,
  [PROVIDER_TYPE.google]: PROVIDER_TYPE.google,
  [PROVIDER_TYPE.ollama]: PROVIDER_TYPE.ollama,
  [PROVIDER_TYPE.llamaCpp]: PROVIDER_TYPE.llamaCpp,
  [PROVIDER_TYPE.koboldCpp]: PROVIDER_TYPE.koboldCpp,
  [PROVIDER_TYPE.unsloth]: PROVIDER_TYPE.unsloth,

  openai: PROVIDER_TYPE.openaiCompat,
  openrouter: PROVIDER_TYPE.openaiCompat,
  deepseek: PROVIDER_TYPE.openaiCompat,
  groq: PROVIDER_TYPE.openaiCompat,
  xai: PROVIDER_TYPE.openaiCompat,
  mistral: PROVIDER_TYPE.openaiCompat,
  fireworks: PROVIDER_TYPE.openaiCompat,
  perplexity: PROVIDER_TYPE.openaiCompat,
  moonshot: PROVIDER_TYPE.openaiCompat,
  ai21: PROVIDER_TYPE.openaiCompat,
  mimo: PROVIDER_TYPE.openaiCompat,
  nanogpt: PROVIDER_TYPE.openaiCompat,
  chutes: PROVIDER_TYPE.openaiCompat,
  electronhub: PROVIDER_TYPE.openaiCompat,
  zai: PROVIDER_TYPE.openaiCompat,
  "zai-coding": PROVIDER_TYPE.openaiCompat,
  siliconflow: PROVIDER_TYPE.openaiCompat,
  togetherai: PROVIDER_TYPE.openaiCompat,
  pollinations: PROVIDER_TYPE.openaiCompat,
  vllm: PROVIDER_TYPE.openaiCompat,
  ooba: PROVIDER_TYPE.openaiCompat,
  tabby: PROVIDER_TYPE.openaiCompat,
  aphrodite: PROVIDER_TYPE.openaiCompat,
};

export function normalizeProviderType(raw: string): ProviderType {
  return PRESET_TO_PROVIDER_TYPE[raw] ?? PROVIDER_TYPE.openaiCompat;
}

export type TokenizerHint =
  | "openai_o200k"
  | "openai_cl100k"
  | "openai_p50k"
  | "llama3"
  | "mistral"
  | "nemo"
  | "qwen2"
  | "deepseek"
  | "mimo"
  | "glm"
  | "command-r"
  | "command-a";

export interface LogitBiasSupport {
  supported: boolean;
  reason: string;
  tokenizerHint?: TokenizerHint;
}

const ROUTER_OR_MIXED_PRESETS = new Set([
  "openrouter",
  "nanogpt",
  "chutes",
  "electronhub",
  "fireworks",
  "siliconflow",
  "togetherai",
  "pollinations",
  "perplexity",
]);

const DIRECT_DISABLED_PRESETS = new Set([
  "anthropic",
  "google",
  "groq",
  "xai",
  "moonshot",
  "ai21",
  "mimo",
  "koboldcpp",
]);

function inferPresetFromEndpoint(endpoint?: string | null): string | null {
  const value = (endpoint ?? "").toLowerCase();
  if (!value) return null;
  if (value.includes("api.openai.com")) return "openai";
  if (value.includes("api.mistral.ai")) return "mistral";
  if (value.includes("api.deepseek.com")) return "deepseek";
  if (value.includes("api.xiaomimimo.com")) return "mimo";
  if (value.includes("api.z.ai")) return "zai";
  if (value.includes("localhost") || value.includes("127.0.0.1")) return "local";
  return null;
}

export function resolveKnownTokenizerHint(model?: string | null): TokenizerHint | null {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return null;

  if (/^(o1|o3|o4)\b/.test(m) || /^gpt-5\b/.test(m)) return null;
  if (/^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5)\b/.test(m)) return "openai_o200k";
  if (/^gpt-3\.5-turbo-0301/.test(m)) return "openai_p50k";
  if (/^(gpt-4|gpt-3\.5-turbo|text-embedding-3)/.test(m)) return "openai_cl100k";

  if (m.includes("glm") || m.includes("zai-") || m.includes("z-ai")) return "glm";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("mimo")) return "mimo";
  if (m.includes("qwen")) return "qwen2";
  if (m.includes("mistral-nemo") || m.includes("open-mistral-nemo") || m.includes("nemo")) return "nemo";
  if (m.includes("mistral") || m.includes("mixtral") || m.includes("codestral") || m.includes("ministral") || m.includes("magistral")) return "mistral";
  if (m.includes("command-a")) return "command-a";
  if (m.includes("command-r")) return "command-r";
  if (m.includes("llama-3") || m.includes("llama3")) return "llama3";

  return null;
}

/**
 * Fail-closed Logit Bias gate. Unknown models/providers are disabled rather
 * than allowed with a lossy fallback tokenizer because token IDs are model-local.
 */
export function resolveLogitBiasSupport(
  providerPreset: string,
  model?: string | null,
  endpoint?: string | null,
): LogitBiasSupport {
  const preset = providerPreset || inferPresetFromEndpoint(endpoint) || "";
  const inferredPreset = preset === PROVIDER_TYPE.openaiCompat
    ? inferPresetFromEndpoint(endpoint) ?? preset
    : preset;

  if (ROUTER_OR_MIXED_PRESETS.has(inferredPreset)) {
    return { supported: false, reason: "router_or_mixed_provider" };
  }

  if (DIRECT_DISABLED_PRESETS.has(inferredPreset)) {
    return { supported: false, reason: "provider_does_not_support_logit_bias" };
  }

  const tokenizerHint = resolveKnownTokenizerHint(model);
  if (!tokenizerHint) {
    return { supported: false, reason: "unknown_tokenizer" };
  }

  if (inferredPreset === "openai") {
    return tokenizerHint.startsWith("openai_")
      ? { supported: true, reason: "openai_known_tokenizer", tokenizerHint }
      : { supported: false, reason: "openai_model_not_recognized" };
  }

  if (inferredPreset === "mistral") {
    return ["mistral", "nemo"].includes(tokenizerHint)
      ? { supported: true, reason: "mistral_known_tokenizer", tokenizerHint }
      : { supported: false, reason: "mistral_model_not_recognized" };
  }

  if (inferredPreset === "deepseek") {
    return tokenizerHint === "deepseek"
      ? { supported: true, reason: "deepseek_known_tokenizer", tokenizerHint }
      : { supported: false, reason: "deepseek_model_not_recognized" };
  }

  if (inferredPreset === "zai" || inferredPreset === "zai-coding") {
    return tokenizerHint === "glm"
      ? { supported: true, reason: "zai_glm_tokenizer", tokenizerHint }
      : { supported: false, reason: "zai_model_not_recognized" };
  }

  if (["ollama", "llamacpp", "vllm", "ooba", "tabby", "aphrodite", "local"].includes(inferredPreset)) {
    return { supported: true, reason: "local_known_tokenizer", tokenizerHint };
  }

  return { supported: false, reason: "unknown_provider" };
}
