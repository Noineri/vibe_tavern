import { z } from 'zod';

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/** Backend protocol discriminators for the v1 image-gen roster (domain
 *  `IMAGE_GEN_BACKENDS`): OpenRouter (chat-completions transport), the
 *  OpenAI-images protocol (serves Custom cloud endpoints), the
 *  A1111-compatible local dialect, and ComfyUI (raw API —
 *  COMFYUI_BACKEND_PLAN). */
export const imageGenBackendSchema = z.enum(['openrouter', 'openai-images', 'a1111', 'comfyui']);
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

/** A closed numeric range for one advanced slider param (IG-CF5). */
const imageGenParamRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
  step: z.number(),
});

/** Per-backend slider-range overrides for the advanced numeric params
 *  (IG-CF5). Every member optional: absent member / absent object → the
 *  editor falls back to the global defaults in the domain table
 *  (IMAGE_GEN_PARAM_RANGES). Mechanism ships empty today (no vendor exports
 *  machine-readable param limits); declared here so the stamped mirror
 *  survives this zod boundary instead of being stripped — the reserved-fields
 *  precedent (supportsImg2img/inpaint). */
export const imageGenParamRangesSchema = z.object({
  steps: imageGenParamRangeSchema.optional(),
  cfgScale: imageGenParamRangeSchema.optional(),
  clipSkip: imageGenParamRangeSchema.optional(),
});
export type ImageGenParamRangesValue = z.infer<typeof imageGenParamRangesSchema>;

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
  paramRanges: imageGenParamRangesSchema.optional(),
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
  /** Schedule type (PG-3, A1111 dialect) — the sampler's schedule; empty
   *  = vendor default. */
  scheduler: z.string().optional(),
  /** Text-encoder file for the ComfyUI DiT template (CG-A2, comfyui
   *  dialect only): the CLIPLoader sidecar of a bare diffusion model.
   *  Absent = adapter-side canonical resolution against the live folder. */
  encoderName: z.string().optional(),
  /** VAE file for the ComfyUI DiT template (CG-A2, comfyui dialect only):
   *  the VAELoader sidecar. Absent = adapter-side canonical resolution. */
  vaeName: z.string().optional(),
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

/** User-added vendor-size entry (IG-20a) — a pair the vendor announced but
 *  our static table lacks. Formally validated (positive integers, ratio
 *  `N:N`); semantic fit stays fail-closed at the adapter seam (the backend
 *  accepts a size only from its table ∪ the profile's entries). */
export const imageGenUserSizeEntrySchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  ratio: z.string().regex(/^\d+:\d+$/).optional(),
});
export type ImageGenUserSizeEntryValue = z.infer<typeof imageGenUserSizeEntrySchema>;

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
  /** Auto-key hint (IG-21, the TTS/STT `autoKeyProviderName` twin): the
   *  provider profile name whose key auto-matches at the execution seam —
   *  UI hint only; the key itself never crosses the boundary. Own key wins
   *  (null when the profile has one); a1111 is local/keyless (always null). */
  autoKeyProviderName: z.string().nullable(),
  /** Selected model (level-2 outer setting; may be unset on a fresh card). */
  modelId: z.string().optional(),
  defaultParams: imageGenDefaultParamsSchema,
  modeSizePresets: imageGenModeSizePresetsSchema,
  /** User-added vendor-size entries (IG-20a); absent = none. */
  userSizes: z.array(imageGenUserSizeEntrySchema).optional(),
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
  userSizes: z.array(imageGenUserSizeEntrySchema).optional(),
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
  userSizes: z.array(imageGenUserSizeEntrySchema).optional(),
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
 *  `ImageGenModelInfo` verbatim (aggregator enrichment optional;
 *  `family`/`template` are the comfyui dialect's model-picker enrichment,
 *  CG-A3 — other backends omit them). */
export const imageGenModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  isFree: z.boolean().optional(),
  description: z.string().optional(),
  family: z.string().optional(),
  template: z.string().optional(),
});
export type ImageGenModelInfoValue = z.infer<typeof imageGenModelInfoSchema>;

/** DiT sidecar file lists (CG-B1, comfyui dialect only) — the live
 *  text-encoder + VAE folder catalogs (`/models/text_encoders`,
 *  `/models/vae`) feeding the advanced accordion's DiT fields. Other
 *  dialects have no such surface. */
export const imageGenDitSidecarsSchema = z.object({
  encoders: z.array(z.string()),
  vaes: z.array(z.string()),
});
export type ImageGenDitSidecarsValue = z.infer<typeof imageGenDitSidecarsSchema>;

/** One sampler entry — the adapter interface's `ImageGenSamplerInfo`
 *  verbatim (A1111-compat `GET /sdapi/v1/samplers` shape). */
export const imageGenSamplerInfoSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).optional(),
});
export type ImageGenSamplerInfoValue = z.infer<typeof imageGenSamplerInfoSchema>;

/** One scheduler entry (A1111-compat `GET /sdapi/v1/schedulers` shape:
 *  `{name, label, aliases, options}` — PG-3). */
export const imageGenSchedulerInfoSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
});
export type ImageGenSchedulerInfoValue = z.infer<typeof imageGenSchedulerInfoSchema>;

