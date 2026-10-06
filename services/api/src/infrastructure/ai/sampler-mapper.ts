/**
 * Sampler mapper — routes sampler fields from StoredProviderProfileRecord
 * to either native AI SDK parameters or per-provider providerOptions namespaces.
 *
 * Both executors (nonstreaming, streaming) spread the returned SamplerConfig
 * into their generateText() / streamText() call.
 *
 * When `customSamplers` is false, only basic params (temperature, maxOutputTokens,
 * stopSequences, seed, reasoningEffort) are sent to the provider. All advanced
 * sampler fields (topP, topK, minP, topA, typical/tfs, mirostat, DRY/XTC,
 * penalties) are skipped so the provider uses its own defaults.
 *
 * All sampler output is gated by resolveSamplerCapabilities() — only fields
 * the provider actually supports are emitted, preventing API errors from
 * unsupported parameters.
 */

import type { JSONValue } from "@ai-sdk/provider";
import {
  PHRASE_REP_PEN,
  PROVIDER_PROFILE_GENERATION_DEFAULTS,
  PROVIDER_TYPE,
  normalizeProviderType,
  resolveLogitBiasSupport,
  resolveSamplerCapabilities,
} from "@vibe-tavern/domain";
import type { StoredProviderProfileRecord, SamplerFieldId } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Config object spreadable into generateText() / streamText(). */
export interface SamplerConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  topK?: number;
  /** AI SDK v7 provider-neutral reasoning effort (CallSettings.reasoning — a
   *  flat string union, not the v4/v5 `{ effort }` object). Consumed by the
   *  classic-Google language model (maps to generationConfig.thinkingConfig)
   *  and by the Anthropic model ONLY for legacy families (adapter-derived
   *  thinking budget; sampling drop is provider-mandated with thinking on).
   *  Effort-capable Anthropic families ride `providerOptions.anthropic`
   *  instead — see anthropicEffortFamily in sampler-mapper.ts and the SDK
   *  interplay pins in test/reasoning-effort-sdk-interplay.test.ts. */
  reasoning?: "low" | "medium" | "high";
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * llama.cpp sampler chain emitted for llama-server-backed providers
 * (LOCAL_SAMPLERS_ADDITION_REPORT B1/B2, V1 probe on llama-server b10786): on
 * the /v1/chat endpoint exotic samplers are accepted but ONLY applied when
 * listed in the `samplers` JSON array — providing the chain replaces the
 * server's default chain, so it must carry the full default order or
 * previously-applied samplers (temperature, penalties, top_k/top_p/min_p, dry,
 * xtc) would be silently dropped. Names are llama.cpp's canonical sampler
 * names (common_sampler_types_from_names); the V1 probe confirmed `adaptive`
 * alone does NOT match — `adaptive_p` does. `top_n_sigma` and `dry` are part
 * of the same chain, so the B2 numeric tail (top_n_sigma, DRY window) rides
 * this emission without new entries; dynatemp_* and smoothing_factor are
 * parameters consumed by the listed temperature/top_p samplers.
 * `adaptive_p` is listed LAST and only when adaptive-p itself is enabled: it
 * is a token-selecting sampler (replaces `dist`) and llama.cpp always appends
 * it at the very end of the chain.
 * KoboldCPP's native path needs no chain (its request fields are standalone).
 */
const LLAMACPP_SAMPLER_CHAIN_BASE = [
  "penalties",
  "dry",
  "top_n_sigma",
  "top_k",
  "typ_p",
  "top_p",
  "min_p",
  "xtc",
  "temperature",
] as const;

const LLAMACPP_SAMPLER_CHAIN = [...LLAMACPP_SAMPLER_CHAIN_BASE, "adaptive_p"] as const;

/** NovelAI native `order` sampler ids — WHICH samplers run on /ai/generate
 *  (SillyTavern nai-settings.js:71-82; spec text.RequestParameters.order).
 *  6 = cfg and 7 = top_g are deprecated (community KB; owner ruling
 *  2026-10-05, withdrawn) and never emitted. `as const` object, not an
 *  enum (project rule). */
