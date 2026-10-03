/** The per-cell template routes were RETIRED (IF-1e): templates live in
 * image prompt profiles now — the cell + families schemas below serve the
 * profile-scoped catalog and the registry dropdown. */
import { IMAGE_GEN_WORKFLOW_FAMILY_IDS } from "@vibe-tavern/domain";
import { z } from "zod";

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/** Backend protocol discriminators for the v1 image-gen roster (domain
 *  `IMAGE_GEN_BACKENDS`): OpenRouter (chat-completions transport), the
 *  OpenAI-images protocol (serves Custom cloud endpoints + the PE-1 cloud
 *  family), the A1111-compatible local dialect, ComfyUI (raw API —
 *  COMFYUI_BACKEND_PLAN), and the PE-1 OpenAI-images-family cloud slugs
 *  (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-1). */
export const imageGenBackendSchema = z.enum(['openrouter', 'openai-images', 'a1111', 'comfyui', 'togetherai', 'siliconflow', 'nanogpt', 'electronhub', 'pollinations', 'deepinfra', 'recraft', 'zai', 'minimax', 'volcengine', 'dashscope', 'nim', 'chutes', 'hf', 'google', 'stability', 'ideogram', 'cloudflare', 'aihorde', 'bfl', 'fal', 'replicate', 'leonardo', 'luma', 'novita', 'krea']);

/** Krea per-model params (IF-11): the K2 prompt-expansion mode + the
 *  generative sliders (intensity / complexity / movement, −100..100,
 *  0 = neutral — by their docs they never touch the prompt text).
 *  Every field optional (params-unset): absent creativity = the VT
 *  policy default "raw" (authored full-form prompts — the vendor default
 *  expands them with invented style/composition); absent sliders =
 *  unsent (vendor-neutral). */
export const imageGenKreaParamsSchema = z.object({
  creativity: z.enum(["raw", "low", "medium", "high"]).optional(),
  intensity: z.number().min(-100).max(100).optional(),
  complexity: z.number().min(-100).max(100).optional(),
  movement: z.number().min(-100).max(100).optional(),
});
export type ImageGenKreaParamsValue = z.infer<typeof imageGenKreaParamsSchema>;
export type ImageGenBackendValue = z.infer<typeof imageGenBackendSchema>;

/** The generation-mode recipes (domain `IMAGE_GENERATION_MODES`): the six
 *  v1 modes + IPT Wave 0 selfie/avatar (complements, never replacements). */
export const imageGenerationModeSchema = z.enum([
  'scene-background',
  'portrait',
  'character',
  'user-persona',
  'scene-illustration',
  'free',
  'selfie',
  'avatar',
]);
export type ImageGenerationModeValue = z.infer<typeof imageGenerationModeSchema>;

/** IPT-2 (IMAGE_PROMPT_TEMPLATES_PLAN): the checkpoint-family axis — the
 *  domain `IMAGE_PROMPT_FAMILIES` registry keys (prompt dialects: prose /
 *  tag families / the assist-only hybrid). Enum is hardcoded here per the
 *  house contracts style; the domain registry stays the source of truth. */
export const imagePromptFamilySchema = z.enum([
  'prose',
  'pony',
  'illustrious',
  'noobai',
  'anima',
  'krea2',
  'qwen',
  'sdxl-realism',
  'hybrid',
]);
export type ImagePromptFamilyValue = z.infer<typeof imagePromptFamilySchema>;

/** IPT-2: how a profile's family currently resolves — the derived
 *  `familySource` read-model field (domain `IMAGE_GEN_FAMILY_SOURCES`). */
export const imageGenFamilySourceSchema = z.enum(['none', 'auto', 'manual']);
export type ImageGenFamilySourceValue = z.infer<typeof imageGenFamilySourceSchema>;

/** ComfyUI base workflows selectable manually by image-gen sampler sets.
 * A1111 accepts the pass-through field but ignores it. */