/** Live progress snapshot (A1111-compat `GET /sdapi/v1/progress`) — the
 *  adapter interface's `ImageGenProgressInfo` verbatim: `progress` is
 *  0..1; `previewBase64` is the interim preview when the server produces
 *  one (needs `show_progress_every_n_steps`). */
export const imageGenProgressInfoSchema = z.object({
  progress: z.number().min(0).max(1),
  etaRelative: z.number().optional(),
  state: z.string().optional(),
  previewBase64: z.string().optional(),
});
export type ImageGenProgressInfoValue = z.infer<typeof imageGenProgressInfoSchema>;

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
  /** IG-18a regenerate-as-variant: present → the result is appended as a
   *  VARIANT of this existing image message slot (the design's swipe-variant
   * regeneration — mode/profile defaults come from the slot's provenance on
   * the client; the server just variant-appends). The target must be a
   * message of THIS chat; absent → today's sibling-append slot. */
  targetMessageId: z.string().optional(),
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
  /** Schedule type (PG-3, A1111 dialect) — the overlay twin of the
   *  profile-default `scheduler`. */
  scheduler: z.string().optional(),
  /** Text-encoder file for the ComfyUI DiT template (CG-A2) — the overlay
   *  twin of the profile-default `encoderName`. */
  encoderName: z.string().optional(),
  /** VAE file for the ComfyUI DiT template (CG-A2) — the overlay twin of
   *  the profile-default `vaeName`. */
  vaeName: z.string().optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
  /** ADetailer face-fix switch (IG-CF15/PG-4 v1) — A1111-family only. */
  adetailer: z.boolean().optional(),
  /** Face-model preset — one of the domain's IMAGE_GEN_ADETAILER_FACE_MODELS
   *  (validated client-side against the constant; kept a plain string here
   *  so the list can grow without a contract bump). */
  adetailerModel: z.string().optional(),
  modeSizePresets: imageGenModeSizePresetsSchema.optional(),
});
export type ImageGenModelSettingsOverlayValue = z.infer<typeof imageGenModelSettingsOverlaySchema>;

/** Persisted per-model overlay wire record. `samplerSetId` = the applied
 *  image-gen sampler set's provenance pointer (IG-CF15, the LLM
 *  provider-profile `samplerSetId` twin): copy-on-select — applying a set
 *  copies its values into `settings` and records the pointer; editing the
 *  set later never rewrites this row. */
export const imageGenModelSettingsSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  modelId: z.string(),
  settings: imageGenModelSettingsOverlaySchema,
  samplerSetId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImageGenModelSettingsValue = z.infer<typeof imageGenModelSettingsSchema>;

/** Upsert body — the overlay values plus the optional set pointer (absent =
 *  keep the stored pointer; null = clear it). */
export const upsertImageGenModelSettingsSchema = z.object({
  settings: imageGenModelSettingsOverlaySchema,
  samplerSetId: z.string().nullable().optional(),
});
export type UpsertImageGenModelSettingsValue = z.infer<typeof upsertImageGenModelSettingsSchema>;

// ─── Named image-gen sampler sets (IG-CF15 — the sampler_sets LS-5 twin) ─────

/** Set payload: the five scalar generation params (no `modeSizePresets` —
 *  sizes are the model layer's own surface, IG-CF14). All-optional like the
 *  overlay: an inert template, empty = nothing to apply. */
export const imageGenSamplerSetPayloadSchema = z.object({
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
  sampler: z.string().optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
});
export type ImageGenSamplerSetPayloadValue = z.infer<typeof imageGenSamplerSetPayloadSchema>;

/** Wire record — as served by GET /api/image-gen/sampler-sets. */
export const imageGenSamplerSetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sortOrder: z.number().int(),
  payload: imageGenSamplerSetPayloadSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImageGenSamplerSet = z.infer<typeof imageGenSamplerSetSchema>;

export const imageGenSamplerSetListSchema = z.array(imageGenSamplerSetSchema);
export type ImageGenSamplerSetList = z.infer<typeof imageGenSamplerSetListSchema>;

/** Create from the pane's current values (the «+» flow): name + payload. */
export const createImageGenSamplerSetSchema = z.object({
  name: z.string().min(1),
  payload: imageGenSamplerSetPayloadSchema,
});
export type ImageGenSamplerSetCreate = z.infer<typeof createImageGenSamplerSetSchema>;

/** Partial update: rename (pencil morph) and/or overwrite the payload (💾). */
export const updateImageGenSamplerSetSchema = z.object({
  name: z.string().min(1).optional(),
  payload: imageGenSamplerSetPayloadSchema.optional(),
});
export type ImageGenSamplerSetUpdate = z.infer<typeof updateImageGenSamplerSetSchema>;

/** Import body (upload button): `name` + the RAW parsed JSON — VT-native set
 *  JSON only (no ST TextGen target exists for image-gen); the backend
 *  validates against the payload schema and rejects empty objects loudly. */
export const importImageGenSamplerSetSchema = z.object({
  name: z.string().min(1),
  raw: z.unknown(),
});
export type ImageGenSamplerSetImport = z.infer<typeof importImageGenSamplerSetSchema>;
