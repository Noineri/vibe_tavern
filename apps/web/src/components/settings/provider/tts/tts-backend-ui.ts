/**
 * Per-variant FIELD CONFIGURATION for the TTS profile editor (defects
 * report D5/F5): instead of four duplicated conditional JSX branches, the
 * editor renders two section cards ("Connection", "Voice & tuning") from a
 * declarative spec per UI variant — the same idea as the LLM provider
 * presets (one registry entry drives the form).
 *
 * The "local" variant (D8) is a UI variant of the OpenAI-compatible
 * backend: the backend enum and the DB never change. Its marker is the
 * config-bag flag `localServer: true`, so the variant survives
 * save/reopen without a migration. Only this variant owns the discovery
 * panel and the quickstart (docker) helpers.
 */

import { TTS_BACKEND, type TtsBackendSlug } from "@vibe-tavern/domain";

import type Resources from "../../../../i18n/resources.js";

/** Typed i18n key (TFunc pattern — typo'd keys fail to compile). */
export type TtsI18nKey = keyof Resources["en"];

/** Config-bag marker distinguishing "Local server" from the cloud
 *  OpenAI-compatible variant (see module doc). */
export const TTS_LOCAL_SERVER_FLAG = "localServer";

/** Preset id key in the config bag — distinguishes Cloud (preset-driven) from
 *  Custom (bare openai-compatible) and survives save/reopen. */
export const TTS_PRESET_CONFIG_KEY = "preset";

/** Top-level segments rendered by the forked ProviderForm (TtsProviderForm).
 *  The five original variants are grouped into four segments; cloud presets
 *  (including native gemini/elevenlabs via the TE2-1 registry) share one.
 */
export type TtsProviderSegment = "browser" | "local" | "cloud" | "custom";

export type TtsUiVariant = "kokoro" | "local" | "openai" | "gemini" | "elevenlabs" | "cartesia" | "inworld";

export interface TtsNumberFieldSpec {
  kind: "number";
  key: string;
  labelKey: TtsI18nKey;
  min: number;
  max: number;
  step: number;
  fallback: number;
}

export interface TtsToggleFieldSpec {
  kind: "toggle";
  key: string;
  labelKey: TtsI18nKey;
}

export interface TtsTextareaFieldSpec {
  kind: "textarea";
  key: string;
  labelKey: TtsI18nKey;
  placeholderKey: TtsI18nKey;
}

export interface TtsSelectFieldSpec {
  kind: "select";
  key: string;
  labelKey: TtsI18nKey;
  /** Static option list (response formats); fetched lists live elsewhere. */
  options: Array<{ id: string; label: string }>;
  fallback: string;
  testid: string;
}

export type TtsTuningFieldSpec =
  | TtsNumberFieldSpec
  | TtsToggleFieldSpec
  | TtsTextareaFieldSpec
  | TtsSelectFieldSpec;

export interface TtsConnectionSpec {
  /** Endpoint input (OpenAI-compatible variants only). */
  endpoint?: { placeholder: string };
  /** Masked key field — absent for kokoro (browser-local, no credentials). */
  apiKey?: { placeholder: string };
  /** Model field: "fetch" = draft-fetched list + manual fallback (F3);
   *  "input" = plain typeable input (ElevenLabs has no list endpoint). */
  model?: {
    mode: "fetch" | "input";
    /** Config key: "model" everywhere except ElevenLabs ("modelId"). */
    key: "model" | "modelId";
    labelKey: TtsI18nKey;
  };
}

export interface TtsUiSpec {
  connection: TtsConnectionSpec;
  tuning: TtsTuningFieldSpec[];
  /** Local-server helpers (discovery + quickstart) — the "local" variant only. */
  localHelpers: boolean;
}

const RESPONSE_FORMAT_OPTIONS = [
  { id: "mp3", label: "mp3" },
  { id: "opus", label: "opus" },
  { id: "aac", label: "aac" },
  { id: "flac", label: "flac" },
  { id: "wav", label: "wav" },
];