export const imageGenWorkflowFamilySchema = z.enum(IMAGE_GEN_WORKFLOW_FAMILY_IDS);
export type ImageGenWorkflowFamilyValue = z.infer<typeof imageGenWorkflowFamilySchema>;

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
  cfgRescale: imageGenParamRangeSchema.optional(),
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
  /** LoRA selection (CG-C2/FT-A4) — optional: absent = false, graduates
   *  per backend (ComfyUI now; A1111 with FT-A4). */
  supportsLoras: z.boolean().optional(),
  /** Advanced scalar controls — optional by design: absent = false, so the
   *  UI renders only fields the adapter actually wires. */
  supportsSteps: z.boolean().optional(),
  supportsCfgScale: z.boolean().optional(),
  supportsClipSkip: z.boolean().optional(),
  /** Hires-fix second pass (FT-A4) — the supportsLoras twin: absent =
   *  false, A1111 dialect today. */
  supportsHiresFix: z.boolean().optional(),
  paramRanges: imageGenParamRangesSchema.optional(),
});
export type ImageGenCapabilityFlagsValue = z.infer<typeof imageGenCapabilityFlagsSchema>;

// ─── Params & size presets ────────────────────────────────────────────────────

/** Hires-fix block on stored params (IF-7b): `enabled` gates the
 *  request rung; the knob set matches the chip-draft hires block
 *  (ImageGenHiresSection) so a set can carry it verbatim. */
export const imageGenHiresBlockSchema = z.object({
  enabled: z.boolean(),
  upscaler: z.string().min(1).optional(),
  /** 0 = the dialect's own "inherit first-pass steps" value. */
  steps: z.number().int().min(0).optional(),
  scale: z.number().finite().positive().optional(),
  denoisingStrength: z.number().finite().min(0).max(1).optional(),
});
export type ImageGenHiresBlockValue = z.infer<typeof imageGenHiresBlockSchema>;

/** Profile-level default generation params — EVERY field optional (owner's
 *  hardcoded-parameters ban): absent means "send nothing, use the vendor
 *  default"; no value ships as code. */