const NOVELAI_SAMPLER_ID = {
  temperature: 0,
  topK: 1,
  topP: 2,
  tfs: 3,
  topA: 4,
  typicalP: 5,
  mirostat: 8,
  math1: 9,
  minP: 10,
} as const;

/** SillyTavern's `default_order` for the base samplers — the emitted order
 *  starts from this sequence filtered to the active samplers, then appends
 *  mirostat (8), math1 (9), min_p (10) in that order (NAI-3b). */
const NOVELAI_BASE_ORDER = [1, 5, 0, 2, 3, 4] as const;

/** Emit the adaptive-p request fields for one provider bag. Shared by the
 *  llama.cpp/unsloth (llama-server) and koboldcpp (native request fields)
 *  branches. `adaptiveTarget` values < 0 mean disabled (llama.cpp's default
 *  −1) — nothing is emitted. The `samplers` chain is emitted separately by
 *  the llama-server branch (see emitLlamaSamplerChain). */
function emitAdaptivePOptions(
  providerOpts: Record<string, JSONValue>,
  can: (field: SamplerFieldId) => boolean,
  profile: StoredProviderProfileRecord,
): void {
  if (!(can("adaptiveTarget") && profile.adaptiveTarget != null && profile.adaptiveTarget >= 0)) return;
  providerOpts.adaptive_target = profile.adaptiveTarget;
  if (can("adaptiveDecay") && profile.adaptiveDecay != null) {
    providerOpts.adaptive_decay = profile.adaptiveDecay;
  }
}

/** Whether any of the llama-server-only exotic samplers that REQUIRE a chain
 *  entry (adaptive-p, top_n_sigma, DRY) is active for this profile.
 *  dynatemp_* / smoothing_factor are temperature/top_p modifiers and do not
 *  force the chain on their own, but they are covered whenever the chain IS
 *  emitted (they ride the same request fields). */
function isLlamaChainActive(
  can: (field: SamplerFieldId) => boolean,
  profile: StoredProviderProfileRecord,
): boolean {
  const adaptiveOn = can("adaptiveTarget") && profile.adaptiveTarget != null && profile.adaptiveTarget >= 0;
  if (adaptiveOn) return true;
  if (can("topNSigma") && profile.topNSigma != null && profile.topNSigma > 0) return true;
  if (can("dryPenaltyLastN") && profile.dryPenaltyLastN != null && profile.dryPenaltyLastN > 0) return true;
  return false;
}

/** Emit the llama-server numeric tail (LOCAL_SAMPLERS_ADDITION_REPORT B2).
 *  Off semantics follow upstream defaults: dynatemp_range / top_n_sigma /
 *  smoothing_factor 0 = disabled (nothing emitted), dynatemp_exponent only
 *  rides an enabled range. `dry_penalty_last_n` (V1 probe): llama-server
 *  REJECTS −1 with HTTP 400 and 0 means a zero window (DRY inert), so the
 *  disabled sentinel (−1, the column default) and 0 are both omitted — only a
 *  real window (> 0, recommended 512) is ever emitted. */
function emitLlamaNumericTailOptions(
  providerOpts: Record<string, JSONValue>,
  can: (field: SamplerFieldId) => boolean,
  profile: StoredProviderProfileRecord,
): void {
  if (can("topNSigma") && profile.topNSigma != null && profile.topNSigma > 0) {
    providerOpts.top_n_sigma = profile.topNSigma;
  }
  if (can("dynatempRange") && profile.dynatempRange != null && profile.dynatempRange > 0) {
    providerOpts.dynatemp_range = profile.dynatempRange;
    if (can("dynatempExponent") && profile.dynatempExponent != null) {
      providerOpts.dynatemp_exponent = profile.dynatempExponent;
    }
  }
  if (can("smoothingFactor") && profile.smoothingFactor != null && profile.smoothingFactor > 0) {
    providerOpts.smoothing_factor = profile.smoothingFactor;
  }
  if (can("dryPenaltyLastN") && profile.dryPenaltyLastN != null && profile.dryPenaltyLastN > 0) {
    providerOpts.dry_penalty_last_n = profile.dryPenaltyLastN;
  }
}

