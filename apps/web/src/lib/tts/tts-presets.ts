/**
 * Cloud TTS preset registry — fork of `apps/web/src/provider-presets.ts` shape
 * and helper signatures (TE2-1, TTS Editor V2).
 *
 * Source helpers mirrored: `getPresetGroup` / `getVisibleProviderPresets` /
 * `getVisiblePresetGroups` → TTS analogs keep the same call signatures so the
 * upcoming `TtsProviderForm` fork retypes mechanically (import path change only).
 */

export type TtsBackend = "openai-compat" | "gemini" | "elevenlabs" | "cartesia" | "inworld" | "lmnt" | "minimax";
/** TPE-9a (owner rule 2026-09-01): static catalogs are gone — the
 *  retired `documented`/`name-heuristic` stamps no longer exist. Stamps
 *  that remain describe a LIVE server-side filter: `modality`
 *  (OpenRouter ?output_modalities=speech), `audio-models` (NanoGPT
 *  /audio-models + capability flag), `audio-type` (SiliconFlow
 *  ?type=audio); known-host criteria (openai/groq) and unknown custom
 *  servers resolve server-side — preset glue optional. */
export type TtsModelFilter = "modality" | "audio-models" | "audio-type" | "none";
export interface TtsPreset {
  id: string;
  label: string;
  group: "cloud";
  backend: TtsBackend;
  baseUrl?: string;
  modelFilter?: TtsModelFilter;
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
    // Live discovery (TPE-9a owner rule): the live /models catalog,
    // server-side filtered to the TTS family (their TTS guide naming —
    // every id of the family carries "tts"); no static list in code.
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
    // Live discovery (TPE-9a owner rule): the live /models catalog,
    // server-side filtered to the orpheus family (their TTS page naming;
    // playai retired). The models array below is quickstart glue only,
    // not a discovery source.
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
    // Live discovery (TPE-9a owner rule): the plain live /models catalog
    // as-is — EH's TTS roster mixes unrelated families with no unifying
    // criterion, so nothing is filtered; voice ids are manual input
    // (EH documents partial rosters only, no voices endpoint).
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
  {
    id: "minimax",
    label: "MiniMax",
    group: "cloud",
    backend: "minimax",
    // Static documented catalog via listModels() — the t2a page's model
    // enum (speech-2.8/2.6/02/01, hd + turbo).
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
