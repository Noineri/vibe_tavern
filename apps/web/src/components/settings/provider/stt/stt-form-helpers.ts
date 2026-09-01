/**
 * Shared form-field helpers for the STT profile editor surfaces
 * (STT_PLAN ST-4a). Fork of `tts-form-helpers.ts` trimmed to what the STT
 * editor needs: config reads/writes through the SAME path every input uses
 * (no draft-endpoint helpers — the STT tab has no draft transcribe/voices
 * routes; the test button works on saved profiles only, per ST-5b scope).
 */

import type { useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

export function updateConfigField(
  hook: Pick<SttHook, "setForm">,
  form: NonNullable<SttHook["form"]>,
  key: string,
  value: unknown,
): void {
  const next = { ...form.config };
  if (value === undefined || value === null || (typeof value === "string" && value === "")) {
    delete next[key];
  } else {
    next[key] = value;
  }
  hook.setForm({ config: next });
}

/** Reads an optional string/number config key with a display fallback. The
 *  `typeof` guard narrows `unknown` — no casts needed. */
export function configString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}