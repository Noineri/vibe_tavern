import { z } from 'zod';

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/** Backend discriminators for the v1 STT roster (domain `STT_BACKENDS`) —
 *  in-browser Whisper (transformers.js, the zero-setup default) and one
 *  OpenAI-compatible `/v1/audio/transcriptions` adapter (cloud or local
 *  server). Further native adapters (Deepgram, Mistral, xAI, ...) are a
 *  separate post-base decision — extend this enum when they land. */
export const sttBackendSchema = z.enum(['openai-compat', 'whisper-browser', 'gemini']);
export type SttBackendValue = z.infer<typeof sttBackendSchema>;

// ─── Profile shape ────────────────────────────────────────────────────────────

/**
 * The backend-specific config — a union of the two v1 shapes (domain
 * `SttProfileConfig`), the profile's `backend` field being the discriminator.
 * Union member order matters: the openai-compat shape (which REQUIRES
 * `endpoint`) is tried first, so a config without an endpoint falls through
 * to the whisper-browser shape. Carries NO secret — the apiKey lives in the
 * typed `api_key` column and is write-only across the API (ST-1; the TE2-16
 * key rule applied to STT, same as TTS profiles).
 */
export const sttOpenAiCompatConfigSchema = z.object({
  /** Base URL of an OpenAI-compatible `/v1/audio/transcriptions` endpoint. */
  endpoint: z.string().min(1),
  /** Model slug ("whisper-1", "gpt-4o-transcribe", ...). P8 (2026-09-04):
   *  optional — the model lives in the LEVEL-2 outer settings (fetched
   *  picker), so a fresh connection card saves without one and the backend
   *  factory defaults it ("whisper-1") until the picker settles a pick. */
  model: z.string().min(1).optional(),
  /** Optional language hint (BCP-47-ish). */
  language: z.string().optional(),
});
export type SttOpenAiCompatConfigValue = z.infer<typeof sttOpenAiCompatConfigSchema>;

export const sttWhisperBrowserConfigSchema = z.object({
  /** transformers.js model id ("Xenova/whisper-small", ...). The browser
   *  tier always carries one — the form stamps the roster default on every
   *  backend switch — so it stays required in practice; optional here only
   *  to mirror the domain union after P8. */
  model: z.string().min(1).optional(),
  /** Optional language hint (BCP-47-ish). */
  language: z.string().optional(),
});
export type SttWhisperBrowserConfigValue = z.infer<typeof sttWhisperBrowserConfigSchema>;

export const sttProfileConfigSchema = z.union([sttOpenAiCompatConfigSchema, sttWhisperBrowserConfigSchema]);
export type SttProfileConfigValue = z.infer<typeof sttProfileConfigSchema>;

// NOTE (ST-7): the Gemini config arm is structurally identical to the
// whisper-browser arm above (`{ model, language? }` — the endpoint is a fixed
// Gemini API constant), so it has no separate schema member: the whisper
// shape IS its validation, exactly as in the domain union.

/** One entry of the live STT model catalog (P8) — the wire twin of the
 *  backend `SttModelInfo`: OpenAI-compatible `/models` payloads carry
 *  aggregator enrichment (`isFree`, `description`); the Gemini catalogue
 *  maps `models/<id>` names to bare ids. */
export const sttModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  isFree: z.boolean().optional(),
  description: z.string().optional(),
});
export type SttModelInfoValue = z.infer<typeof sttModelInfoSchema>;

/** Body of `POST /api/stt/draft/models` (P8) — the STT twin of
 *  `draftTtsModelsSchema`: a TRANSIENT draft request over the CURRENT form
 *  config (saved or not); `profileId` lets the server inject the stored
 *  typed-column key when the form's own key is empty and the identity
 *  matches (same semantics as the TTS draft endpoints). */
export const draftSttModelsSchema = z.object({
  backend: sttBackendSchema,
  /** Loose record (the TTS draft twin): the transient request feeds the
   *  backend factory's loose bag directly, and the form's just-typed key
   *  rides INSIDE it (formDraftConfig) — a strict parse would strip the
   *  secret before the factory ever sees it. */
  config: z.record(z.string(), z.unknown()),
  profileId: z.string().optional(),
});
export type DraftSttModelsInput = z.infer<typeof draftSttModelsSchema>;

/** Full STT profile as served by the API — SECURITY PROJECTION of the
 *  stored domain row: the secret lives in the typed `api_key` column (ST-1),
 *  never inside `config`, and is reported as the boolean `hasStoredApiKey`
 *  (same wire contract as `ClientProviderProfileRecord` and TTS profiles).
 *  The key never crosses the boundary on a read; writes carry it as the
 *  top-level write-only `apiKey` field (`undefined` = keep, `""` = clear,
 *  non-empty = set — see the update schema). */
export const sttProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  backend: sttBackendSchema,
  config: sttProfileConfigSchema,
  /** True when the typed api_key column holds a non-empty key. */
  hasStoredApiKey: z.boolean(),
  /** ST-7 capability seam — true when the backend annotates tone/emotion
   *  into the transcript (v1 pure-ASR backends force it off). */
  emotionAnnotation: z.boolean(),
  /** The fallback pointer (mirrors tts_profiles.isDefault) — at most one
   *  profile, store-maintained. */
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SttProfileValue = z.infer<typeof sttProfileSchema>;

// ─── Create / update ─────────────────────────────────────────────────────────

export const createSttProfileSchema = z.object({
  /** Human-readable profile name ("Whisper — small"). */
  name: z.string().min(1),
  /** Backend discriminator (see {@link sttBackendSchema}). */
  backend: sttBackendSchema,
  /** Backend-specific config. Carries NO secret — an `apiKey` inside it is
   *  stripped server-side (ST-1); send the top-level write-only field
   *  instead. */
  config: sttProfileConfigSchema,
  /** Write-only API key (ST-1): non-empty = set, empty/absent = none.
   *  Never returned by a read (see `hasStoredApiKey`). */
  apiKey: z.string().optional(),
  /** ST-7 capability seam toggle (`emotionAnnotation`). */
  emotionAnnotation: z.boolean().optional().default(false),
  /** Claim the fallback pointer (store clears others). */
  isDefault: z.boolean().optional().default(false),
});
export type CreateSttProfileInput = z.infer<typeof createSttProfileSchema>;

export const updateSttProfileSchema = z.object({
  name: z.string().min(1).optional(),
  backend: sttBackendSchema.optional(),
  config: sttProfileConfigSchema.optional(),
  /** Write-only tri-state (ST-1): `undefined` = keep the stored key,
   *  `""` = clear it, non-empty = replace it. */
  apiKey: z.string().optional(),
  emotionAnnotation: z.boolean().optional(),
  /** `true` moves the fallback pointer (store clears others); `false` just
   *  unsets this row without auto-promoting another. */
  isDefault: z.boolean().optional(),
});
export type UpdateSttProfileInput = z.infer<typeof updateSttProfileSchema>;