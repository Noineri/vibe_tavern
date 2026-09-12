import { PROVIDER_TYPE, type ProviderType } from "./platform-constants.js";
import { GENERATION_MODE, type GenerationMode } from "./provider-profile.js";

/**
 * Provider preset IDs used by the UI plus canonical ProviderType values used by
 * older profiles. Kept in domain so web/API make identical fail-closed choices.
 */
const PRESET_TO_PROVIDER_TYPE: Record<string, ProviderType> = {
  [PROVIDER_TYPE.openaiCompat]: PROVIDER_TYPE.openaiCompat,
  [PROVIDER_TYPE.anthropic]: PROVIDER_TYPE.anthropic,
  [PROVIDER_TYPE.google]: PROVIDER_TYPE.google,
  [PROVIDER_TYPE.googleInteractions]: PROVIDER_TYPE.googleInteractions,
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
  kimi: PROVIDER_TYPE.openaiCompat,
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
  lmstudio: PROVIDER_TYPE.openaiCompat,
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
  "google_interactions",
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

// ─── Text-completion generation mode (LOCAL_SUPPORT_PLAN LS-2a/e) ──────────

/** Whether a provider preset exposes the text-completion generation-mode
 *  toggle. Mirrors {@link LogitBiasSupport} (fail-closed, shared web + API). */
export interface TextCompletionSupport {
  supported: boolean;
  reason: string;
}

/**
 * Presets whose backends serve an OpenAI-style `/completions` endpoint the TC
 * generation mode can target: the llama.cpp protocol and the LOCAL OpenAI
 * -compat presets (vLLM, ooba, TabbyAPI, Aphrodite, LM Studio) plus the
 * generic `openai_compat` preset id (legacy/custom profiles on the same
 * protocol). DELIBERATELY excluded (owner 2026-09-09):
 * - cloud presets (`openai`, `openrouter`, … — they normalize onto the same
 *   openai_compat protocol, but the toggle is local-only);
 * - `koboldcpp` — already ALWAYS text completion natively, a toggle is
 *   meaningless there;
 * - `ollama`, `unsloth`, `anthropic`, `google*` — no `/completions` surface.
 *
 * UI-visibility gate. The backend execution gate is the per-protocol
 * `capabilities.textCompletion` flag (protocol-registry): a profile that
 * carries `completion` on a protocol without the flag silently stays on chat.
 */
const TEXT_COMPLETION_PRESETS = new Set([
  PROVIDER_TYPE.llamaCpp,
  PROVIDER_TYPE.openaiCompat,
  "vllm",
  "ooba",
  "tabby",
  "aphrodite",
  "lmstudio",
]);

export function resolveTextCompletionSupport(providerPreset: string | null | undefined): TextCompletionSupport {
  const preset = (providerPreset ?? "").trim();
  if (TEXT_COMPLETION_PRESETS.has(preset)) {
    return { supported: true, reason: "provider_serves_openai_completion_endpoint" };
  }
  if (preset === "koboldcpp") {
    return { supported: false, reason: "koboldcpp_is_native_text_completion" };
  }
  return { supported: false, reason: "provider_has_no_completion_endpoint" };
}

/**
 * Native-TC presets (LOCAL_SUPPORT_PLAN LS-6a): providers whose adapter builds
 * the flat completion prompt ITSELF — always text completion, no generation
 * mode, no toggle (owner 2026-09-09: a mode flip is meaningless there). Today:
 * KoboldCPP only ({@link resolveAutoTemplateSource} → "native"). Shared web +
 * API so the AppShell pane gate and the executor format handoff fail closed
 * identically.
 */
const NATIVE_TC_PRESETS = new Set<string>([PROVIDER_TYPE.koboldCpp]);

export function resolveNativeTextCompletion(providerPreset: string | null | undefined): { supported: boolean; reason: string } {
  const preset = (providerPreset ?? "").trim();
  if (NATIVE_TC_PRESETS.has(preset)) {
    return { supported: true, reason: "provider_is_native_text_completion" };
  }
  return { supported: false, reason: "provider_has_a_generation_mode" };
}

/**
 * Whether the Generation-format tab is LIVE for the active provider profile
 * (LOCAL_SUPPORT_PLAN LS-3d gate + LS-6a fix): TC-mode profiles (the toggle
 * presets in completion mode) qualify, AND the native-TC presets qualify
 * unconditionally — before LS-6a the one always-TC provider got a permanently
 * greyed tab. Shared web + API, fail-closed.
 */
export function resolveTcPaneActive(providerPreset: string | null | undefined, generationMode: GenerationMode | null | undefined): boolean {
  if (resolveNativeTextCompletion(providerPreset).supported) return true;
  if (!resolveTextCompletionSupport(providerPreset).supported) return false;
  return generationMode === GENERATION_MODE.completion;
}

// ─── Auto generation-format template source (LOCAL_SUPPORT_PLAN LS-3c) ─────

// ─── Assistant prefill (LOCAL_SUPPORT_PLAN LS-4) ─────────────────────────

/**
 * Presets where assistant prefill is NOT supported. Mirrors the backend
 * per-protocol `capabilities.prefill` flags (protocol-registry — the canonical
 * source): `anthropic` and `google*` have no prefill channel in VT, and
 * `koboldcpp`'s native adapter builds the flat prompt itself (a pushed trailing
 * assistant message would never reach the model). Everything else — the
 * OpenAI-compat family (clouds AND local backends), `llamacpp`, `ollama`,
 * `unsloth` — pushes the prefill as the trailing assistant message, which is
 * exactly the continuation-point seam (LS-2/LS-3).
 */
const ASSISTANT_PREFILL_DISABLED_PRESETS = new Set<string>([
  PROVIDER_TYPE.anthropic,
  PROVIDER_TYPE.google,
  PROVIDER_TYPE.googleInteractions,
  PROVIDER_TYPE.koboldCpp,
]);

/** Fail-closed assistant-prefill gate, shared web + API (same contract as
 *  {@link resolveTextCompletionSupport}). Gates BOTH LS-4 surfaces: the
 *  per-send prefill strip's base gate and the Continue button (a continuation
 *  IS a prefill of the existing text — providers that cannot accept a
 *  pushed assistant message cannot continue one). */
export function resolveAssistantPrefillSupport(providerPreset: string | null | undefined): { supported: boolean; reason: string } {
  const preset = (providerPreset ?? "").trim();
  if (ASSISTANT_PREFILL_DISABLED_PRESETS.has(preset)) {
    return { supported: false, reason: "provider_has_no_prefill_channel" };
  }
  return { supported: true, reason: "provider_pushes_trailing_assistant_message" };
}

/**
 * The LOCAL-only gate for the per-send prefill strip (LS-4b, owner decision
 * 2026-09-09: cloud prefill stays preset-field-only, never surfaced as a
 * per-send control). Local preset ids gate directly; the generic
 * `openai_compat` preset id is ambiguous (a custom profile can point at a
 * local LM Studio-style server or at a cloud host), so it is resolved by
 * ENDPOINT — localhost/127.0.0.1 = local backend, anything else = cloud →
 * no strip (same endpoint inference {@link resolveLogitBiasSupport} uses).
 * Always fails closed for unknown ids.
 */
const LOCAL_PER_SEND_PREFILL_PRESETS = new Set([
  PROVIDER_TYPE.ollama,
  PROVIDER_TYPE.llamaCpp,
  PROVIDER_TYPE.unsloth,
  "vllm",
  "ooba",
  "tabby",
  "aphrodite",
  "lmstudio",
]);

export function resolvePerSendPrefillSupport(providerPreset: string | null | undefined, endpoint?: string | null): { supported: boolean; reason: string } {
  const preset = (providerPreset ?? "").trim();
  // Capability first, so the diagnostic reason is always accurate (e.g.
  // koboldcpp: no prefill channel, not "cloud").
  const prefill = resolveAssistantPrefillSupport(preset);
  if (!prefill.supported) return prefill;
  if (LOCAL_PER_SEND_PREFILL_PRESETS.has(preset)) {
    return { supported: true, reason: "local_prefill_provider" };
  }
  const inferred = preset === PROVIDER_TYPE.openaiCompat ? inferPresetFromEndpoint(endpoint) : null;
  if (inferred === "local") {
    return { supported: true, reason: "local_endpoint_openai_compat" };
  }
  return { supported: false, reason: "cloud_prefill_not_surfaced_per_send" };
}

/**
 * Where the AUTO generation-format mode takes its glue for a provider preset
 * in TC mode:
 * - `backend`  — llama-server's `POST /apply-template` offloads the model's
 *   own Jinja chat template (verified live on llama-server b10786, 2026-09-09:
 *   endpoint present, renders trailing assistant continuation exactly).
 * - `default`  — the documented default template (VT's role-prefixed
 *   serialization; the provider exposes no template API — LM Studio, ooba,
 *   TabbyAPI, Aphrodite, vLLM, generic openai_compat).
 * - `native`   — KoboldCPP builds its own prompt in its adapter; auto is a
 *   no-op there.
 * - `none`     — not a TC provider at all.
 */
export type AutoTemplateSource = "backend" | "default" | "native" | "none";

export function resolveAutoTemplateSource(providerPreset: string | null | undefined): AutoTemplateSource {
  const preset = (providerPreset ?? "").trim();
  if (preset === PROVIDER_TYPE.koboldCpp) return "native";
  if (preset === PROVIDER_TYPE.llamaCpp) return "backend";
  if (TEXT_COMPLETION_PRESETS.has(preset)) return "default";
  return "none";
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

  if (["ollama", "llamacpp", "vllm", "ooba", "tabby", "aphrodite", "lmstudio", "local"].includes(inferredPreset)) {
    return { supported: true, reason: "local_known_tokenizer", tokenizerHint };
  }

  return { supported: false, reason: "unknown_provider" };
}
