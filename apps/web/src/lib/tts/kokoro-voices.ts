/**
 * Hardcoded Kokoro-82M v1.0 voice manifest (54 voices, 8 languages).
 *
 * Source: hexgrad/Kokoro-82M VOICES.md (authoritative upstream roster).
 * Misaki lang codes: a=en-US, b=en-GB, j=ja, z=zh-CN, e=es, f=fr-FR, h=hi, i=it, p=pt-BR.
 * This is a static UI-side roster; TS-3b cross-checks it against the runtime
 * kokoro-js `list_voices()` at integration time.
 */

import { KokoroVoiceNotFoundError } from "./kokoro/kokoro-errors.js";

export const KOKORO_LANGS = {
  a: { tag: "en-US", label: "American English" },
  b: { tag: "en-GB", label: "British English" },
  j: { tag: "ja", label: "Japanese" },
  z: { tag: "zh-CN", label: "Mandarin Chinese" },
  e: { tag: "es", label: "Spanish" },
  f: { tag: "fr-FR", label: "French" },
  h: { tag: "hi", label: "Hindi" },
  i: { tag: "it", label: "Italian" },
  p: { tag: "pt-BR", label: "Brazilian Portuguese" },
} as const;

export type KokoroLangCode = keyof typeof KOKORO_LANGS;

export interface KokoroVoiceInfo {
  id: string;
  lang: KokoroLangCode;
  gender: "female" | "male";
  grade: string | null;
}

export const KOKORO_VOICES: readonly KokoroVoiceInfo[] = [
  // American English (a) — 11F 9M
  { id: "af_heart", lang: "a", gender: "female", grade: "A" },
  { id: "af_alloy", lang: "a", gender: "female", grade: "C" },
  { id: "af_aoede", lang: "a", gender: "female", grade: "C+" },
  { id: "af_bella", lang: "a", gender: "female", grade: "A-" },
  { id: "af_jessica", lang: "a", gender: "female", grade: "D" },
  { id: "af_kore", lang: "a", gender: "female", grade: "C+" },
  { id: "af_nicole", lang: "a", gender: "female", grade: "B-" },
  { id: "af_nova", lang: "a", gender: "female", grade: "C" },
  { id: "af_river", lang: "a", gender: "female", grade: "D" },
  { id: "af_sarah", lang: "a", gender: "female", grade: "C+" },
  { id: "af_sky", lang: "a", gender: "female", grade: "C-" },
  { id: "am_adam", lang: "a", gender: "male", grade: "F+" },
  { id: "am_echo", lang: "a", gender: "male", grade: "D" },
  { id: "am_eric", lang: "a", gender: "male", grade: "D" },
  { id: "am_fenrir", lang: "a", gender: "male", grade: "C+" },
  { id: "am_liam", lang: "a", gender: "male", grade: "D" },
  { id: "am_michael", lang: "a", gender: "male", grade: "C+" },
  { id: "am_onyx", lang: "a", gender: "male", grade: "D" },
  { id: "am_puck", lang: "a", gender: "male", grade: "C+" },
  { id: "am_santa", lang: "a", gender: "male", grade: "D-" },
  // British English (b) — 4F 4M
  { id: "bf_alice", lang: "b", gender: "female", grade: "D" },
  { id: "bf_emma", lang: "b", gender: "female", grade: "B-" },
  { id: "bf_isabella", lang: "b", gender: "female", grade: "C" },
  { id: "bf_lily", lang: "b", gender: "female", grade: "D" },
  { id: "bm_daniel", lang: "b", gender: "male", grade: "D" },
  { id: "bm_fable", lang: "b", gender: "male", grade: "C" },
  { id: "bm_george", lang: "b", gender: "male", grade: "C" },
  { id: "bm_lewis", lang: "b", gender: "male", grade: "D+" },
  // Japanese (j) — 4F 1M
  { id: "jf_alpha", lang: "j", gender: "female", grade: "C+" },
  { id: "jf_gongitsune", lang: "j", gender: "female", grade: "C" },
  { id: "jf_nezumi", lang: "j", gender: "female", grade: "C-" },
  { id: "jf_tebukuro", lang: "j", gender: "female", grade: "C" },
  { id: "jm_kumo", lang: "j", gender: "male", grade: "C-" },
  // Mandarin Chinese (z) — 4F 4M
  { id: "zf_xiaobei", lang: "z", gender: "female", grade: "D" },
  { id: "zf_xiaoni", lang: "z", gender: "female", grade: "D" },
  { id: "zf_xiaoxiao", lang: "z", gender: "female", grade: "D" },
  { id: "zf_xiaoyi", lang: "z", gender: "female", grade: "D" },
  { id: "zm_yunjian", lang: "z", gender: "male", grade: "D" },
  { id: "zm_yunxi", lang: "z", gender: "male", grade: "D" },
  { id: "zm_yunxia", lang: "z", gender: "male", grade: "D" },
  { id: "zm_yunyang", lang: "z", gender: "male", grade: "D" },
  // Spanish (e) — 1F 2M (no grades published)
  { id: "ef_dora", lang: "e", gender: "female", grade: null },
  { id: "em_alex", lang: "e", gender: "male", grade: null },
  { id: "em_santa", lang: "e", gender: "male", grade: null },
  // French (f) — 1F
  { id: "ff_siwis", lang: "f", gender: "female", grade: "B-" },
  // Hindi (h) — 2F 2M
  { id: "hf_alpha", lang: "h", gender: "female", grade: "C" },
  { id: "hf_beta", lang: "h", gender: "female", grade: "C" },
  { id: "hm_omega", lang: "h", gender: "male", grade: "C" },
  { id: "hm_psi", lang: "h", gender: "male", grade: "C" },
  // Italian (i) — 1F 1M
  { id: "if_sara", lang: "i", gender: "female", grade: "C" },
  { id: "im_nicola", lang: "i", gender: "male", grade: "C" },
  // Brazilian Portuguese (p) — 1F 2M (no grades published)
  { id: "pf_dora", lang: "p", gender: "female", grade: null },
  { id: "pm_alex", lang: "p", gender: "male", grade: null },
  { id: "pm_santa", lang: "p", gender: "male", grade: null },
] as const;

