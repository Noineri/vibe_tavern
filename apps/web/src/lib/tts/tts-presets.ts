/**
 * Cloud TTS preset registry — fork of `apps/web/src/provider-presets.ts` shape
 * and helper signatures (TE2-1, TTS Editor V2).
 *
 * Source helpers mirrored: `getPresetGroup` / `getVisibleProviderPresets` /
 * `getVisiblePresetGroups` → TTS analogs keep the same call signatures so the
 * upcoming `TtsProviderForm` fork retypes mechanically (import path change only).
 */

export type TtsBackend = "openai-compat" | "gemini" | "elevenlabs";
export type TtsModelFilter = "modality" | "name-heuristic" | "none";
export type TtsVoiceMode = "static" | "fetch" | "manual";

export interface TtsStaticVoice {
  id: string;
  label: string;
  gender: "female" | "male";
  model?: string;
}

export interface TtsPreset {
  id: string;
  label: string;
  group: "cloud";
  backend: TtsBackend;
  baseUrl?: string;
  modelFilter: TtsModelFilter;
  voiceMode: TtsVoiceMode;
  models?: string[];
  defaultModel?: string;
  staticVoices?: TtsStaticVoice[];
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
    modelFilter: "name-heuristic",
    voiceMode: "static",
    defaultModel: "gpt-4o-mini-tts",
    // ballad and verse exist only on gpt-4o-mini-tts; the classic 9 are the tts-1 set
    staticVoices: [
      { id: "alloy", label: "Alloy", gender: "female" },
      { id: "ash", label: "Ash", gender: "male" },
      { id: "ballad", label: "Ballad", gender: "female" },
      { id: "coral", label: "Coral", gender: "female" },
      { id: "echo", label: "Echo", gender: "male" },
      { id: "fable", label: "Fable", gender: "female" },
      { id: "nova", label: "Nova", gender: "female" },
      { id: "onyx", label: "Onyx", gender: "male" },
      { id: "sage", label: "Sage", gender: "female" },
      { id: "shimmer", label: "Shimmer", gender: "female" },
      { id: "verse", label: "Verse", gender: "female" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    // adds ?output_modalities=speech to the models request
    modelFilter: "modality",
    voiceMode: "manual",
  },
  {
    id: "groq",
    label: "Groq",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    modelFilter: "name-heuristic",
    voiceMode: "static",
    models: ["canopylabs/orpheus-v1-english", "canopylabs/orpheus-arabic-saudi"],
    // input hard limit 200 characters (chunking implication for TE2-6); response_format supports wav only
    staticVoices: [
      { id: "autumn", label: "Autumn", gender: "female", model: "canopylabs/orpheus-v1-english" },
      { id: "diana", label: "Diana", gender: "female", model: "canopylabs/orpheus-v1-english" },
      { id: "hannah", label: "Hannah", gender: "female", model: "canopylabs/orpheus-v1-english" },
      { id: "austin", label: "Austin", gender: "male", model: "canopylabs/orpheus-v1-english" },
      { id: "daniel", label: "Daniel", gender: "male", model: "canopylabs/orpheus-v1-english" },
      { id: "troy", label: "Troy", gender: "male", model: "canopylabs/orpheus-v1-english" },
      { id: "abdullah", label: "Abdullah", gender: "male", model: "canopylabs/orpheus-arabic-saudi" },
      { id: "fahad", label: "Fahad", gender: "male", model: "canopylabs/orpheus-arabic-saudi" },
      { id: "sultan", label: "Sultan", gender: "male", model: "canopylabs/orpheus-arabic-saudi" },
      { id: "lulwa", label: "Lulwa", gender: "female", model: "canopylabs/orpheus-arabic-saudi" },
      { id: "noura", label: "Noura", gender: "female", model: "canopylabs/orpheus-arabic-saudi" },
      { id: "aisha", label: "Aisha", gender: "female", model: "canopylabs/orpheus-arabic-saudi" },
    ],
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://api.siliconflow.cn/v1",
    modelFilter: "name-heuristic",
    voiceMode: "static",
    models: ["fishaudio/fish-speech-1.5", "FunAudioLLM/CosyVoice2-0.5B"],
    // speed range [0.25, 4.0], gain range [-10, 10] are supported by the endpoint
    // wire ids are FULL "model:voice" strings for the default model
    staticVoices: [
      { id: "fishaudio/fish-speech-1.5:alex", label: "Steady male voice", gender: "male" },
      { id: "fishaudio/fish-speech-1.5:benjamin", label: "Deep male voice", gender: "male" },
      { id: "fishaudio/fish-speech-1.5:charles", label: "Magnetic male voice", gender: "male" },
      { id: "fishaudio/fish-speech-1.5:david", label: "Cheerful male voice", gender: "male" },
      { id: "fishaudio/fish-speech-1.5:anna", label: "Steady female voice", gender: "female" },
      { id: "fishaudio/fish-speech-1.5:bella", label: "Passionate female voice", gender: "female" },
      { id: "fishaudio/fish-speech-1.5:claire", label: "Gentle female voice", gender: "female" },
      { id: "fishaudio/fish-speech-1.5:diana", label: "Cheerful female voice", gender: "female" },
    ],
  },
  {
    id: "nanogpt",
    label: "NanoGPT",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://nano-gpt.com/api/v1",
    modelFilter: "name-heuristic",
    // auth header variant unverified — live probe pending
    voiceMode: "manual",
  },
  {
    id: "electronhub",
    label: "ElectronHub",
    group: "cloud",
    backend: "openai-compat",
    baseUrl: "https://api.electronhub.ai/v1",
    modelFilter: "name-heuristic",
    voiceMode: "manual",
  },
  {
    id: "gemini",
    label: "Gemini",
    group: "cloud",
    backend: "gemini",
    modelFilter: "none",
    voiceMode: "fetch",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    group: "cloud",
    backend: "elevenlabs",
    modelFilter: "none",
    voiceMode: "fetch",
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