/** Build NovelAI's native `order` — the ids of the samplers that RUN
 *  (NOVELAI_PROVIDER_PLAN NAI-3b; SillyTavern nai-settings.js
 *  `default_order`). A sampler enters the order only when non-neutral:
 *  temperature always; top_k > 0; top_p < 1; tfs < 1; top_a > 0;
 *  typical_p < 1; min_p > 0; math1 (Unified) when any of Linear ≠ 1 /
 *  Quad ≠ 0 / Conf ≠ 0; mirostat only when tau > 0 AND differs from the
 *  profile default 5.0 — mirostat has no neutral value, so an untouched
 *  default must not silently turn the sampler on. */
export function buildNovelaiOrder(
  profile: StoredProviderProfileRecord,
  can: (field: SamplerFieldId) => boolean,
): number[] {
  const active = new Set<number>([NOVELAI_SAMPLER_ID.temperature]);
  if (can("topK") && profile.topK != null && profile.topK > 0) active.add(NOVELAI_SAMPLER_ID.topK);
  if (can("topP") && profile.topP != null && profile.topP < 1) active.add(NOVELAI_SAMPLER_ID.topP);
  if (can("tfsZ") && profile.tfsZ != null && profile.tfsZ < 1) active.add(NOVELAI_SAMPLER_ID.tfs);
  if (can("topA") && profile.topA != null && profile.topA > 0) active.add(NOVELAI_SAMPLER_ID.topA);
  if (can("typicalP") && profile.typicalP != null && profile.typicalP < 1) active.add(NOVELAI_SAMPLER_ID.typicalP);
  if (
    can("mirostatTau") &&
    profile.mirostatTau != null &&
    profile.mirostatTau > 0 &&
    profile.mirostatTau !== PROVIDER_PROFILE_GENERATION_DEFAULTS.mirostatTau
  ) {
    active.add(NOVELAI_SAMPLER_ID.mirostat);
  }
  if (
    (can("unifiedLinear") && profile.unifiedLinear != null && profile.unifiedLinear !== 1) ||
    (can("unifiedQuad") && profile.unifiedQuad != null && profile.unifiedQuad !== 0) ||
    (can("unifiedConf") && profile.unifiedConf != null && profile.unifiedConf !== 0)
  ) {
    active.add(NOVELAI_SAMPLER_ID.math1);
  }
  if (can("minP") && profile.minP != null && profile.minP > 0) active.add(NOVELAI_SAMPLER_ID.minP);
  const order: number[] = NOVELAI_BASE_ORDER.filter((id) => active.has(id));
  // Tail samplers: mirostat (8), math1 (9), min_p (10) — appended in that
  // order after the base sequence.
  for (const id of [NOVELAI_SAMPLER_ID.mirostat, NOVELAI_SAMPLER_ID.math1, NOVELAI_SAMPLER_ID.minP]) {
    if (active.has(id)) order.push(id);
  }
  return order;
}

/** Map the stored reasoning-effort value onto the concrete levels the SDK
 *  accepts. Only low/medium/high map 1:1; "auto" (the profile default) and
 *  any empty/unknown value send NOTHING — no `reasoning` key and no
 *  providerOptions — so the provider applies its own default and the request
 *  stays byte-identical to a profile that never touched the control. */
function mapReasoningEffort(effort: string | null | undefined): "low" | "medium" | "high" | undefined {
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
}