/** Curated emotion subset for the UI select (the API enum has 50+ values —
 *  docs list neutral/calm/angry/content/sad/scared as primaries). The
 *  backend passes emotion through verbatim, so a hand-edited config may
 *  carry any other documented enum value. */
const CARTESIA_EMOTION_OPTIONS = [
  "neutral",
  "calm",
  "happy",
  "excited",
  "curious",
  "flirtatious",
  "affectionate",
  "content",
  "angry",
  "sarcastic",
  "mysterious",
  "sad",
  "anxious",
  "scared",
  "bored",
  "tired",
  "proud",
  "confident",
  "contemplative",
] as const;

const OPENAI_TUNING: TtsTuningFieldSpec[] = [
  {
    kind: "select",
    key: "responseFormat",
    labelKey: "tts_field_response_format",
    options: RESPONSE_FORMAT_OPTIONS,
    fallback: "mp3",
    testid: "tts-field-response-format",
  },
  { kind: "number", key: "speed", labelKey: "tts_field_speed", min: 0.25, max: 4.0, step: 0.1, fallback: 1 },
];

const SPECS: Record<TtsUiVariant, TtsUiSpec> = {
  kokoro: {
    connection: {},
    tuning: [{ kind: "number", key: "speed", labelKey: "tts_field_speed", min: 0.5, max: 2.0, step: 0.1, fallback: 1 }],
    localHelpers: false,
  },
  local: {
    connection: {
      endpoint: { placeholder: "http://127.0.0.1:8880/v1" },
      apiKey: { placeholder: "" },
      model: { mode: "fetch", key: "model", labelKey: "tts_field_model" },
    },
    tuning: OPENAI_TUNING,
    localHelpers: true,
  },
  openai: {
    connection: {
      endpoint: { placeholder: "https://api.example.com/v1" },
      apiKey: { placeholder: "sk-..." },
      model: { mode: "fetch", key: "model", labelKey: "tts_field_model" },
    },
    tuning: OPENAI_TUNING,
    localHelpers: false,
  },
  gemini: {
    connection: {
      apiKey: { placeholder: "AIza..." },
      model: { mode: "fetch", key: "model", labelKey: "tts_field_model" },
    },
    tuning: [
      {
        kind: "textarea",
        key: "styleInstructions",
        labelKey: "tts_field_style_instructions",
        placeholderKey: "tts_field_style_instructions_placeholder",
      },
    ],
    localHelpers: false,
  },
  elevenlabs: {
    connection: {
      apiKey: { placeholder: "sk_..." },
      model: { mode: "input", key: "modelId", labelKey: "tts_field_model_id" },
    },
    tuning: [
      { kind: "number", key: "stability", labelKey: "tts_field_stability", min: 0, max: 1, step: 0.05, fallback: 0.5 },
      { kind: "number", key: "similarityBoost", labelKey: "tts_field_similarity", min: 0, max: 1, step: 0.05, fallback: 0.75 },
      { kind: "number", key: "style", labelKey: "tts_field_style", min: 0, max: 1, step: 0.05, fallback: 0 },
      { kind: "toggle", key: "useSpeakerBoost", labelKey: "tts_field_speaker_boost" },
      { kind: "number", key: "speed", labelKey: "tts_field_speed", min: 0.7, max: 1.2, step: 0.05, fallback: 1 },
    ],
    localHelpers: false,
  },
  cartesia: {
    connection: {
      apiKey: { placeholder: "sk_car_..." },
      // Static documented catalog served by the backend's listModels() —
      // the fetch mode resolves through the draft models route, no
      // network discovery on Cartesia's side (no /models endpoint exists).
      model: { mode: "fetch", key: "modelId", labelKey: "tts_field_model" },
    },
    tuning: [
      // generation_config on sonic-3+ only — the backend gates it per
      // model; sonic-2/turbo silently ignore these two fields.
      { kind: "number", key: "speed", labelKey: "tts_field_speed", min: 0.6, max: 1.5, step: 0.05, fallback: 1 },
      {
        kind: "select",
        key: "emotion",
        labelKey: "tts_field_emotion",
        // API tokens double as labels (same convention as responseFormat).
        options: CARTESIA_EMOTION_OPTIONS.map((e) => ({ id: e, label: e })),
        fallback: "neutral",
        testid: "tts-field-emotion",
      },
    ],
    localHelpers: false,
  },
  inworld: {
    connection: {
      apiKey: { placeholder: "Inworld API key" },
      // Static documented catalog via listModels() — Inworld's only
      // list-models endpoint serves LLM-router models, not TTS.
      model: { mode: "fetch", key: "modelId", labelKey: "tts_field_model" },
    },
    tuning: [
      // audioConfig.speakingRate — documented range [0.5, 1.5].
      { kind: "number", key: "speed", labelKey: "tts_field_speed", min: 0.5, max: 1.5, step: 0.05, fallback: 1 },
      {
        kind: "select",
        key: "deliveryMode",
        labelKey: "tts_field_delivery_mode",
        // deliveryMode is inworld-tts-2 only — the backend gates it per
        // model (never sent on 1.5/1.x where it is "ignored").
        options: ["STABLE", "BALANCED", "CREATIVE"].map((m) => ({ id: m, label: m })),
        fallback: "BALANCED",
        testid: "tts-field-delivery-mode",
      },
    ],
    localHelpers: false,
  },
};

