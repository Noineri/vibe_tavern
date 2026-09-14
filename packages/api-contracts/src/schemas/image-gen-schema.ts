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
  /** Execution locality (owner 2026-09-14): local = no generation timeout
   *  (explicit cancel only); cloud = IMAGE_GENERATION_CLOUD_TIMEOUT_MS. */
  localExecution: z.boolean(),
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

// ─── Probe / models / samplers (IG-8) ─────────────────────────────────────

/** Probe outcome — the adapter interface's `ImageGenProbeResult` verbatim
 *  (failures are data, never thrown across the boundary). */
export const imageGenProbeResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
  status: z.number().optional(),
});
export type ImageGenProbeResultValue = z.infer<typeof imageGenProbeResultSchema>;

/** One live-model-catalog entry — the adapter interface's
 *  `ImageGenModelInfo` verbatim (aggregator enrichment optional). */
export const imageGenModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  isFree: z.boolean().optional(),
  description: z.string().optional(),
});
export type ImageGenModelInfoValue = z.infer<typeof imageGenModelInfoSchema>;

/** One sampler entry — the adapter interface's `ImageGenSamplerInfo`
 *  verbatim (A1111-compat `GET /sdapi/v1/samplers` shape). */
export const imageGenSamplerInfoSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).optional(),
});
export type ImageGenSamplerInfoValue = z.infer<typeof imageGenSamplerInfoSchema>;

/** Body of the shared fetch-by-endpoint model listing (`POST
 *  /api/image-gen/draft/models`) — the image-gen twin of
 *  `draftSttModelsSchema`: a TRANSIENT draft request over the CURRENT form
 *  config (saved or not); `profileId` lets the server inject the stored
 *  typed-column key when the form's own key is empty and the endpoint
 *  matches (the same endpoint-guarded reuse rule as the STT draft). */
export const draftImageGenModelsSchema = z.object({
  backend: imageGenBackendSchema,
  /** Loose record (the STT draft twin): the transient request feeds the
   *  adapter factory's config directly, and the form's just-typed key rides
   *  INSIDE it — a strict parse would strip the secret before the factory
   *  ever sees it. */
  config: z.record(z.string(), z.unknown()),
  profileId: z.string().optional(),
});
export type DraftImageGenModelsInput = z.infer<typeof draftImageGenModelsSchema>;

// ─── Generate (IG-8) ─────────────────────────────────────────────────────

/** Per-request fine-tuning overrides — EVERY field optional (owner's
 *  hardcoded-parameters ban): a field the caller did not set falls back to
 *  the profile's per-mode size preset / default params, and the adapter
 *  sends only what the protocol supports. */
export const imageGenGenerateOverridesSchema = z.object({
  /** Per-request model override (the fine-tuning chip); falls back to the
   *  profile's selected model when absent. */
  model: z.string().optional(),
  negativePrompt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
  sampler: z.string().optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
});
export type ImageGenGenerateOverridesValue = z.infer<typeof imageGenGenerateOverridesSchema>;

/** Body of `POST /api/chats/:chatId/image-gen/generate` — the locked design
 *  contract: mode + anchor message + fine-tuning overrides. `prompt` is the
 *  RESOLVED image prompt (IG-8 mechanics; the mode-recipe templates and
 *  MacroEngine substitution land with the generation-core unit IG-14, which
 *  reworks how the prompt is produced — the route shape stays). */
export const generateImageGenSchema = z.object({
  profileId: z.string(),
  mode: imageGenerationModeSchema,
  /** IG-14 prompt contract. Absent → the server builds the prompt from the
   *  mode's Images-tab template + chat-context macros (the design's
   *  generation flow). Present → used verbatim for non-free modes (the
   *  fine-tuning chip's edited positive prompt — already built/substituted
   *  client-side, never re-substituted here); for `free` it is the raw
   *  payload the free template wraps ("the accompanying prompt") and is
   *  REQUIRED — a prompt-less free request is a client inconsistency. */
  prompt: z.string().min(1).optional(),
  /** The message the generation was requested from (provenance for the
   *  slot position + context-aware prompt building). */
  anchorMessageId: z.string().optional(),
  overrides: imageGenGenerateOverridesSchema.optional(),
});
export type GenerateImageGenInput = z.infer<typeof generateImageGenSchema>;

/** One generated image persisted as a flat chat attachment — the slot's
 *  `attachmentsJson` entry and the wire response item share this shape. */
export const imageGenGeneratedAttachmentSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
export type ImageGenGeneratedAttachmentValue = z.infer<typeof imageGenGeneratedAttachmentSchema>;

/** Generate response — the appended image message slot + the generation
 *  provenance (mode, profile, model, effective size, resolved seed). The
 *  bytes never leave the server: images ride the flat asset store and the
 *  message's attachment entry. */
export const imageGenGenerateResponseSchema = z.object({
  messageId: z.string(),
  mode: imageGenerationModeSchema,
  profileId: z.string(),
  model: z.string().optional(),
  seed: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  attachments: z.array(imageGenGeneratedAttachmentSchema),
});
export type ImageGenGenerateResponseValue = z.infer<typeof imageGenGenerateResponseSchema>;

// ─── Gallery promotion (IG-8) ────────────────────────────────────────────

/** Body of `POST /api/image-gen/attachments/:assetId/promote-to-gallery` —
 *  the mirror of the character route's `promote-to-attachment` in the
 *  reversed direction: a flat chat attachment (asset) is copied server-side
 *  into the character's media gallery; the sent message's attachment stays
 *  immutable. */
export const promoteImageGenAttachmentSchema = z.object({
  characterId: z.string(),
});
export type PromoteImageGenAttachmentInput = z.infer<typeof promoteImageGenAttachmentSchema>;

/** Gallery promotion response — the created gallery row identity. */
export const imageGenGalleryPromoteResponseSchema = z.object({
  assetRowId: z.string(),
  characterId: z.string(),
  ext: z.string(),
  mimeType: z.string(),
  order: z.number(),
});
export type ImageGenGalleryPromoteResponseValue = z.infer<typeof imageGenGalleryPromoteResponseSchema>;

// ─── Model favorites + per-model overlay (IG-12b) ───────────────────────

/** Body of starring a model — the image twin of
 *  `favoriteProviderModelSchema` (deviations named on the domain type: no
 *  scope, no contextLength). */
export const favoriteImageGenModelSchema = z.object({
  modelId: z.string().min(1),
  label: z.string().optional(),
});
export type FavoriteImageGenModelInput = z.infer<typeof favoriteImageGenModelSchema>;

/** Starred-model wire record. */
export const imageGenModelFavoriteSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  modelId: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
});
export type ImageGenModelFavoriteValue = z.infer<typeof imageGenModelFavoriteSchema>;

/** Per-model image-field overlay — flat all-optional merge over the profile
 *  base (the `modelSettingsOverlaySchema` twin): an absent field inherits the
 *  profile's defaultParams / modeSizePresets; no value ships as code. */
export const imageGenModelSettingsOverlaySchema = z.object({
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
  sampler: z.string().optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
  modeSizePresets: imageGenModeSizePresetsSchema.optional(),
});
export type ImageGenModelSettingsOverlayValue = z.infer<typeof imageGenModelSettingsOverlaySchema>;

/** Persisted per-model overlay wire record. */
export const imageGenModelSettingsSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  modelId: z.string(),
  settings: imageGenModelSettingsOverlaySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImageGenModelSettingsValue = z.infer<typeof imageGenModelSettingsSchema>;
