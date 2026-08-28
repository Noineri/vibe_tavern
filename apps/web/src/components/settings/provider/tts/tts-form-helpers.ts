/**
 * Shared form-field helpers for the TTS profile editor surfaces
 * (TTS_PLAN TS-7c/TS-11b). Extracted from TtsProfileEditor so the local
 * server panel writes config through the SAME path the editor's inputs do,
 * without an Editor <-> Panel module cycle.
 */

import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

export function updateConfigField(
  tts: Pick<TtsHook, "setForm">,
  form: NonNullable<TtsHook["form"]>,
  key: string,
  value: unknown,
): void {
  const next = { ...form.config };
  if (value === undefined || value === null || (typeof value === "string" && value === "")) {
    delete next[key];
  } else {
    next[key] = value;
  }
  tts.setForm({ config: next });
}

/** Reads an optional string/number config key with a display fallback. The
 *  `typeof` guard narrows `unknown` — no casts needed. */
export function configString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}