export function ttsUiSpecFor(variant: TtsUiVariant): TtsUiSpec {
  return SPECS[variant];
}

/** Derive the UI variant from the wire state: backend + the localServer
 *  config flag (an openai-compatible row carrying the flag reopens as the
 *  "Local server" variant). */
export function ttsUiVariantOf(backend: TtsBackendSlug, config: Record<string, unknown>): TtsUiVariant {
  if (backend === TTS_BACKEND.OpenAiCompatible) {
    return config[TTS_LOCAL_SERVER_FLAG] === true ? "local" : "openai";
  }
  if (backend === TTS_BACKEND.Gemini) return "gemini";
  if (backend === TTS_BACKEND.ElevenLabs) return "elevenlabs";
  if (backend === TTS_BACKEND.Cartesia) return "cartesia";
  if (backend === TTS_BACKEND.Inworld) return "inworld";
  return "kokoro";
}

/** Derive the four-segment view for the forked ProviderForm (TE2-8):
 *  Cloud = preset-driven (config.preset present) or native gemini/
 *  elevenlabs; Custom = bare openai-compatible; Local = localServer flag;
 *  Browser = kokoro. Existing profiles without a preset reopen in the
 *  intuitive segment (preset presence is authoritative). */
export function ttsProviderSegmentOf(
  backend: TtsBackendSlug,
  config: Record<string, unknown>,
): TtsProviderSegment {
  if (backend === TTS_BACKEND.Kokoro) return "browser";
  if (config[TTS_LOCAL_SERVER_FLAG] === true) return "local";
  if (typeof config[TTS_PRESET_CONFIG_KEY] === "string" && (config[TTS_PRESET_CONFIG_KEY] as string).length > 0)
    return "cloud";
  if (backend === TTS_BACKEND.Gemini || backend === TTS_BACKEND.ElevenLabs || backend === TTS_BACKEND.Cartesia || backend === TTS_BACKEND.Inworld) return "cloud";
  return "custom";
}

/** Preset id stored in config.preset (or '' when none). */
export function ttsPresetIdOf(config: Record<string, unknown>): string {
  const v = config[TTS_PRESET_CONFIG_KEY];
  return typeof v === "string" ? v : "";
}

/** The wire backend a UI variant edits (the local variant rides the
 *  OpenAI-compatible backend — enum unchanged, D8). */
export function backendForVariant(variant: TtsUiVariant): TtsBackendSlug {
  switch (variant) {
    case "kokoro":
      return TTS_BACKEND.Kokoro;
    case "local":
    case "openai":
      return TTS_BACKEND.OpenAiCompatible;
    case "gemini":
      return TTS_BACKEND.Gemini;
    case "elevenlabs":
      return TTS_BACKEND.ElevenLabs;
    case "cartesia":
      return TTS_BACKEND.Cartesia;
    case "inworld":
      return TTS_BACKEND.Inworld;
  }
}
