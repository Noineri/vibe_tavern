/**
 * Shared form-field helpers for the STT profile editor surfaces
 * (STT_PLAN ST-4a). Fork of `tts-form-helpers.ts` trimmed to what the STT
 * editor needs: config reads/writes through the SAME path every input uses
 * (no draft-endpoint helpers — the STT tab has no draft transcribe/voices
 * routes; the test button works on saved profiles only, per ST-5b scope).
 */

import { STT_BACKENDS, TTS_BACKEND, type SttBackendType } from "@vibe-tavern/domain";
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

/** TRANSIENT draft config for the model-catalog request (P8) — the STT twin
 *  of the TTS formDraftConfig: the form's just-typed key rides INSIDE the
 *  loose config for the /api/stt/draft/models call only (never stored, never
 *  saved — the create/update payload keeps the key on the write-only top
 *  level field). */
export function formDraftConfig(form: {
  config: Record<string, unknown>;
  apiKey: string;
}): Record<string, unknown> {
  const trimmed = form.apiKey.trim();
  if (trimmed === "") return form.config;
  return { ...form.config, apiKey: trimmed };
}

/** Reads an optional string/number config key with a display fallback. The
 *  `typeof` guard narrows `unknown` — no casts needed. */
export function configString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

// ─── Auto-key hint (draft, P2 — the STT port of the TTS D21/F4 pattern) ──────

/** LLM provider profile as seen by the client-side auto-key mirror — the
 *  hint-only projection of the wire record (no key material). */
export interface SttAutoKeyProviderCandidate {
  endpoint: string;
  hasStoredApiKey: boolean;
  name: string;
}

/** TTS profile as seen by the same mirror — the gemini fallback branch
 *  ("a saved Google TTS credential makes Google STT ready", ST-5b/ST-7). */
export interface SttAutoKeyTtsCandidate {
  backend: string;
  hasStoredApiKey: boolean;
  name: string;
}

/** Client-side mirror of the server normalizeEndpoint (stt-adapter.ts —
 *  kept local there, mirrored here exactly like tts-form-helpers does for
 *  the tts-adapter one): trim → default https:// scheme → strip trailing
 *  slashes → lowercase. */
export function normalizeSttEndpoint(raw: string): string {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "").toLowerCase();
}

/** Vendor host of the fixed Gemini API endpoint — mirror of the server
 *  GEMINI_API_HOST (stt-adapter.ts); the gemini backend carries NO endpoint
 *  field, so the host constant IS the match key. */
const STT_GEMINI_API_HOST = "https://generativelanguage.googleapis.com";

/** Client-side mirror of the server HINT rule (decorateAutoKey in
 *  stt-adapter.ts — deliberately NOT the runtime autoMatchSttKey cascade):
 *  - gemini: vendor match — the FIRST keyful LLM provider whose endpoint
 *    lives on the Gemini API host, then a stored-key gemini TTS profile.
 *  - openai-compat: exact endpoint match over keyful providers (a Map, so
 *    a duplicated normalized endpoint resolves to the LAST keyful one —
 *    exactly like the server's byEndpoint map).
 *  Pure: the hook feeds wire lists, the editor feeds the live draft form.
 *  The active-flag never participates — the server rule ignores it too. */
export function matchSttAutoKeyProviderName(
  backend: SttBackendType,
  endpoint: string,
  providers: SttAutoKeyProviderCandidate[],
  ttsProfiles: SttAutoKeyTtsCandidate[],
): string | null {
  const keyful = providers.filter((p) => p.hasStoredApiKey);
  if (backend === STT_BACKENDS.Gemini) {
    const geminiProvider = keyful.find((p) => normalizeSttEndpoint(p.endpoint).startsWith(STT_GEMINI_API_HOST));
    if (geminiProvider) return geminiProvider.name;
    const ttsGemini = ttsProfiles.find((p) => p.backend === TTS_BACKEND.Gemini && p.hasStoredApiKey);
    return ttsGemini?.name ?? null;
  }
  if (backend === STT_BACKENDS.OpenAiCompat) {
    const raw = typeof endpoint === "string" ? endpoint.trim() : "";
    if (raw === "") return null;
    const byEndpoint = new Map(keyful.map((p) => [normalizeSttEndpoint(p.endpoint), p.name]));
    return byEndpoint.get(normalizeSttEndpoint(raw)) ?? null;
  }
  return null;
}