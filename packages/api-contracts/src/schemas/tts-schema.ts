import { z } from "zod";

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/** Backend discriminators for the v1 TTS roster (domain `TTS_BACKEND`) —
 *  in-browser Kokoro, any OpenAI-compatible `/v1/audio/speech` endpoint,
 *  native Gemini TTS (Interactions API), native ElevenLabs. Further native
 *  adapters (MiniMax, Azure, proprietary local servers) are additive registry
 *  entries after v1 — extend this enum when they land. */
export const ttsBackendSchema = z.enum(["kokoro", "openai-compatible", "gemini", "elevenlabs", "cartesia"]);
export type TtsBackendValue = z.infer<typeof ttsBackendSchema>;

/** Voice-map binding targets for a TTS profile (domain `TTS_TARGET_TYPE`) —
 *  character and persona (the user's own voice); deliberately distinct from
 *  the regex/lorebook vocabularies (character + prompt preset). */
export const ttsTargetTypeSchema = z.enum(["character", "persona"]);
export type TtsTargetTypeValue = z.infer<typeof ttsTargetTypeSchema>;

// ─── Profile shape ────────────────────────────────────────────────────────────

/**
 * The backend-specific config bag. `unknown` values are correct at this
 * type-erased boundary — the real per-backend shapes (endpoint/apiKey/model/
 * sliders/style instructions) are owned by the backend registry contracts
 * (TS-2+) and validated there, so the shared CRUD contract only guarantees
 * JSON round-tripping.
 */
export const ttsProfileConfigSchema = z.record(z.string(), z.unknown());

/** Full TTS profile as served by the API — SECURITY PROJECTION of the
 *  stored domain row: the secret lives in the typed `api_key` column
 *  (TE2-16), never inside `config`, and is reported as the boolean
 *  `hasStoredApiKey` (same wire contract as `ClientProviderProfileRecord`).
 *  The key never crosses the boundary on a read; writes carry it as the
 *  top-level write-only `apiKey` field (`undefined` = keep, `""` = clear,
 *  non-empty = set — see the update schema). */
