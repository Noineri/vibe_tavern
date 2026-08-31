/**
 * Cloud TTS preset registry — fork of `apps/web/src/provider-presets.ts` shape
 * and helper signatures (TE2-1, TTS Editor V2).
 *
 * Source helpers mirrored: `getPresetGroup` / `getVisibleProviderPresets` /
 * `getVisiblePresetGroups` → TTS analogs keep the same call signatures so the
 * upcoming `TtsProviderForm` fork retypes mechanically (import path change only).
 */

export type TtsBackend = "openai-compat" | "gemini" | "elevenlabs" | "cartesia" | "inworld" | "lmnt";
/** F8 (owner decision 2026-08-29): `name-heuristic` is REMOVED. Known
 *  presets stamp `documented` (doc-verified static catalog resolved
 *  server-side) or `audio-type` (SiliconFlow ?type=audio); unknown
 *  custom servers stay `none` → plain /models. */
export type TtsModelFilter = "modality" | "audio-models" | "audio-type" | "documented" | "none";
export interface TtsPreset {
  id: string;
  label: string;
  group: "cloud";
  backend: TtsBackend;
  baseUrl?: string;
  modelFilter: TtsModelFilter;
  models?: string[];
  defaultModel?: string;
}

export const TTS_PRESET_GROUPS: Array<{ id: "cloud"; label: string }> = [
  { id: "cloud", label: "Cloud" },
];

export const TTS_PRESETS: TtsPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    // F8: documented catalog — server-side static table (models + 13/13/9
    // voice rosters incl. marin/cedar), no network discovery needed.
    modelFilter: "documented",
    defaultModel: "gpt-4o-mini-tts",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    // adds ?output_modalities=speech to the models request
    modelFilter: "modality",
  },
  {
    id: "groq",
    label: "Groq",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    // F8: documented catalog — orpheus EN/AR models + 6+6 voice rosters
    // resolved server-side; playai is retired.
    modelFilter: "documented",
    models: ["canopylabs/orpheus-v1-english", "canopylabs/orpheus-arabic-saudi"],
    // input hard limit 200 characters (chunking implication for TE2-6); response_format supports wav only
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://api.siliconflow.cn/v1",
    // F8: documented server-side filter — GET /models?type=audio (the
    // plain catalog is chat+image+audio mixed with no usable split).
    modelFilter: "audio-type",
    models: ["fishaudio/fish-speech-1.5", "FunAudioLLM/CosyVoice2-0.5B"],
    // speed range [0.25, 4.0], gain range [-10, 10] are supported by the endpoint
    // wire ids are FULL "model:voice" strings for the default model
  },
  {
    id: "nanogpt",
    label: "NanoGPT",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://nano-gpt.com/api/v1",
    // D23: NanoGPT serves TTS discovery from GET /audio-models (docs:
    // /api-reference/endpoint/audio-models) — the plain /models catalog is
    // chat-only slim and silently ignores output_modalities.
    modelFilter: "audio-models",
  },
  {
    id: "electronhub",
    label: "ElectronHub",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://api.electronhub.ai/v1",
    // F8: documented catalog — 10 TTS models; voice rosters only for the
    // openai-family trio, manual input otherwise (docs publish partial
    // rosters for the rest).
    modelFilter: "documented",
  },
  {
    id: "gemini",
    label: "Gemini",
    group: "cloud",
    backend: "gemini",
    modelFilter: "none",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    group: "cloud",
    backend: "elevenlabs",
    modelFilter: "none",
  },
  {
    id: "cartesia",
    label: "Cartesia",
    group: "cloud",
    backend: "cartesia",
    // Native backend with a static documented model catalog served by
    // listModels() (no network discovery — mirrors the F8 "documented"
    // philosophy); the model picker's fetch mode resolves through the draft
    // models route.
    modelFilter: "none",
  },
  {
    id: "inworld",
    label: "Inworld",
    group: "cloud",
    backend: "inworld",
    // Same as Cartesia: static documented model catalog via listModels()
    // (Inworld's only list-models endpoint serves LLM-router models).
    modelFilter: "none",
  },
  {
    id: "lmnt",
    label: "LMNT",
    group: "cloud",
    backend: "lmnt",
    // Static documented catalog via listModels() — the live speech page's
    // model enum is the source (exactly `blizzard`; aurora is a retired
    // server-side alias, not offered).
    modelFilter: "none",
  },
];

// ---- Helpers — same signatures as provider-presets.ts analogs ----

export function getTtsPresetGroup(presetId: string): string | null {
  return TTS_PRESETS.find((p) => p.id === presetId)?.group ?? null;
}

export function getVisibleTtsPresets(_isArmServer?: boolean): TtsPreset[] {
  return [...TTS_PRESETS];
}

export function getVisibleTtsPresetGroups(_isArmServer?: boolean): Array<{ id: string; label: string }> {
  return [...TTS_PRESET_GROUPS];
}

// Aliases matching the exact provider-presets helper names so the
// TtsProviderForm fork diff stays minimal (import path change only).

export function getPresetGroup(presetId: string): string | null {
  return getTtsPresetGroup(presetId);
}

export function getVisibleProviderPresets(isArmServer?: boolean): TtsPreset[] {
  return getVisibleTtsPresets(isArmServer);
}

export function getVisiblePresetGroups(isArmServer?: boolean): Array<{ id: string; label: string }> {
  return getVisibleTtsPresetGroups(isArmServer);
}
