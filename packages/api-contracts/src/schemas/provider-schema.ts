import { z } from "zod";
import { MODEL_FAVORITE_SCOPE, type SamplerFieldId } from "@vibe-tavern/domain";

/**
 * Per-sampler-field zod schema — the single source of the sampler wire surface.
 * `satisfies Record<SamplerFieldId, z.ZodTypeAny>` is the tripwire: every
 * SamplerFieldId MUST have an entry here (missing → compile error) and no key
 * may lie outside the union (typo/extra → compile error). The per-field zod
 * type is necessarily hand-assigned (number / string[] / logitBias / seed /
 * reasoningEffort differ), but the KEY SET is bound to the canonical
 * {@link SamplerFieldId} union from @vibe-tavern/domain, so it cannot drift
 * the way the former two duplicated hand-typed lists could.
 *
 * Spread into both `providerCoreSchema` and `modelSettingsOverlaySchema`
 * below. Kept as a concrete object literal (NOT widened to
 * `Record<SamplerFieldId, z.ZodTypeAny>`) so zod's inferred output type stays
 * `number` / `string[]` / etc. — spreading a widened record would erase every
 * sampler field's output type to `any`.
 */
const samplerFieldSchemas = {
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  topA: z.number().optional(),
  minP: z.number().optional(),
  typicalP: z.number().optional(),
  tfsZ: z.number().optional(),
  repeatLastN: z.number().optional(),
  mirostat: z.number().optional(),
  mirostatTau: z.number().optional(),
  mirostatEta: z.number().optional(),
  dryMultiplier: z.number().optional(),
  dryBase: z.number().optional(),
  dryAllowedLength: z.number().optional(),
  drySequenceBreakers: z.array(z.string()).optional(),
  xtcThreshold: z.number().optional(),
  xtcProbability: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  repetitionPenalty: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  logitBias: z.array(z.object({
    tokenId: z.number().int(),
    bias: z.number().min(-100).max(100),
    text: z.string().optional(),
    sourceText: z.string().optional(),
    model: z.string().optional(),
  })).optional(),
  seed: z.string().nullable().optional(),
  reasoningEffort: z.string().optional(),
} satisfies Record<SamplerFieldId, z.ZodTypeAny>;

export const testProviderDraftSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  providerType: z.string().optional(),
});

const providerCoreSchema = z.object({
  name: z.string().min(1),
  providerPreset: z.string(),
  endpoint: z.string(),
  apiKey: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  contextBudget: z.number().nullable().optional(),
  pinContextBudget: z.boolean().optional(),
  /** When true, sampler/context edits route to a per-model overlay (see modelSettingsOverlaySchema). */
  bindPerModel: z.boolean().optional(),
  maxTokens: z.number().optional(),
  // ── Sampler fields: derived from `samplerFieldSchemas` (bound to SamplerFieldId) ──
  ...samplerFieldSchemas,
  showReasoning: z.boolean().optional(),
  streamResponse: z.boolean().optional(),
  customSamplers: z.boolean().optional(),
  visionModel: z.string().nullable().optional(),
});

export const saveProviderDraftSchema = providerCoreSchema.extend({
  id: z.string().optional(),
});

export const updateProviderProfileSchema = providerCoreSchema.partial();

export const modelFavoriteScopeSchema = z.enum([MODEL_FAVORITE_SCOPE.rp, MODEL_FAVORITE_SCOPE.coauthor]);

export const favoriteProviderModelQuerySchema = z.object({
  scope: modelFavoriteScopeSchema.default(MODEL_FAVORITE_SCOPE.rp),
});

export const favoriteProviderModelSchema = z.object({
  modelId: z.string().min(1),
  label: z.string().nullable().optional(),
  contextLength: z.number().int().nullable().optional(),
  scope: modelFavoriteScopeSchema.default(MODEL_FAVORITE_SCOPE.rp),
});

/**
 * Per-model sampler/context overlay. Mirrors `ModelSettingsOverlay` from
 * @vibe-tavern/domain — every field optional (absent = inherit the profile base).
 * Identity fields are deliberately excluded; the overlay cannot rename/rebind.
 * Used for: PUT /api/providers/:id/model-settings/:modelId body validation,
 * and (via samplerPresetPayloadSchema) clipboard copy/paste validation.
 */
export const modelSettingsOverlaySchema = z.object({
  contextBudget: z.number().nullable().optional(),
  pinContextBudget: z.boolean().optional(),
  maxTokens: z.number().optional(),
  // ── Sampler fields: the same `samplerFieldSchemas` set as providerCoreSchema ──
  ...samplerFieldSchemas,
  showReasoning: z.boolean().optional(),
  streamResponse: z.boolean().optional(),
  customSamplers: z.boolean().optional(),
});

/** Body for PUT /api/providers/:id/model-settings/:modelId — the overlay directly
 *  (modelId is in the URL, so the body carries only the settings fields).
 *  Reuses modelSettingsOverlaySchema: a sampler preset IS an overlay with no identity. */
export const samplerPresetPayloadSchema = modelSettingsOverlaySchema;

export const fetchModelsSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  providerType: z.string().optional(),
});

export const testChatSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  providerType: z.string().optional(),
});

export const testChatProfileSchema = z.object({
  model: z.string(),
});

export const tokenizeSchema = z.object({
  text: z.string().min(1),
  model: z.string().optional(),
});

export const reorderProviderProfilesSchema = z.object({
  updates: z.array(z.object({
    id: z.string(),
    sortOrder: z.number(),
  })),
});
