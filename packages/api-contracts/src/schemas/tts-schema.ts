import { z } from "zod";

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/** Backend discriminators for the v1 TTS roster (domain `TTS_BACKEND`) —
 *  in-browser Kokoro, any OpenAI-compatible `/v1/audio/speech` endpoint,
 *  native Gemini TTS (Interactions API), native ElevenLabs. Further native
 *  adapters (MiniMax, Azure, proprietary local servers) are additive registry
 *  entries after v1 — extend this enum when they land. */
export const ttsBackendSchema = z.enum(["kokoro", "openai-compatible", "gemini", "elevenlabs"]);
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

/** Full TTS profile as served by the API (mirrors the domain `TtsProfile`). */
export const ttsProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  backend: ttsBackendSchema,
  config: ttsProfileConfigSchema,
  voiceId: z.string(),
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
  /** Backend-specific config bag (validated by the registry, not here). */
  config: ttsProfileConfigSchema.optional().default({}),
  /** Selected voice id; empty until the user picks one (editor gates
   *  "ready"/preview on a non-empty value). */
  voiceId: z.string().optional().default(""),
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
  voiceId: z.string().optional(),
  lang: z.string().optional(),
  sortOrder: z.number().optional(),
  /** `true` moves the [Default Voice] pointer (store clears others); `false`
   *  just unsets this row without auto-promoting another. */
  isDefault: z.boolean().optional(),
});
export type UpdateTtsProfileInput = z.infer<typeof updateTtsProfileSchema>;

// ─── Links (voice map) ────────────────────────────────────────────────────────

/** Replace-all voice-map binding payload for a TTS profile (mirrors
 *  `setRegexLinksSchema` / ScriptStore link API). */
export const setTtsLinksSchema = z.object({
  links: z.array(
    z.object({
      targetType: ttsTargetTypeSchema,
      targetId: z.string().min(1),
    }),
  ),
});
export type SetTtsLinksInput = z.infer<typeof setTtsLinksSchema>;

export const generateTtsSchema = z.object({
  profileId: z.string().min(1),
  text: z.string().min(1),
  speed: z.number().optional(),
  instructions: z.string().optional(),
});
export type GenerateTtsInput = z.infer<typeof generateTtsSchema>;