/** Anthropic effort routing, by model family (docs.anthropic.com/en/docs/
 *  build-with-claude/thinking — per-model thinking table + "Sampling
 *  parameters" section; effort compatibility: /docs/build-with-claude/effort).
 *
 *  - effortPlusThinking — sampling params (temperature/topP/topK) return a
 *    400 on EVERY request for these families (Fable/Mythos 5 incl. Preview,
 *    Opus 4.7+/5.x, Sonnet 5+), and most default to adaptive thinking anyway.
 *    Nothing is lost by sending thinking, so we send `thinking: adaptive,
 *    display: summarized` + effort — reproducing exactly what the neutral
 *    `reasoning` path did (visible thinking summaries included). WITHOUT the
 *    explicit thinking field, Opus 4.7/4.8 think NOTHING (their no-field
 *    default is off) — the 2026-10-04 v1 of this split made exactly that
 *    mistake.
 *  - effortOnly — the real choice exists here (Opus 4.5/4.6, Sonnet 4.6):
 *    sampling params are legal with thinking off, and thinking is OFF by
 *    default. Owner ruling 2026-10-04: effort as a profile default must not
 *    cost temperature/topK — so effort rides output_config WITHOUT thinking
 *    (thinking off; effort steers response thoroughness only). These are the
 *    only families where the fix actually restores sampling.
 *  - legacy — everything else (3.x, Opus 4.0–4.1, Sonnet 4.0/4.5, Haiku,
 *    unknown/empty ids): no effort support (output_config would 400); keep
 *    the neutral `reasoning` path (adapter-derived thinking budget; the
 *    sampling drop there is provider-mandated with thinking on). Unknown
 *    future ids stay here deliberately — never send a body an unlisted
 *    model may reject. */
type AnthropicEffortFamily = "effortPlusThinking" | "effortOnly" | "legacy";

function anthropicEffortFamily(model: string | undefined): AnthropicEffortFamily {
  if (!model) return "legacy";
  // Sampling-rejected families (incl. future ids inside these lineages).
  if (/(?:fable|mythos)-(?:5|preview)|opus-4-[7-9]|opus-[5-9]|sonnet-[5-9]/i.test(model)) {
    return "effortPlusThinking";
  }
  // Either/or families: sampling legal with thinking off, effort supported.
  if (/opus-4-[5-6]|sonnet-4-[6-9]/i.test(model)) {
    return "effortOnly";
  }
  return "legacy";
}

/**
 * Build the sampler config for a given provider profile.
 *
 * `requestModel` is the model id actually used for THIS call (the executors'
 * `input.model`) — required for model-family-sensitive routing (Anthropic
 * effort vs thinking budget). Omitted, it degrades to the conservative
 * path (never sends a body an older model would reject).
 *
 * Returns an object that can be spread directly into generateText() / streamText().
 * Routes each sampler field to either native AI SDK params or providerOptions
 * based on the provider type.
 *
 * When `customSamplers` is false, advanced sampler params are omitted entirely,
 * letting the provider use its built-in defaults.
 *
 * All fields are gated by resolveSamplerCapabilities() for the provider's
 * preset + type, so only supported params reach the API.
 */