export const imageGenDefaultParamsSchema = z.object({
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
  cfgRescale: z.number().min(0).max(1).optional(),
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
  /** Manual ComfyUI base-workflow selection carried by a sampler-set pick.
   * A1111 ignores it. */
  workflowFamily: imageGenWorkflowFamilySchema.optional(),
  /** VAE override for swappable-slot dialects (IF-7b) — A1111's
   *  `override_settings.sd_vae` and the Comfy checkpoint VAELoader swap;
   *  DiT templates keep their family-fixed `vaeName`. */
  vae: z.string().min(1).optional(),
  /** Hires-fix second pass on the profile base (IF-7b): `enabled` gates
   *  the request rung (a configured-but-disabled block ships nothing). */
  hires: imageGenHiresBlockSchema.optional(),
  /** ADetailer / face-detailer second pass on the profile base — BOTH
   *  local dialects (A1111: the extension toggle; ComfyUI: the IF-6
   *  FaceDetailer chain). `false`/absent ships nothing; `true` enables
   *  the face-fix rung. Not gated behind the per-model bind — the bind
   *  routes writes, it never hides controls. */
  adetailer: z.boolean().optional(),
  /** Detector model of the face-fix rung — absent = the dialect's own
   *  default (A1111: the extension's bundled lightweight detector;
   *  ComfyUI: the live-probed detector list's pick). */
  adetailerModel: z.string().min(1).optional(),
  /** Explicit steps for the detail pass; absent inherits the base steps. */
  adetailerSteps: z.number().optional(),
  /** Krea K2 params — the BASE rung of the two-rung ladder (the overlay's
   *  `krea` block rides on top; absent overlay fields inherit these).
   *  Owner ruling: the pane's Krea 2 section is not gated behind the
   *  per-model bind toggle — it writes the active arm like every other
   *  scalar. */
  krea: imageGenKreaParamsSchema.optional(),
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
  /** IF-7a: the sampler set the base defaultParams were last applied from
   *  (provenance only — copy-on-select, never a live link; null = no set).
   *  The image_gen_model_settings `samplerSetId` twin at profile level. */
  defaultParamsSetId: z.string().nullable(),
  modeSizePresets: imageGenModeSizePresetsSchema,
  /** User-added vendor-size entries (IG-20a); absent = none. */
  userSizes: z.array(imageGenUserSizeEntrySchema).optional(),
  /** LLM-assisted image-prompt writing (explicit per-profile toggle). */
  llmAssistEnabled: z.boolean(),
  llmProviderProfileId: z.string().optional(),
  llmModelId: z.string().optional(),
  /** IMAGEGEN_ASSIST_REFUSAL_REPORT step 3: opt-in (default off) for ONE
   *  silent assist retry when the assist output is a refusal; a second
   *  refusal still fails the run. */
  assistRetryOnRefusal: z.boolean(),
  /** IPT-2: the manual family pin — authoritative when present; absent =
   *  the auto path (freshness of `familyDetected` is judged against the
   *  current modelId by the consumer, not baked into this record). */
  familyOverride: imagePromptFamilySchema.optional(),
  /** IPT-2: the last auto-detection result; absent = never detected. */
  familyDetected: imagePromptFamilySchema.optional(),
  /** IPT-2: the model id the detection ran against (stale marker). */
  familyDetectedForModel: z.string().optional(),
  /** IPT-2: DERIVED read-model field (override → manual, detected → auto,
   *  neither → none) — never a stored column, so it cannot drift. */
  familySource: imageGenFamilySourceSchema,
  /** IPT-2: the quality layer joins the prompt ONLY when explicitly on. */
  qualityLayerEnabled: z.boolean(),
  capabilities: imageGenCapabilityFlagsSchema,
  /** MR-12 (the TTS/STT `isDefault` twin): the GLOBAL active-profile
   *  pointer — at most one row. Read-only on this surface: create/PATCH
   *  never accept it (the dedicated default route is the only writer). */
  isDefault: z.boolean(),
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
  /** IF-7a: optional base set pointer (null/absent = no set). */
  defaultParamsSetId: z.string().nullable().optional(),
  modeSizePresets: imageGenModeSizePresetsSchema,
  userSizes: z.array(imageGenUserSizeEntrySchema).optional(),
  llmAssistEnabled: z.boolean().optional().default(false),
  llmProviderProfileId: z.string().optional(),
  llmModelId: z.string().optional(),
  /** Refusal-retry opt-in (default off — enabled consciously). */
  assistRetryOnRefusal: z.boolean().optional().default(false),
  /** IPT-2: quality-layer toggle (default off). Family columns are
   *  deliberately ABSENT from create: a fresh profile starts unpinned;
   *  the Wave 3 family route is the only family writer. */
  qualityLayerEnabled: z.boolean().optional().default(false),
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
  /** IF-7a tri-state: undefined = keep, null = clear, string = point. */
  defaultParamsSetId: z.string().nullable().optional(),
  modeSizePresets: imageGenModeSizePresetsSchema.optional(),
  userSizes: z.array(imageGenUserSizeEntrySchema).optional(),
  llmAssistEnabled: z.boolean().optional(),
  llmProviderProfileId: z.string().nullable().optional(),
  llmModelId: z.string().nullable().optional(),
  assistRetryOnRefusal: z.boolean().optional(),
  qualityLayerEnabled: z.boolean().optional(),
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

/** IF-20: response header on a saved profile's listing (`/models`,
 *  `/sidecars`) served from the last-good snapshot because the live fetch
 *  failed — its value is the snapshot's ISO fetch time. Absent = live.
 *  The body keeps the live route's shape either way. */
export const IMAGE_GEN_LISTING_SNAPSHOT_AT_HEADER = "X-VT-Listing-Snapshot-At";

/** One LoRA list entry (CG-C2, capability-gated backends) — the adapter
 *  interface's `ImageGenLoraInfo` verbatim. `family` is NULL for the
 *  unknown-family bucket (family ladder exhausted: no embedded metadata,
 *  no sidecar) — nullable by design, unlike the model entry's optional
 *  field, because the chip's family filter needs an explicit unknown
 *  bucket rather than "field absent". */
export const imageGenLoraInfoSchema = z.object({
  name: z.string().min(1),
  family: z.string().nullable(),
  /** Activation words discovered in the sidecar stores (CG-C3, pulled
   *  forward into CG-C2 at the owner's direction 2026-09-18: the live
   * re-test must LEARN the trigger via the backend, not hardcode it).
   *  Empty = none found. Kept VERBATIM per store — civitai packs
   *  comma-phrases into single strings; splitting is display-side. */
  triggerWords: z.array(z.string()),
});
export type ImageGenLoraInfoValue = z.infer<typeof imageGenLoraInfoSchema>;

/** One upscaler list entry (FT-A4, a1111 dialect) — the adapter
 *  interface's `ImageGenUpscalerInfo` verbatim: the `hr_upscaler`
 *  vocabulary from `GET /sdapi/v1/upscalers`, the hires-fix block's
 *  dropdown source. */
export const imageGenUpscalerInfoSchema = z.object({
  name: z.string().min(1),
});
export type ImageGenUpscalerInfoValue = z.infer<typeof imageGenUpscalerInfoSchema>;

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
 *  0..1, ABSENT on phase-only responses (cloud dialects mid-run — no
 *  steps surface exists there); `phase` (MR-11) rides every poll while a
 *  VT generation is in flight — "prompt" (LLM assist writing),
 *  "starting" (queue/model load/warmup), "steps" (the backend reports
 *  progress for this run's job); `previewBase64` is the interim preview
 *  when the server produces one (needs `show_progress_every_n_steps`). */
export const imageGenProgressInfoSchema = z.object({
  progress: z.number().min(0).max(1).optional(),
  phase: z.enum(["prompt", "starting", "steps"]).optional(),
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
  cfgRescale: z.number().min(0).max(1).optional(),
  sampler: z.string().optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
  /** Per-run manual ComfyUI base-workflow override. A1111 ignores it. */
  workflowFamily: imageGenWorkflowFamilySchema.optional(),
  /** Explicit detail-pass steps; absent falls back to the profile's stored ladder. */
  adetailerSteps: z.number().int().optional(),
  /** Enabled LoRAs of this run (CG-C2, chip-draft level): name verbatim
   *  + one strength feeding both strength_model and strength_clip on
   *  ComfyUI (single-slider chip, FT-A5); the A1111 dialect maps the same
   *  entries onto <lora:name:strength> prompt tags (FT-A4). Capability-
   *  gated at the adapter: profiles without supportsLoras never see it. */
  loras: z
    .array(
      z.object({
        name: z.string().min(1),
        strength: z.number().finite(),
      }),
    )
    .optional(),
  /** Hires-fix second pass (FT-A4, capability-gated backends): PRESENCE
   *  = enabled — the a1111 dialect sends enable_hr plus the set knobs
   *  (`hr_upscaler` / `hr_second_pass_steps` / `hr_scale` /
   *  `denoising_strength`; unset knobs stay unset so server defaults
   *  fill). The chip-draft rung ONLY, like loras. */
  hires: z
    .object({
      upscaler: z.string().min(1).optional(),
      /** 0 = the dialect's own "inherit first-pass steps" value. */
      steps: z.number().int().min(0).optional(),
      scale: z.number().finite().positive().optional(),
      denoisingStrength: z.number().finite().min(0).max(1).optional(),
    })
    .optional(),
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
   *  client-side, never re-substituted here). This applies to `free` too:
   *  absent uses the active profile's saved Free template; present is the
   *  per-run override. */
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

/** Body of `POST /api/chats/:chatId/image-gen/prompt-draft` (FT-B2): asks
 * the image profile's configured LLM assist to write an editable prompt.
 * `hint` is deliberately optional for scene-backed modes, where the chat
 * digest alone is a sufficient instruction. */
export const draftImageGenPromptSchema = z.object({
  profileId: z.string(),
  mode: imageGenerationModeSchema,
  hint: z.string().optional(),
});
export type DraftImageGenPromptInput = z.infer<typeof draftImageGenPromptSchema>;

/** One AI-drafted prompt, returned to the chip before image generation.
 * Negative text appears only for image backends that support it. */
export const draftImageGenPromptResponseSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
});
export type DraftImageGenPromptResponseValue = z.infer<typeof draftImageGenPromptResponseSchema>;

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
  cfgRescale: z.number().min(0).max(1).optional(),
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
  /** Manual ComfyUI base-workflow selection carried by a sampler-set pick;
   * the overlay twin of the profile default. A1111 ignores it. */
  workflowFamily: imageGenWorkflowFamilySchema.optional(),
  /** VAE override for swappable-slot dialects (IF-7b) — the overlay twin
   *  of the profile-default `vae`. */
  vae: z.string().min(1).optional(),
  /** Hires-fix second pass on the per-model overlay (IF-7b) — the overlay
   *  twin of the profile-default `hires`. */
  hires: imageGenHiresBlockSchema.optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
  /** ADetailer face-fix switch — BOTH local dialects (A1111: the
   *  extension; ComfyUI: the IF-6 FaceDetailer chain). */
  adetailer: z.boolean().optional(),
  /** Face-model preset — one of the domain's IMAGE_GEN_ADETAILER_FACE_MODELS
   *  (validated client-side against the constant; kept a plain string here
   *  so the list can grow without a contract bump). The face-fix pair is
   *  consumed by BOTH local dialects (A1111: the extension; ComfyUI: the
   *  IF-6 FaceDetailer chain — widened 2026-09-27 from the a1111-only v1). */
  adetailerModel: z.string().optional(),
  /** Explicit steps for the detail pass; absent inherits the profile base steps. */
  adetailerSteps: z.number().optional(),
  /** Krea K2 params (IF-11) — the OVERLAY rung of the two-rung ladder
   *  (the profile base's `krea` block sits underneath; absent fields
   *  inherit it): creativity + the generative sliders, read only by
   *  krea-2 models (the backend filters every field against the model's
   *  own schema). */
  krea: imageGenKreaParamsSchema.optional(),
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

/** Set payload: the generation params a set can carry (no
 *  `modeSizePresets` — sizes are the model layer's own surface, IG-CF14).
 *  All-optional like the overlay: an inert template, empty = nothing to
 *  apply. IF-7b: `scheduler` (Krea presets), `vae` (the encoder ruling),
 *  and the configured-but-disabled `hires` block joined the five LS-5
 *  scalars. */
export const imageGenSamplerSetPayloadSchema = z.object({
  steps: z.number().optional(),
  cfgScale: z.number().optional(),
  cfgRescale: z.number().min(0).max(1).optional(),
  sampler: z.string().optional(),
  seed: z.number().optional(),
  clipSkip: z.number().optional(),
  scheduler: z.string().optional(),
  /** Text-encoder pin carried by a manual ComfyUI workflow selection. */
  encoderName: z.string().min(1).optional(),
  /** Manual base-workflow selection carried by a sampler-set pick;
   * ComfyUI-only, A1111 ignores it. */
  workflowFamily: imageGenWorkflowFamilySchema.optional(),
  vae: z.string().min(1).optional(),
  hires: imageGenHiresBlockSchema.optional(),
  /** Face-fix second pass — configured-but-disabled in stock sets (the
   *  detector model stays unset: the dialect's own default fills it, no
   *  hardcoded names). Both LOCAL dialects consume the pair. */
  adetailer: z.boolean().optional(),
  adetailerModel: z.string().min(1).optional(),
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

/** IF-10: a learned provider prompt cap — advisory, per (backend, model).
 *  Learned from a `prompt_too_long` rejection (the provider message names
 *  the number); self-invalidated by any later success whose composed
 *  prompt exceeded it. Never blocks a send. */
export const imageGenPromptCapSchema = z.object({
  backend: z.string().min(1),
  modelId: z.string().min(1),
  maxPromptChars: z.number().int().positive(),
});
export type ImageGenPromptCap = z.infer<typeof imageGenPromptCapSchema>;

export const imageGenPromptCapListSchema = z.array(imageGenPromptCapSchema);
export type ImageGenPromptCapList = z.infer<typeof imageGenPromptCapListSchema>;

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

// ─── IPT-3 (IMAGE_PROMPT_TEMPLATES_PLAN): templates pane + families registry ──

/** The row-key axis of the templates surface: a generation mode OR the
 *  shared negative row (mirrors the db-level ImagePromptVariantKey — the
 *  assist core stays a canon asset, quality rides its own column on the
 *  (mode, family) row). */
export const imagePromptTemplateRowKeySchema = z.enum([
  'scene-background',
  'portrait',
  'character',
  'user-persona',
  'scene-illustration',
  'free',
  'selfie',
  'avatar',
  'negative',
]);
export type ImagePromptTemplateRowKeyValue = z.infer<typeof imagePromptTemplateRowKeySchema>;

/** Which canon owns a non-customized cell — the variant resolver's source
 *  label minus "custom" (cells carry customText + isCustomized
 *  separately). */
export const imagePromptCanonSourceSchema = z.enum(['family-canon', 'prose-canon']);
export type ImagePromptCanonSourceValue = z.infer<typeof imagePromptCanonSourceSchema>;

/** One (rowKey × family) cell of the templates pane. `canonText` is the
 *  canon that applies when NOT customized — tier-resolved SERVER-side (the
 *  family's own asset, else the prose fallback); the pane never
 *  re-implements the fallback rule. `canonSource` tells which tier won
 *  ("prose-canon" on a non-prose family = the family inherits prose,
 *  including Free's neutral shipped fallback). */
export const imagePromptTemplateCellSchema = z.object({
  rowKey: imagePromptTemplateRowKeySchema,
  family: imagePromptFamilySchema,
  canonText: z.string(),
  canonSource: imagePromptCanonSourceSchema,
  customText: z.string().nullable(),
  qualityText: z.string().nullable(),
  isCustomized: z.boolean(),
});
export type ImagePromptTemplateCellValue = z.infer<typeof imagePromptTemplateCellSchema>;

/** The per-cell template routes were RETIRED (IF-1e — IMAGEGEN_FOLLOWUP):
 *  templates live in image prompt profiles now. The cell schema above
 *  serves the profile-scoped catalog; the quality-clear convention
 *  (blank → canon) moved to the profile save boundary. */

/** One registry family for the pane's dropdowns (grammar, what it authors
 *  itself vs inherits from prose, whether the assist addendum exists). */
export const imagePromptFamilyInfoSchema = z.object({
  id: imagePromptFamilySchema,
  grammar: z.enum(['prose', 'tags', 'hybrid']),
  ownTemplates: z.boolean(),
  ownNegative: z.boolean(),
  ownQuality: z.boolean(),
  hasAssistAddendum: z.boolean(),
});
export type ImagePromptFamilyInfoValue = z.infer<typeof imagePromptFamilyInfoSchema>;

/** GET /api/image-gen/prompt-families response (registry order). */
export const imagePromptFamiliesSchema = z.object({
  families: z.array(imagePromptFamilyInfoSchema),
});
export type ImagePromptFamiliesValue = z.infer<typeof imagePromptFamiliesSchema>;

// ─── IPT-3: profile family set/clear + authoritative detection ─────────────

/** PUT /api/image-gen/profiles/:id/family body — the manual pin, or null
 *  to clear it back to the auto path. This route is the ONLY
 *  family-override writer (create stays unpinned; PATCH family keys strip
 *  to no-ops — route-pinned since IPT-2). */
export const setImageGenProfileFamilySchema = z.object({
  family: imagePromptFamilySchema.nullable(),
});
export type SetImageGenProfileFamilyInput = z.infer<typeof setImageGenProfileFamilySchema>;

/** The ordered detection ladder's source ids (IPT-3) — also the success
 *  response's sourceLabel. */
export const imageGenFamilyDetectionSourceSchema = z.enum([
  'backend-metadata',
  'sidecar',
  'civitai-by-hash',
  'extension-preset',
]);
export type ImageGenFamilyDetectionSourceValue = z.infer<typeof imageGenFamilyDetectionSourceSchema>;

/** One tried-and-missed source of the honest failure, in ladder order. */
export const imageGenFamilyDetectionAttemptSchema = z.object({
  source: imageGenFamilyDetectionSourceSchema,
  reason: z.string(),
});
export type ImageGenFamilyDetectionAttemptValue = z.infer<typeof imageGenFamilyDetectionAttemptSchema>;

/** POST /api/image-gen/profiles/:id/detect-family response — probe-style:
 *  a no-answer is DATA (ok:false + the ordered tried[] ladder with every
 *  miss/error recorded), never a thrown error; detection never guesses.
 *  `baseModel` is the raw authoritative label that decided (UI
 *  provenance). */
export const imageGenFamilyDetectionResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    family: imagePromptFamilySchema,
    sourceLabel: imageGenFamilyDetectionSourceSchema,
    baseModel: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    tried: z.array(imageGenFamilyDetectionAttemptSchema),
  }),
]);
export type ImageGenFamilyDetectionResultValue = z.infer<typeof imageGenFamilyDetectionResultSchema>;