export const ttsProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  backend: ttsBackendSchema,
  config: ttsProfileConfigSchema,
  /** True when the typed api_key column holds a non-empty key. */
  hasStoredApiKey: z.boolean(),
  /** Optional providerProfiles.id link: key + baseUrl resolve server-side
   *  from the provider store at synthesis/test time (TE2-16) — the provider
   *  key never crosses the boundary either. Null = no link. */
  providerRef: z.string().nullable(),
  /** Name of the provider profile whose endpoint AUTO-MATCHES this profile
   *  (owner decision: default-on key reuse) — set when the profile has no
   *  own key and no explicit link; the UI uses it for the "key from «X»"
   *  hint. The provider KEY itself never crosses the boundary. */
  autoKeyProviderName: z.string().nullable(),
  voiceId: z.string(),
  narratorVoiceId: z.string().nullable(),
  lang: z.string(),
  sortOrder: z.number(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TtsProfileValue = z.infer<typeof ttsProfileSchema>;

// ─── Create / update ─────────────────────────────────────────────────────────

export const createTtsProfileSchema = z.object({
  /** Human-readable profile name ("Kokoro — Sarah"). */
  name: z.string().min(1),
  /** Backend discriminator (see {@link ttsBackendSchema}). */
  backend: ttsBackendSchema,
  /** Backend-specific config bag (validated by the registry, not here).
 *  Carries NO secret — an `apiKey`/`providerRef` inside it is stripped
 *  server-side (TE2-16); send the top-level write-only fields instead. */
  config: ttsProfileConfigSchema.optional().default({}),
  /** Write-only API key (TE2-16): non-empty = set, empty/absent = none.
  *  Never returned by a read (see `hasStoredApiKey`). */
  apiKey: z.string().optional(),
  /** Optional providerProfiles.id — server-side key + baseUrl resolution
   *  at synthesis/test time. Empty/absent = no link. */
  providerRef: z.string().optional(),
  /** Selected voice id; empty until the user picks one (editor gates
   *  "ready"/preview on a non-empty value). */
  voiceId: z.string().optional().default(""),
  /** Optional narrator voice id — null/empty keeps single-voice semantics. */
  narratorVoiceId: z.string().nullable().optional().default(null),
  /** Language hint (BCP-47-ish); English-first per owner decision. */
  lang: z.string().optional().default("en"),
  /** Deterministic order in the profile list. */
  sortOrder: z.number().optional().default(0),
  /** Claim the voice map's [Default Voice] pointer (store clears others). */
  isDefault: z.boolean().optional().default(false),
});
export type CreateTtsProfileInput = z.infer<typeof createTtsProfileSchema>;

export const updateTtsProfileSchema = z.object({
  name: z.string().min(1).optional(),
  backend: ttsBackendSchema.optional(),
  config: ttsProfileConfigSchema.optional(),
  /** Write-only tri-state (TE2-16): `undefined` = keep the stored key,
   *  `""` = clear it, non-empty = replace it. */
  apiKey: z.string().optional(),
  /** Tri-state link to a providerProfiles row: `undefined` = keep,
   *  `""` = clear, non-empty = set. */
  providerRef: z.string().optional(),
  voiceId: z.string().optional(),
  narratorVoiceId: z.string().nullable().optional(),
  lang: z.string().optional(),
  sortOrder: z.number().optional(),
  /** `true` moves the [Default Voice] pointer (store clears others); `false`
   *  just unsets this row without auto-promoting another. */
  isDefault: z.boolean().optional(),
});
export type UpdateTtsProfileInput = z.infer<typeof updateTtsProfileSchema>;

// ─── Links (voice map) ────────────────────────────────────────────────────────

/** Replace-all voice-map binding payload for a TTS profile (mirrors
 *  `setRegexLinksSchema` / ScriptStore link API). `mode` is optional with
 *  `voice` default — callers written before TS-9a-foundation stay valid. */
export const ttsLinkModeSchema = z.enum(['voice', 'disabled']);

export const setTtsLinksSchema = z.object({
  links: z.array(
    z.object({
      targetType: ttsTargetTypeSchema,
      targetId: z.string().min(1),
      mode: ttsLinkModeSchema.optional(),
    }),
  ),
});
export type SetTtsLinksInput = z.infer<typeof setTtsLinksSchema>;

export const generateTtsSchema = z.object({
  profileId: z.string().min(1),
  text: z.string().min(1),
  speed: z.number().optional(),
  instructions: z.string().optional(),
  voiceId: z.string().optional(),
});
export type GenerateTtsInput = z.infer<typeof generateTtsSchema>;

// ─── Draft (transient) check — unsaved form config ──────────────────────────

/** Voices for a backend config straight from the profile-editor form —
 *  no saved profile row involved. The config bag is validated by the
 *  backend registry factory exactly like a saved profile's config; the
 *  apiKey inside it is transient (used once for this request, never
 *  persisted or logged). Kokoro is rejected by the route (browser-only). */
export const draftTtsVoicesSchema = z.object({
  backend: ttsBackendSchema,
  config: ttsProfileConfigSchema,
  /** Saved-profile id for stored-key resolution: when the transient config
   *  carries NO apiKey and this id points at a stored profile with the SAME
   *  backend (and, for endpoint backends, the same endpoint), the server
   *  injects the stored typed-column key (or the linked provider's key —
   *  TE2-16 providerRef) for this one request — the LLM branch's test-draft
   *  pattern. Optional: a brand-new profile sends none. */
  profileId: z.string().optional(),
});
export type DraftTtsVoicesInput = z.infer<typeof draftTtsVoicesSchema>;

/** One short synthesis from an unsaved form config — the "Прослушать голос"
 *  path for server backends BEFORE saving (mirrors the LLM branch's
 *  test-draft pattern). Same transient-key semantics as
 *  {@link draftTtsVoicesSchema}. */
export const draftTtsPreviewSchema = z.object({
  backend: ttsBackendSchema,
  config: ttsProfileConfigSchema,
  /** Stored-key resolution — same semantics as in {@link draftTtsVoicesSchema}. */
  profileId: z.string().optional(),
  voiceId: z.string().optional().default(""),
  text: z.string().min(1),
  speed: z.number().optional(),
  instructions: z.string().optional(),
});
export type DraftTtsPreviewInput = z.infer<typeof draftTtsPreviewSchema>;

export const draftTtsModelsSchema = z.object({
  backend: ttsBackendSchema,
  config: ttsProfileConfigSchema,
  /** Optional filter hint computed client-side from the registry — the
   *  registry lives in `apps/web` so the server must not import it
   *  (dependency graph points the other way). Transient per request.
   *  F8 (2026-08-30): `name-heuristic` REMOVED (owner decision); known
   *  presets stamp `documented` (static doc-verified table server-side)
   *  or `audio-type` (SiliconFlow ?type=audio). Legacy stored configs
   *  may still carry the old `name-heuristic` string — it is loose bag
   *  data, not validated here, and the backend host-maps heal it. */
  modelFilter: z.enum(["modality", "audio-models", "audio-type", "documented", "none"]).optional(),
  /** Stored-key resolution — same semantics as in {@link draftTtsVoicesSchema}. */
  profileId: z.string().optional(),
});
export type DraftTtsModelsInput = z.infer<typeof draftTtsModelsSchema>;

/** Response of GET /api/tts/local/docker — honest availability check for the
 *  local-server quickstart: `version` is the first line of `docker --version`
 *  when the CLI resolves, null when it does not (not installed / not on
 *  PATH / timed out). The quickstart UI shows non-docker launch variants
 *  next to it either way. */
export const localDockerStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
});
export type LocalDockerStatus = z.infer<typeof localDockerStatusSchema>;
