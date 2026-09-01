import { z } from 'zod';

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/** Backend discriminators for the v1 STT roster (domain `STT_BACKENDS`) —
 *  in-browser Whisper (transformers.js, the zero-setup default) and one
 *  OpenAI-compatible `/v1/audio/transcriptions` adapter (cloud or local
 *  server). Further native adapters (Deepgram, Mistral, xAI, ...) are a
 *  separate post-base decision — extend this enum when they land. */
export const sttBackendSchema = z.enum(['openai-compat', 'whisper-browser']);
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
  /** Model slug ("whisper-1", "gpt-4o-transcribe", ...). */
  model: z.string().min(1),
  /** Optional language hint (BCP-47-ish). */
  language: z.string().optional(),
});
export type SttOpenAiCompatConfigValue = z.infer<typeof sttOpenAiCompatConfigSchema>;

export const sttWhisperBrowserConfigSchema = z.object({
  /** transformers.js model id ("Xenova/whisper-small", ...). */
  model: z.string().min(1),
  /** Optional language hint (BCP-47-ish). */
  language: z.string().optional(),
});
export type SttWhisperBrowserConfigValue = z.infer<typeof sttWhisperBrowserConfigSchema>;

export const sttProfileConfigSchema = z.union([sttOpenAiCompatConfigSchema, sttWhisperBrowserConfigSchema]);
export type SttProfileConfigValue = z.infer<typeof sttProfileConfigSchema>;

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