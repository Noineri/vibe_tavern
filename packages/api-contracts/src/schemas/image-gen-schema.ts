import { z } from 'zod';

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/** Backend protocol discriminators for the v1 image-gen roster (domain
 *  `IMAGE_GEN_BACKENDS`): OpenRouter (chat-completions transport), the
 *  OpenAI-images protocol (serves Custom cloud endpoints), and the
 *  A1111-compatible local dialect (owner-locked scope; later providers are
 *  separate owner-approved batches). */
export const imageGenBackendSchema = z.enum(['openrouter', 'openai-images', 'a1111']);
export type ImageGenBackendValue = z.infer<typeof imageGenBackendSchema>;

/** The six v1 generation-mode recipes (domain `IMAGE_GENERATION_MODES`). */
export const imageGenerationModeSchema = z.enum([
  'scene-background',
  'portrait',
  'character',
  'user-persona',
  'scene-illustration',
  'free',
]);
export type ImageGenerationModeValue = z.infer<typeof imageGenerationModeSchema>;

// ─── Capability mirror ────────────────────────────────────────────────────────

/** How a backend constrains output sizes: a closed vendor-set (`"WxH"`
 *  strings) or free width/height (local backends). */
export const imageGenSizeSupportSchema = z.union([
  z.object({ kind: z.literal('vendor-set'), sizes: z.array(z.string()) }),
  z.object({ kind: z.literal('free') }),
]);
export type ImageGenSizeSupportValue = z.infer<typeof imageGenSizeSupportSchema>;

/** Adapter capability snapshot persisted on the profile (the editor renders
 *  provider-gated controls from it). `supportsImg2img`/`supportsInpaint` are
 *  reserved schema fields — adapters stamp false, no UI reads them in v1. */
export const imageGenCapabilityFlagsSchema = z.object({
  supportsNegativePrompt: z.boolean(),
  supportsSamplers: z.boolean(),
  supportsSeed: z.boolean(),
  sizeSupport: imageGenSizeSupportSchema,
  noApiKey: z.boolean(),
  supportsLiveProgress: z.boolean(),
  supportsImg2img: z.boolean(),
  supportsInpaint: z.boolean(),
});
export type ImageGenCapabilityFlagsValue = z.infer<typeof imageGenCapabilityFlagsSchema>;

// ─── Params & size presets ────────────────────────────────────────────────────

/** Profile-level default generation params — EVERY field optional (owner's
 *  hardcoded-parameters ban): absent means "send nothing, use the vendor
 *  default"; no value ships as code. */
export const imageGenDefaultParamsSchema = z.object({
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
  sampler: z.string().optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
});
export type ImageGenDefaultParamsValue = z.infer<typeof imageGenDefaultParamsSchema>;

/** Per-mode width/height preset — both optional (an unset side sends no
 *  value; the vendor default applies). */
export const imageGenModeSizePresetSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
});
export type ImageGenModeSizePresetValue = z.infer<typeof imageGenModeSizePresetSchema>;

/** Size presets keyed by generation mode — only configured modes carry
 *  entries (`z.partialRecord`: enum keys optional, unknown keys rejected,
 *  `{}` valid — mirrors the domain `Partial<Record<…>>`). */
export const imageGenModeSizePresetsSchema = z.partialRecord(
  imageGenerationModeSchema,
  imageGenModeSizePresetSchema,
);
export type ImageGenModeSizePresetsValue = z.infer<typeof imageGenModeSizePresetsSchema>;

// ─── Profile wire record ──────────────────────────────────────────────────────

/** Full image-gen profile as served by the API — SECURITY PROJECTION of the
 *  stored domain row: the secret lives in the typed `api_key` column (IG-1
 *  rule, the TE2-16/ST-1 key rule applied), never inside any JSON blob, and
 *  is reported as the boolean `hasStoredApiKey` (same wire contract as TTS
 *  and STT profiles). The key never crosses the boundary on a read; writes
 *  carry it as the top-level write-only `apiKey` field (`undefined` = keep,
 *  `""` = clear, non-empty = set). */
export const imageGenProfileSchema = z.object({
  id: z.string(),
  /** Human-readable profile name ("Forge — local"). */
  name: z.string(),
  /** Adapter protocol discriminator (see {@link imageGenBackendSchema}). */
  backend: imageGenBackendSchema,
  /** UI preset slug (round-trips the editor form); absent for Custom. */
  presetId: z.string().optional(),
  /** Base URL the adapter talks to. */
  endpoint: z.string().min(1),
  /** True when the typed api_key column holds a non-empty key. */
  hasStoredApiKey: z.boolean(),
  /** Selected model (level-2 outer setting; may be unset on a fresh card). */
  modelId: z.string().optional(),
  defaultParams: imageGenDefaultParamsSchema,
  modeSizePresets: imageGenModeSizePresetsSchema,
  /** LLM-assisted image-prompt writing (explicit per-profile toggle). */
  llmAssistEnabled: z.boolean(),
  llmProviderProfileId: z.string().optional(),
  llmModelId: z.string().optional(),
  capabilities: imageGenCapabilityFlagsSchema,
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImageGenProfileValue = z.infer<typeof imageGenProfileSchema>;

// ─── Create / update ─────────────────────────────────────────────────────────

export const createImageGenProfileSchema = z.object({
  /** Human-readable profile name. */
  name: z.string().min(1),
  /** Adapter protocol discriminator. */
  backend: imageGenBackendSchema,
  /** UI preset slug; omit (or empty) for Custom. */
  presetId: z.string().optional(),
  /** Base URL. */
  endpoint: z.string().min(1),
  /** Write-only API key: non-empty = set, empty/absent = none. Never returned
   *  by a read (see `hasStoredApiKey`). */
  apiKey: z.string().optional(),
  modelId: z.string().optional(),
  defaultParams: imageGenDefaultParamsSchema,
  modeSizePresets: imageGenModeSizePresetsSchema,
  llmAssistEnabled: z.boolean().optional().default(false),
  llmProviderProfileId: z.string().optional(),
  llmModelId: z.string().optional(),
  capabilities: imageGenCapabilityFlagsSchema,
  sortOrder: z.number().optional().default(0),
});
export type CreateImageGenProfileInput = z.infer<typeof createImageGenProfileSchema>;

export const updateImageGenProfileSchema = z.object({
  name: z.string().min(1).optional(),
  backend: imageGenBackendSchema.optional(),
  /** `undefined` = keep, `""`/null = drop back to Custom, non-empty = set. */
  presetId: z.string().nullable().optional(),
  endpoint: z.string().min(1).optional(),
  /** Write-only tri-state: `undefined` = keep the stored key, `""` = clear
   *  it, non-empty = replace it. */
  apiKey: z.string().optional(),
  modelId: z.string().nullable().optional(),
  defaultParams: imageGenDefaultParamsSchema.optional(),
  modeSizePresets: imageGenModeSizePresetsSchema.optional(),
  llmAssistEnabled: z.boolean().optional(),
  llmProviderProfileId: z.string().nullable().optional(),
  llmModelId: z.string().nullable().optional(),
  capabilities: imageGenCapabilityFlagsSchema.optional(),
  sortOrder: z.number().optional(),
});
export type UpdateImageGenProfileInput = z.infer<typeof updateImageGenProfileSchema>;