export const KOKORO_VOICES_BY_ID: ReadonlyMap<string, KokoroVoiceInfo> = new Map(
  KOKORO_VOICES.map((v) => [v.id, v]),
);

/**
 * List voices, optionally filtered by language. Returns a shallow copy in
 * stable manifest order.
 */
export function listKokoroVoices(lang?: KokoroLangCode): KokoroVoiceInfo[] {
  if (lang === undefined) return [...KOKORO_VOICES];
  return KOKORO_VOICES.filter((v) => v.lang === lang);
}

/**
 * Resolve a voice by id. Throws {@link KokoroVoiceNotFoundError} when the id
 * is unknown.
 */
export function resolveKokoroVoice(id: string): KokoroVoiceInfo {
  const voice = KOKORO_VOICES_BY_ID.get(id);
  if (!voice) throw new KokoroVoiceNotFoundError(id);
  return voice;
}

/** Try to resolve a voice by id; returns null when unknown. */
export function tryResolveKokoroVoice(id: string): KokoroVoiceInfo | null {
  return KOKORO_VOICES_BY_ID.get(id) ?? null;
}

/** i18n keys the picker label needs (only the English accents are shown in
 *  the UI — kokoro-js ships en voices only; other langs fall back to the
 *  upstream English label from the manifest). */
export type KokoroVoiceLabelKey =
  | "tts_voice_gender_female"
  | "tts_voice_gender_male"
  | "tts_voice_accent_a"
  | "tts_voice_accent_b";

const KOKORO_LANG_LABEL_KEYS: Partial<Record<KokoroLangCode, KokoroVoiceLabelKey>> = {
  a: "tts_voice_accent_a",
  b: "tts_voice_accent_b",
};

/**
 * Human-readable picker label for a voice: capitalized name (derived from
 * the id tail — `af_heart` → "Heart"), gender, accent, upstream quality
 * grade (skipped when unknown). Example: "Heart · Female · American · A".
 * Voice names are proper nouns and stay untranslated; `t` is injected by
 * the component layer (this module stays UI-framework-free).
 */
export function kokoroVoiceLabel(voice: KokoroVoiceInfo, t: (key: KokoroVoiceLabelKey) => string): string {
  const tail = voice.id.split("_")[1] ?? voice.id;
  const name = tail.charAt(0).toUpperCase() + tail.slice(1);
  const parts = [name, t(voice.gender === "female" ? "tts_voice_gender_female" : "tts_voice_gender_male")];
  const accentKey = KOKORO_LANG_LABEL_KEYS[voice.lang];
  parts.push(accentKey === undefined ? KOKORO_LANGS[voice.lang].label : t(accentKey));
  if (voice.grade !== null) parts.push(voice.grade);
  return parts.join(" · ");
}
