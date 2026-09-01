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

export type TtsUiVariant = "kokoro" | "local" | "openai" | "gemini" | "elevenlabs" | "cartesia" | "inworld" | "lmnt" | "minimax" | "volcengine" | "deepgram" | "azure" | "polly" | "google-cloud";

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

export interface TtsTextFieldSpec {
  kind: "text";
  key: string;
  labelKey: TtsI18nKey;
  /** Free-form string knob whose legal values are provider-side data
   *  (e.g. Volcengine emotion — a per-voice enum that lives in the
   *  provider's voice-roster page, so a select would be a hardcoded
   *  catalog — owner rule 2026-09-01). */
  placeholderKey?: TtsI18nKey;
}

export type TtsTuningFieldSpec =
  | TtsNumberFieldSpec
  | TtsToggleFieldSpec
  | TtsTextareaFieldSpec
  | TtsSelectFieldSpec
  | TtsTextFieldSpec;

export interface TtsConnectionSpec {
  /** Endpoint input (OpenAI-compatible variants only). */
  endpoint?: { placeholder: string };
  /** Masked key field — absent for kokoro (browser-local, no credentials).
   *  The value lands in the typed apiKey column (access key / bearer —
   *  whatever the provider's single secret is). `multiline` (TPE-14
   *  Google Cloud): the "key" is the pasted service-account JSON file —
   *  rendered as an AutoTextarea paste target instead of the one-line
   *  masked input (owner decision 2026-09-02; the stored value is still
   *  never rendered back — F2b stored-key semantics apply). `docsUrl`:
   *  credential how-to link shown under the field. */
  apiKey?: { placeholder: string; multiline?: boolean; docsUrl?: string };
  /** Extra NON-secret credential input rendered above the key field
   *  (Volcengine's X-Api-App-Id — a console id, not a secret; config-bag
   *  owned). */
  appId?: { placeholder: string };
  /** Azure region (TPE-12) — non-secret, REQUIRED, rendered above the
   *  masked key (same slot as volcengine appId). */
  region?: { placeholder: string; docsUrl?: string };
  /** AWS AccessKeyId (TPE-13 Polly) — non-secret console identifier,
   *  config-bag owned; the SECRET half (Secret Access Key) is the regular
   *  masked key field. Rendered in the appId/region slot above the key. */
  accessKeyId?: { placeholder: string };
  /** Model field: "fetch" = draft-fetched list + manual fallback (F3);
   *  "input" = plain typeable input for vendors without a models endpoint
   *  (ElevenLabs, Cartesia, LMNT). `docsUrl` (input mode, owner decision
   *  2026-09-01): link to the provider's model docs shown under the input —
   *  the user copies the current model id from the provider's own page; no
   *  static catalogs in code (TPE-9a owner rule). */
  model?: {
    mode: "fetch" | "input";
    /** Config key: "model" everywhere except the native vendors ("modelId"). */
    key: "model" | "modelId";
    labelKey: TtsI18nKey;
    docsUrl?: string;
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
      model: {
        mode: "input",
        key: "modelId",
        labelKey: "tts_field_model_id",
        docsUrl: "https://elevenlabs.io/docs/models",
      },
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
      // Manual input (TPE-9a owner rule): Cartesia serves no public models
      // endpoint (its llms.txt API index has no /models route; the docs'
      // models page sits behind auth) — no static catalog, the docs link
      // under the input is the discovery path; preset value is the default.
      model: {
        mode: "input",
        key: "modelId",
        labelKey: "tts_field_model_id",
        docsUrl: "https://docs.cartesia.ai/build-with-cartesia/tts-models",
      },
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
      // Live discovery (TPE-9a): listModels() fetches GET /llm/v1alpha/models
      // and keeps entries whose spec.outputModalities include "audio".
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
  lmnt: {
    connection: {
      apiKey: { placeholder: "LMNT API key" },
      // Manual input (TPE-9a owner rule): LMNT documents no models endpoint
      // (its llms.txt index: speech/sessions/voices/accounts only) — no
      // static catalog, the docs link under the input is the discovery
      // path; preset value (blizzard) is the default.
      model: {
        mode: "input",
        key: "modelId",
        labelKey: "tts_field_model_id",
        docsUrl: "https://docs.lmnt.com/models/overview",
      },
    },
    tuning: [
      // LMNT has no speed knob — its tuning surface is top_p (stability,
      // documented range [0,1], default 0.8) and temperature
      // (expressiveness, docs bound it only below at 0, default 1; the
      // max 2 here is a UI handrail over the docs' own 0.3–1.0 examples).
      { kind: "number", key: "topP", labelKey: "tts_field_top_p", min: 0, max: 1, step: 0.05, fallback: 0.8 },
      { kind: "number", key: "temperature", labelKey: "tts_field_temperature", min: 0, max: 2, step: 0.05, fallback: 1 },
    ],
    localHelpers: false,
  },
  minimax: {
    connection: {
      apiKey: { placeholder: "MiniMax API key" },
      // Live discovery (TPE-9a): listModels() fetches the documented
      // GET /v1/models and keeps the speech-* family.
      model: { mode: "fetch", key: "modelId", labelKey: "tts_field_model" },
    },
    tuning: [
      // voice_setting.speed — documented range [0.5, 2]. vol/pitch exist
      // too but stay unexposed in v1 (logged simplification).
      { kind: "number", key: "speed", labelKey: "tts_field_speed", min: 0.5, max: 2, step: 0.05, fallback: 1 },
    ],
    localHelpers: false,
  },
  volcengine: {
    connection: {
      // Non-secret console id (X-Api-App-Id) — config-bag owned; the
      // SECRET half (X-Api-Access-Key) is the regular masked key field.
      appId: { placeholder: "1234567890" },
      apiKey: { placeholder: "Access Key (X-Api-Access-Key)" },
      // Manual input (TPE-9a owner rule): the resource id doubles as the
      // model — seed-tts-2.0 / seed-tts-1.0(-concurr) for stock voices,
      // seed-icl-1.0/2.0 for cloned ones. No list endpoint exists (the
      // console ListSpeakers APIs are IAM-signed, not synthesis creds),
      // so the docs link (the resource-id table on the API page) is the
      // discovery path — never a static catalog.
      model: {
        mode: "input",
        key: "modelId",
        labelKey: "tts_field_resource_id",
        docsUrl: "https://www.volcengine.com/docs/6561/1598757",
      },
    },
    tuning: [
      // audio_params.speech_rate — documented range [-50, 100] (100 = 2x).
      { kind: "number", key: "speechRate", labelKey: "tts_field_speech_rate", min: -50, max: 100, step: 5, fallback: 0 },
      // additions.post_process.pitch — documented range [-12, 12].
      { kind: "number", key: "pitch", labelKey: "tts_field_pitch", min: -12, max: 12, step: 1, fallback: 0 },
      // audio_params.emotion — a PER-VOICE enum (the docs voice-roster
      // page owns the values), so it is free text, not a select: an
      // option list here would be a hardcoded catalog (owner rule).
      { kind: "text", key: "emotion", labelKey: "tts_field_emotion", placeholderKey: "tts_field_emotion_volcengine_placeholder" },
      // audio_params.emotion_scale — documented range [1, 5], default 4.
      { kind: "number", key: "emotionScale", labelKey: "tts_field_emotion_scale", min: 1, max: 5, step: 1, fallback: 4 },
    ],
    localHelpers: false,
  },
  deepgram: {
    connection: {
      apiKey: { placeholder: "Deepgram API key" },
      // NO model field on purpose: the aura model id IS the voice id
      // (`[family]-[voicename]-[lang]`), so the live voice picker (fed by
      // /v1/models) is the single selector — a second field would
      // duplicate it.
    },
    tuning: [
      // REST `speed` query param — documented range 0.7..1.5, default 1.
      { kind: "number", key: "speed", labelKey: "tts_field_speed", min: 0.7, max: 1.5, step: 0.05, fallback: 1 },
    ],
    localHelpers: false,
  },
  azure: {
    connection: {
      apiKey: { placeholder: "Azure Speech resource key" },
      region: {
        placeholder: "westus",
        // The docs' region table (which endpoint serves which region) —
        // the discovery path for the region value.
        docsUrl: "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech",
      },
      // NO model field: the voice id IS the model id (ShortName like
      // en-US-JennyNeural) — the live voice picker is the single selector.
    },
    tuning: [
      // SSML prosody trio (documented relative forms); each is omitted
      // from the SSML entirely when unset.
      { kind: "number", key: "ratePercent", labelKey: "tts_field_rate", min: -50, max: 100, step: 5, fallback: 0 },
      { kind: "number", key: "pitchSt", labelKey: "tts_field_pitch", min: -12, max: 12, step: 1, fallback: 0 },
      { kind: "number", key: "volumePercent", labelKey: "tts_field_volume", min: -100, max: 100, step: 5, fallback: 0 },
    ],
    localHelpers: false,
  },
  polly: {
    connection: {
      apiKey: { placeholder: "Secret Access Key" },
      accessKeyId: { placeholder: "AKIA..." },
      region: {
        placeholder: "us-east-1",
        // The AWS endpoints table (which regions serve Polly) — the
        // discovery path for the region value.
        docsUrl: "https://docs.aws.amazon.com/general/latest/gr/pol.html",
      },
      // NO model field: the voice id IS the VoiceId (Joanna etc.) — the
      // live voice picker (DescribeVoices) is the voice selector; the
      // engine select below is the documented 4-value enum, not a model.
    },
    tuning: [
      {
        kind: "select",
        key: "engine",
        labelKey: "tts_field_engine",
        // The documented Engine enum; default standard is the server
        // default (SynthesizeSpeech) — neural-only voices carry an engines
        // marker in their label so mismatches are visible before probing.
        options: ["standard", "neural", "long-form", "generative"].map((e) => ({ id: e, label: e })),
        fallback: "standard",
        testid: "tts-field-engine",
      },
      // SSML prosody rate — ABSOLUTE % with the documented range 20–200
      // (100 = no change → attribute omitted at the fallback). Pitch is
      // NOT offered: neural/long-form/generative voices reject it.
      { kind: "number", key: "ratePercent", labelKey: "tts_field_rate", min: 20, max: 200, step: 5, fallback: 100 },
      // SSML prosody volume — relative ±ndB (0 = omitted).
      { kind: "number", key: "volumeDb", labelKey: "tts_field_volume", min: -12, max: 12, step: 1, fallback: 0 },
    ],
    localHelpers: false,
  },
  "google-cloud": {
    connection: {
      // The secret IS the service-account JSON file (client_email +
      // private_key) — pasted whole into the typed apiKey column (owner
      // decision 2026-09-02: SQL column, never a JSON-blob config slot).
      apiKey: {
        placeholder: "{ \"type\": \"service_account\", \"client_email\": … } — paste the whole JSON file",
        multiline: true,
        // The credential how-to under the field (house manual-input
        // pattern): creating a service-account key.
        docsUrl: "https://cloud.google.com/iam/docs/keys-create-delete",
      },
      // NO model/region/engine field: the voice id IS the voice name
      // (engine family included, e.g. en-US-Neural2-F) — the live voice
      // picker is the single selector.
    },
    tuning: [
      // audioConfig.speakingRate — documented multiplier range 0.25–2.0
      // (1.0 = native speed → omitted at the fallback).
      { kind: "number", key: "speakingRate", labelKey: "tts_field_speed", min: 0.25, max: 2, step: 0.05, fallback: 1 },
      // audioConfig.pitch — semitones within the documented ±20.
      { kind: "number", key: "pitchSt", labelKey: "tts_field_pitch", min: -20, max: 20, step: 1, fallback: 0 },
      // audioConfig.volumeGainDb — dB within the documented [−96, 16]
      // (UI window ±16: the docs themselves advise not exceeding +10;
      // server-side clamps still cover the full range).
      { kind: "number", key: "volumeGainDb", labelKey: "tts_field_volume", min: -16, max: 16, step: 1, fallback: 0 },
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
  if (backend === TTS_BACKEND.Lmnt) return "lmnt";
  if (backend === TTS_BACKEND.MiniMax) return "minimax";
  if (backend === TTS_BACKEND.Volcengine) return "volcengine";
  if (backend === TTS_BACKEND.Deepgram) return "deepgram";
  if (backend === TTS_BACKEND.Azure) return "azure";
  if (backend === TTS_BACKEND.Polly) return "polly";
  if (backend === TTS_BACKEND.GoogleCloud) return "google-cloud";
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
  if (backend === TTS_BACKEND.Gemini || backend === TTS_BACKEND.ElevenLabs || backend === TTS_BACKEND.Cartesia || backend === TTS_BACKEND.Inworld || backend === TTS_BACKEND.Lmnt || backend === TTS_BACKEND.MiniMax || backend === TTS_BACKEND.Volcengine || backend === TTS_BACKEND.Deepgram || backend === TTS_BACKEND.Azure || backend === TTS_BACKEND.Polly || backend === TTS_BACKEND.GoogleCloud) return "cloud";
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
    case "lmnt":
      return TTS_BACKEND.Lmnt;
    case "minimax":
      return TTS_BACKEND.MiniMax;
    case "volcengine":
      return TTS_BACKEND.Volcengine;
    case "deepgram":
      return TTS_BACKEND.Deepgram;
    case "azure":
      return TTS_BACKEND.Azure;
    case "polly":
      return TTS_BACKEND.Polly;
    case "google-cloud":
      return TTS_BACKEND.GoogleCloud;
  }
}
