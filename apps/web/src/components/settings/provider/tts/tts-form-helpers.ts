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

/** Transient config for the DRAFT endpoints (TE2-16): the form's typed
 *  `apiKey` rides INTO the request config — one transient request, never
 *  persisted. The stored bag never carries the key (typed column), so this
 *  is the ONLY place a typed form key meets a config shape. An empty key
 *  returns the bag untouched, letting the server resolve the stored one via
 *  `profileId` when the identity matches. */
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

/** Mirrors the server-side endpoint normalization in
 *  `services/api/src/api/adapters/tts-adapter.ts` (normalizeEndpoint): trim,
 *  https:// prefix for scheme-less input, trailing slashes stripped,
 *  lowercased. Kept in lockstep so the client-side draft hint (D21) matches
 *  exactly what the server will auto-resolve on synthesis. */
export function normalizeTtsEndpoint(raw: string): string {
	let value = raw.trim();
	if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
	return value.replace(/\/+$/, "").toLowerCase();
}

/** Minimal wire shape the auto-key matcher needs (D21): the client-side
 *  projection of a provider profile — `hasStoredApiKey` stands in for the
 *  server's `apiKey` presence check without leaking the secret. */
export interface AutoKeyProviderCandidate {
	endpoint: string;
	hasStoredApiKey: boolean;
	name: string;
}

/** Client-side mirror of the server's autoMatchProviderKey (owner decision
 *  2026-08-28, D21 follow-up): the FIRST key-bearing provider (list order)
 *  whose endpoint matches wins. Pure — the hook feeds it the wire provider
 *  list, the editor feeds it the live draft form. */
export function matchAutoKeyProviderName(
	endpoint: string | null | undefined,
	providers: AutoKeyProviderCandidate[],
): string | null {
	const raw = typeof endpoint === "string" ? endpoint.trim() : "";
	if (raw === "") return null;
	const target = normalizeTtsEndpoint(raw);
	for (const provider of providers) {
		if (!provider.hasStoredApiKey) continue;
		if (normalizeTtsEndpoint(provider.endpoint) === target) return provider.name;
	}
	return null;
}
