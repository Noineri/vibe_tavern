/**
 * Shared form-field helpers for the STT profile editor surfaces
 * (STT_PLAN ST-4a). Fork of `tts-form-helpers.ts` trimmed to what the STT
 * editor needs: config reads/writes through the SAME path every input uses
 * (no draft-endpoint helpers — the STT tab has no draft transcribe/voices
 * routes; the test button works on saved profiles only, per ST-5b scope).
 */

import { STT_BACKENDS, STT_PROVIDER_PRESETS, TTS_BACKEND, type SttBackendType } from "@vibe-tavern/domain";
import type { useSttProfiles } from "./use-stt-profiles.js";

/** Config-bag marker distinguishing the Local segment from cloud
 *  OpenAI-compatible rows (SPE-8 — the TTS `localServer` twin: the backend
 *  enum and the DB never change; the flag survives save/reopen). */
export const STT_LOCAL_SERVER_FLAG = "localServer";

/** The local-server endpoint suggestion (the old quickstart's faster-whisper
 *  default port, kept verbatim — the Local segment prefills it for editing). */
export const STT_LOCAL_PRESET_ENDPOINT = "http://127.0.0.1:8000/v1";

/** Top-level segments (SPE-8, owner directive 2026-09-05): the LLM-tab group
 *  taxonomy — Cloud (openai-compat transport rows), Native (own-wire backend
 *  rows), Local (localServer flag), Custom (bare openai-compatible),
 *  Browser (whisper tier). */
export type SttProviderSegment = "browser" | "cloud" | "native" | "local" | "custom";

/** Derive the segment from the wire state: browser tier → browser;
 *  localServer flag → local (authoritative, exactly like the TTS preset
 *  rule — a legacy localhost endpoint WITHOUT the flag stays custom until
 *  re-applied); non-compat backend → native; compat + endpoint-matched
 *  preset row → that row's group (cloud — the local row has an empty
 *  baseUrl and never matches); otherwise custom. */
export function sttProviderSegmentOf(
  backend: SttBackendType,
  config: Record<string, unknown>,
): SttProviderSegment {
  if (backend === STT_BACKENDS.WhisperBrowser) return "browser";
  if (config[STT_LOCAL_SERVER_FLAG] === true) return "local";
  if (backend !== STT_BACKENDS.OpenAiCompat) return "native";
  const endpoint = normalizeSttEndpoint(configString(config, "endpoint"));
  const match = STT_PROVIDER_PRESETS.find(
    (p) => p.backend === STT_BACKENDS.OpenAiCompat && p.baseUrl !== "" && normalizeSttEndpoint(p.baseUrl) === endpoint,
  );
  // The group rides the matched row (SttPresetGroup is a subset of
  // SttProviderSegment, so this typechecks directly): today only cloud
  // rows carry a fixed baseUrl, the local row never matches.
  if (match) return match.group;
  return "custom";
}

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

/** Fixed-host vendor table — mirror of the server VENDOR_HOST_BACKENDS
 *  (stt-adapter.ts, SPE-4..6): backend slug → vendor host + the same-vendor
 *  TTS backend for key reuse. Rule order mirrors the server: a keyful LLM
 *  provider on the vendor host wins, then a same-vendor stored-key TTS
 *  profile. NVIDIA has no TTS arm (undefined skips that step). */
const STT_VENDOR_HOSTS: ReadonlyArray<{
  backend: SttBackendType;
  host: string;
  ttsBackend?: typeof TTS_BACKEND[keyof typeof TTS_BACKEND];
}> = [
  { backend: STT_BACKENDS.Gemini, host: STT_GEMINI_API_HOST, ttsBackend: TTS_BACKEND.Gemini },
  { backend: STT_BACKENDS.Deepgram, host: "https://api.deepgram.com", ttsBackend: TTS_BACKEND.Deepgram },
  { backend: STT_BACKENDS.ElevenLabs, host: "https://api.elevenlabs.io", ttsBackend: TTS_BACKEND.ElevenLabs },
  { backend: STT_BACKENDS.Nvidia, host: "https://integrate.api.nvidia.com" },
];

/** Client-side mirror of the server HINT rule (decorateAutoKey in
 *  stt-adapter.ts — deliberately NOT the runtime autoMatchSttKey cascade):
 *  - fixed-host natives (gemini/deepgram/elevenlabs/nvidia): vendor match —
 *    the FIRST keyful LLM provider whose endpoint lives on the vendor's
 *    host, then a stored-key same-vendor TTS profile (except nvidia, which
 *    has none — see {@link STT_VENDOR_HOSTS});
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
  const vendor = STT_VENDOR_HOSTS.find((v) => v.backend === backend);
  if (vendor) {
    const provider = keyful.find((p) => normalizeSttEndpoint(p.endpoint).startsWith(vendor.host));
    if (provider) return provider.name;
    if (vendor.ttsBackend !== undefined) {
      const tts = ttsProfiles.find((p) => p.backend === vendor.ttsBackend && p.hasStoredApiKey);
      if (tts) return tts.name;
    }
    return null;
  }
  if (backend === STT_BACKENDS.OpenAiCompat) {
    const raw = typeof endpoint === "string" ? endpoint.trim() : "";
    if (raw === "") return null;
    const byEndpoint = new Map(keyful.map((p) => [normalizeSttEndpoint(p.endpoint), p.name]));
    return byEndpoint.get(normalizeSttEndpoint(raw)) ?? null;
  }
  return null;
}