export function buildSamplerConfig(
  profile: StoredProviderProfileRecord,
  requestModel?: string,
): SamplerConfig {
  const providerType = normalizeProviderType(profile.providerPreset);
  const caps = resolveSamplerCapabilities(profile.providerPreset, providerType);

  /** Check if a sampler field is supported by this provider. */
  const can = (field: SamplerFieldId): boolean => caps[field] === true;

  // -- Always-sent params: temperature, maxOutputTokens, stopSequences --
  const config: SamplerConfig = {};

  if (can("temperature") && profile.temperature != null) config.temperature = profile.temperature;
  if (profile.maxTokens != null && profile.maxTokens > 0) config.maxOutputTokens = profile.maxTokens;

  if (can("stopSequences") && profile.stopSequences.length > 0) {
    config.stopSequences = profile.stopSequences;
  }

  // -- If custom samplers are disabled, skip all advanced params --
  if (!profile.customSamplers) {
    // Only pass seed (if set and supported) even without custom samplers
    if (can("seed") && profile.seed != null) {
      const parsed = typeof profile.seed === "number"
        ? profile.seed
        : parseInt(String(profile.seed), 10);
      if (!isNaN(parsed)) config.seed = parsed;
    }
    return config;
  }

  // -- Custom samplers enabled: route advanced params per provider type --

  if (can("topP") && profile.topP != null) config.topP = profile.topP;

  switch (providerType) {
    // -- OpenAI-compatible providers + local native Ollama/llamacpp --------
    case PROVIDER_TYPE.openaiCompat:
    case PROVIDER_TYPE.ollama:
    case PROVIDER_TYPE.llamaCpp:
    case PROVIDER_TYPE.unsloth: {
      // Native params (gated by capabilities)
      if (can("frequencyPenalty") && profile.frequencyPenalty != null) config.frequencyPenalty = profile.frequencyPenalty;
      if (can("presencePenalty") && profile.presencePenalty != null) config.presencePenalty = profile.presencePenalty;
      if (can("seed") && profile.seed != null) {
        const parsed = typeof profile.seed === "number"
          ? profile.seed
          : parseInt(String(profile.seed), 10);
        if (!isNaN(parsed)) config.seed = parsed;
      }

      // providerOptions.<providerName> namespace — must match createOpenAICompatible({ name })
      const providerOptionsKey = providerType === PROVIDER_TYPE.openaiCompat ? "openai_compat"
        : providerType === PROVIDER_TYPE.ollama ? "ollama"
        : providerType === PROVIDER_TYPE.unsloth ? "unsloth"
        : "llamacpp";
      const providerOpts: Record<string, JSONValue> = {};
      if (can("topK") && profile.topK != null) providerOpts.top_k = profile.topK;
      if (can("topA") && profile.topA != null) providerOpts.top_a = profile.topA;
      if (can("minP") && profile.minP != null) providerOpts.min_p = profile.minP;
      if (can("typicalP") && profile.typicalP != null) providerOpts.typical_p = profile.typicalP;
      if (can("tfsZ") && profile.tfsZ != null) providerOpts.tfs_z = profile.tfsZ;
      // adaptive-p — only applied on /v1/chat when listed in the `samplers`
      // chain (V1 probe); the chain emission is what makes it take effect.
      emitAdaptivePOptions(providerOpts, can, profile);
      // llama-server numeric tail (B2). The chain is emitted when adaptive-p
      // OR any chain-gated exotic (top_n_sigma, DRY window) is active — the
      // tail params are inert without it.
      emitLlamaNumericTailOptions(providerOpts, can, profile);
      if (isLlamaChainActive(can, profile)) {
        const adaptiveOn = can("adaptiveTarget") && profile.adaptiveTarget != null && profile.adaptiveTarget >= 0;
        providerOpts.samplers = adaptiveOn ? [...LLAMACPP_SAMPLER_CHAIN] : [...LLAMACPP_SAMPLER_CHAIN_BASE];
      }
      if (can("repeatLastN") && profile.repeatLastN != null) providerOpts.repeat_last_n = profile.repeatLastN;
      if (can("mirostat") && profile.mirostat != null) providerOpts.mirostat = profile.mirostat;
      if (can("mirostatTau") && profile.mirostatTau != null) providerOpts.mirostat_tau = profile.mirostatTau;
      if (can("mirostatEta") && profile.mirostatEta != null) providerOpts.mirostat_eta = profile.mirostatEta;
      if (can("dryMultiplier") && profile.dryMultiplier != null) providerOpts.dry_multiplier = profile.dryMultiplier;
      if (can("dryBase") && profile.dryBase != null) providerOpts.dry_base = profile.dryBase;
      if (can("dryAllowedLength") && profile.dryAllowedLength != null) providerOpts.dry_allowed_length = profile.dryAllowedLength;
      if (can("drySequenceBreakers") && profile.drySequenceBreakers?.length) providerOpts.dry_sequence_breakers = profile.drySequenceBreakers;
      if (can("xtcThreshold") && profile.xtcThreshold != null) providerOpts.xtc_threshold = profile.xtcThreshold;
      if (can("xtcProbability") && profile.xtcProbability != null) providerOpts.xtc_probability = profile.xtcProbability;
      if (can("repetitionPenalty") && profile.repetitionPenalty != null) {
        // Ollama's native name is repeat_penalty; OpenAI-compatible llama.cpp
        // style providers commonly accept repetition_penalty.
        if (providerType === PROVIDER_TYPE.ollama) providerOpts.repeat_penalty = profile.repetitionPenalty;
        else providerOpts.repetition_penalty = profile.repetitionPenalty;
      }

      // Logit bias: map entries to Record<number, number>
      if (can("logitBias") && profile.logitBias?.length && resolveLogitBiasSupport(profile.providerPreset, profile.defaultModel, profile.endpoint).supported) {
        const currentModel = profile.defaultModel ?? "";
        const usableEntries = profile.logitBias.filter((entry) => currentModel.length > 0 && entry.model === currentModel);
        if (usableEntries.length > 0) {
          const biasMap: Record<string, number> = {};
          for (const entry of usableEntries) {
            biasMap[String(entry.tokenId)] = entry.bias;
          }
          providerOpts.logit_bias = biasMap;
        }
      }

      // reasoningEffort — gated by capabilities
      if (can("reasoningEffort") && profile.reasoningEffort != null) {
        providerOpts.reasoningEffort = profile.reasoningEffort;
      }

      // Unsloth Studio: map showReasoning -> enable_thinking (Unsloth-specific body field
      // consumed by the underlying llama-server). Forwarded via providerOptions.unsloth.
      if (providerType === PROVIDER_TYPE.unsloth) {
        providerOpts.enable_thinking = profile.showReasoning;
      }

      // NovelAI /oa/v1: map thinkingMode -> enable_thinking. "auto" means the
      // field stays absent (owner ruling 2026-10-05). Gated by `can`, so only
      // the novelai_oa sampler set (the sole set with thinkingMode) emits it —
      // every other preset's request body is unchanged.
      if (can("thinkingMode") && profile.thinkingMode !== "auto") {
        providerOpts.enable_thinking = profile.thinkingMode === "on";
      }

      if (Object.keys(providerOpts).length > 0) {
        config.providerOptions = { [providerOptionsKey]: providerOpts };
      }
      break;
    }

    // -- Anthropic ------------------------------------------------------------
    case PROVIDER_TYPE.anthropic: {
      // Native topK (gated); no frequencyPenalty, presencePenalty, or seed
      if (can("topK") && profile.topK != null) config.topK = profile.topK;
      // reasoningEffort — routed by model family (owner 2026-10-04: effort as
      // a profile default must not cost temperature/topK where the API allows
      // both to coexist — and must not silently disable thinking where it
      // doesn't). See anthropicEffortFamily for the three-way split and the
      // docs citations; both paths are pinned in
      // test/reasoning-effort-sdk-interplay.test.ts against the installed
      // adapter.
      const effort = mapReasoningEffort(profile.reasoningEffort);
      if (can("reasoningEffort") && effort != null) {
        const family = anthropicEffortFamily(requestModel);
        if (family === "effortPlusThinking") {
          config.providerOptions = {
            anthropic: { effort, thinking: { type: "adaptive", display: "summarized" } },
          };
        } else if (family === "effortOnly") {
          config.providerOptions = { anthropic: { effort } };
        } else {
          config.reasoning = effort;
        }
      }
      break;
    }

    // -- Google (classic) ------------------------------------------------------
    case PROVIDER_TYPE.google: {
      // Only temperature, topP, maxOutputTokens, stopSequences (already set above).
      // reasoningEffort -> SDK-neutral `reasoning` call setting: nothing reaches
      // the model unless set here — @ai-sdk/google maps it to
      // generationConfig.thinkingConfig (thinkingLevel on Gemini 3,
      // thinkingBudget on 2.5).
      const effort = mapReasoningEffort(profile.reasoningEffort);
      if (can("reasoningEffort") && effort != null) config.reasoning = effort;
      break;
    }

    // -- Google Interactions ---------------------------------------------------
    case PROVIDER_TYPE.googleInteractions: {
      // Only temperature, topP, maxOutputTokens, stopSequences (already set above).
      // reasoningEffort -> providerOptions.google.thinkingLevel (request body
      // generation_config.thinking_level): the Interactions language model in
      // @ai-sdk/google NEVER reads the SDK-neutral `reasoning` call setting,
      // so the effort must ride the providerOptions.google namespace that
      // model documents for exactly this ("per-call options that the AI SDK
      // doesn't natively expose live here" — googleInteractionsLanguageModelOptions).
      const effort = mapReasoningEffort(profile.reasoningEffort);
      if (can("reasoningEffort") && effort != null) {
        config.providerOptions = { google: { thinkingLevel: effort } };
      }
      break;
    }

    // -- KoboldCpp -----------------------------------------------------------
    case PROVIDER_TYPE.koboldCpp: {
      // KoboldCPP uses its own native API — sampler params go through providerOptions.koboldcpp
      // and are spread into the request body by the adapter.
      const providerOpts: Record<string, JSONValue> = {};
      if (can("topK") && profile.topK != null) providerOpts.top_k = profile.topK;
      if (can("topP") && profile.topP != null) providerOpts.top_p = profile.topP;
      if (can("topA") && profile.topA != null) providerOpts.top_a = profile.topA;
      if (can("minP") && profile.minP != null) providerOpts.min_p = profile.minP;
      if (can("typicalP") && profile.typicalP != null) providerOpts.typical = profile.typicalP;
      if (can("tfsZ") && profile.tfsZ != null) providerOpts.tfs = profile.tfsZ;
      // adaptive-p (KoboldCPP native request fields; no chain needed).
      emitAdaptivePOptions(providerOpts, can, profile);
      if (can("repeatLastN") && profile.repeatLastN != null) providerOpts.rep_pen_range = profile.repeatLastN;
      if (can("repetitionPenalty") && profile.repetitionPenalty != null) providerOpts.rep_pen = profile.repetitionPenalty;
      if (can("dryMultiplier") && profile.dryMultiplier != null) providerOpts.dry_multiplier = profile.dryMultiplier;
      if (can("dryBase") && profile.dryBase != null) providerOpts.dry_base = profile.dryBase;
      if (can("dryAllowedLength") && profile.dryAllowedLength != null) providerOpts.dry_allowed_length = profile.dryAllowedLength;
      if (can("drySequenceBreakers") && profile.drySequenceBreakers?.length) providerOpts.dry_sequence_breakers = profile.drySequenceBreakers;
      // Antislop phrase banning (LOCAL_SAMPLERS_ADDITION_REPORT B3, V1-probe
      // verified on KoboldCPP 1.120): exact-match strings where leading spaces
      // are significant (" purr" ≠ "purr"). Omitted when empty; only in
      // koboldcpp_native, so `can` gates it off everywhere else.
      if (can("bannedStrings") && profile.bannedStrings?.length) providerOpts.banned_strings = profile.bannedStrings;
      if (can("xtcThreshold") && profile.xtcThreshold != null) providerOpts.xtc_threshold = profile.xtcThreshold;
      if (can("xtcProbability") && profile.xtcProbability != null) providerOpts.xtc_probability = profile.xtcProbability;
      if (can("mirostat") && profile.mirostat != null) providerOpts.mirostat = profile.mirostat;
      if (can("mirostatTau") && profile.mirostatTau != null) providerOpts.mirostat_tau = profile.mirostatTau;
      if (can("mirostatEta") && profile.mirostatEta != null) providerOpts.mirostat_eta = profile.mirostatEta;

      if (Object.keys(providerOpts).length > 0) {
        config.providerOptions = { koboldcpp: providerOpts };
      }
      break;
    }

    // -- NovelAI native /ai/generate (Kayra / Erato) -------------------------
    case PROVIDER_TYPE.novelai: {
      // Native parameter names ride providerOptions.novelai — the adapter
      // spreads them into the request's `parameters` (NAI-3a). `order` lists
      // the sampler ids that RUN; a sampler's own parameters are sent only
      // when its id is in that order (NAI-3b). Temperature rides the native
      // `temperature` field the adapter already sets; stop sequences are
      // matched client-side in the adapter (the native API takes token-id
      // arrays — never mapped here); thinkingMode has no native parameter
      // (OpenAI-compatible route only) and is deliberately not mapped.
      // Named deviation from SillyTavern: no hard-coded per-model token-id
      // lists (bad_words_ids / logit_bias_exp / repetition_penalty_whitelist)
      // — tokenizer-specific magic numbers with no NovelAI documentation.
      const order = buildNovelaiOrder(profile, can);
      // `order` is always present (temperature always runs), so the bag is
      // never empty — unlike the sibling branches no emptiness guard is
      // needed.
      const providerOpts: Record<string, JSONValue> = { order };
      if (order.includes(NOVELAI_SAMPLER_ID.topK) && profile.topK != null) {
        providerOpts.top_k = profile.topK;
      }
      if (order.includes(NOVELAI_SAMPLER_ID.topP) && profile.topP != null) {
        providerOpts.top_p = profile.topP;
      }
      if (order.includes(NOVELAI_SAMPLER_ID.tfs) && profile.tfsZ != null) {
        providerOpts.tail_free_sampling = profile.tfsZ;
      }
      if (order.includes(NOVELAI_SAMPLER_ID.topA) && profile.topA != null) {
        providerOpts.top_a = profile.topA;
      }
      if (order.includes(NOVELAI_SAMPLER_ID.typicalP) && profile.typicalP != null) {
        providerOpts.typical_p = profile.typicalP;
      }
      // mirostat (8): both of its parameters — tau and learning rate — go
      // together when the sampler runs.
      if (order.includes(NOVELAI_SAMPLER_ID.mirostat)) {
        if (profile.mirostatTau != null) providerOpts.mirostat_tau = profile.mirostatTau;
        if (profile.mirostatEta != null) providerOpts.mirostat_lr = profile.mirostatEta;
      }
      // math1 (9) = Unified Linear / Quad / Conf (spec text.RequestParameters:
      // Configures Unified Linear / Quad / Conf) — all three parameters go
      // together.
      if (order.includes(NOVELAI_SAMPLER_ID.math1)) {
        if (profile.unifiedLinear != null) providerOpts.math1_temp = profile.unifiedLinear;
        if (profile.unifiedQuad != null) providerOpts.math1_quad = profile.unifiedQuad;
        if (profile.unifiedConf != null) providerOpts.math1_quad_entropy_scale = profile.unifiedConf;
      }
      if (order.includes(NOVELAI_SAMPLER_ID.minP) && profile.minP != null) {
        providerOpts.min_p = profile.minP;
      }
      // Repetition-penalty family — penalties are not order-id samplers; each
      // parameter rides its own off value (profile field docs: repetition
      // penalty 1.0 = off, range 0 = off, slope 0 = off, freq/presence 0 =
      // off, phrase "off" = not applied), so a neutral profile sends none of
      // them and NovelAI applies its own defaults.
      if (can("repetitionPenalty") && profile.repetitionPenalty != null && profile.repetitionPenalty !== 1.0) {
        providerOpts.repetition_penalty = profile.repetitionPenalty;
      }
      if (can("repeatLastN") && profile.repeatLastN != null && profile.repeatLastN > 0) {
        providerOpts.repetition_penalty_range = profile.repeatLastN;
      }
      if (can("repetitionPenaltySlope") && profile.repetitionPenaltySlope != null && profile.repetitionPenaltySlope !== 0) {
        providerOpts.repetition_penalty_slope = profile.repetitionPenaltySlope;
      }
      if (can("frequencyPenalty") && profile.frequencyPenalty != null && profile.frequencyPenalty !== 0) {
        providerOpts.repetition_penalty_frequency = profile.frequencyPenalty;
      }
      if (can("presencePenalty") && profile.presencePenalty != null && profile.presencePenalty !== 0) {
        providerOpts.repetition_penalty_presence = profile.presencePenalty;
      }
      if (can("phraseRepPen") && profile.phraseRepPen != null && profile.phraseRepPen !== PHRASE_REP_PEN.off) {
        providerOpts.phrase_rep_pen = profile.phraseRepPen;
      }
      config.providerOptions = { novelai: providerOpts };
      break;
    }

    // -- Unknown / unsupported -----------------------------------------------
    default: {
      // Native params only (temperature, topP, maxOutputTokens, stopSequences)
      break;
    }
  }

  return config;
}
