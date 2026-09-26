import { z } from 'zod';

/**
 * Fly Tribunal («Мушиный суд») contracts — FLY_TRIBUNAL_PLAN FT-2.
 *
 * Wire shapes for the precedence-learning swipe court: tribunal settings
 * (GET/PUT /api/fly/settings), the brain manifest served with the connectome
 * binary (GET /api/fly/brain/manifest — mirrors the artifact emitted by
 * `scripts/build-fly-connectome.ts`), and the persisted memory payload
 * (GET/PUT /api/fly/memory/:scope — gzipped sparse weight deltas from the
 * binary's baseline plus the confirmed-precedent count).
 *
 * The regenerate `steeringNote` lives in `chat-regenerate-schema.ts` (the
 * override contract it extends); its length bound is defined HERE so the fly
 * module owns all its constants.
 */

// ─── Constants (single source) ────────────────────────────────────────────────

/**
 * Gate: confirmed precedents required before ANY text verdict fires
 * (owner decision 2026-09-26 — «порог давай 25»). Below it the judge is
 * silent (training feedback only); at it verdict tiers unlock with the
 * milestone toast. One constant, one place — modal counter, toast trigger
 * and worker silence check all read this.
 */
export const FLY_TRIBUNAL_PRECEDENT_GATE = 25;

/** «суд устал» auto-swipe retry-cap bounds (owner: offered 1–3, default 2). */
export const FLY_TRIBUNAL_REGEN_CAP_MIN = 1;
export const FLY_TRIBUNAL_REGEN_CAP_MAX = 3;

/** Mandatory placeholder inside every hint template (rendered with the
 *  offending span/evidence text at FT-13). */
export const FLY_HINT_PLACEHOLDER = '{detected}';
export const FLY_HINT_TEMPLATE_MAX_LENGTH = 300;
export const FLY_HINT_LIST_MAX = 8;

/** Max length of a regenerate `steeringNote` (prompt-hygiene bound). */
export const FLY_STEERING_NOTE_MAX_LENGTH = 500;

/** Max base64 length of the persisted weights blob (sparse deltas —
 *  kilobytes; generous ceiling, ~384 KB of decoded bytes). */
export const FLY_WEIGHTS_MAX_BASE64_LENGTH = 512_000;

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/**
 * Reaction ladder (indication-first; all tiers locked behind the gate).
 * `indication` = fly states + highlight + verdict panel (v1 default);
 * `hint` = indication + steering-note hint on swipe (v2);
 * `auto` = hint + auto-swipe behind its own higher confidence bar (v2,
 * off by default — selecting it is the opt-in).
 */
export const flyReactionTierSchema = z.enum(['indication', 'hint', 'auto']);
export type FlyReactionTier = z.infer<typeof flyReactionTierSchema>;

/** «чуткость» — when verdicts fire at all (liberal flagging tier). */
export const flySensitivitySchema = z.enum(['soft', 'normal', 'strict']);
export type FlySensitivity = z.infer<typeof flySensitivitySchema>;

/** Training speed — plasticity/decay rate multiplier tier. */
export const flyTrainingSpeedSchema = z.enum(['slow', 'normal', 'fast']);
export type FlyTrainingSpeed = z.infer<typeof flyTrainingSpeedSchema>;

/**
 * «порог уверенности автосвайпа» — the SEPARATE, higher bar auto-swipe alone
 * must clear (owner decision 2026-09-26 #14). Independent of «чуткость»;
 * the control is visible only for the `auto` tier (UI concern, stored
 * regardless so tier switching never loses the pick).
 */
export const flyAutoSwipeConfidenceSchema = z.enum(['normal', 'high', 'very-high']);
export type FlyAutoSwipeConfidence = z.infer<typeof flyAutoSwipeConfidenceSchema>;

/** «жизнь прецедентов» in days; `null` = ∞ (no decay). */
export const flyPrecedentLifetimeSchema = z.union([
  z.literal(7),
  z.literal(14),
  z.literal(30),
  z.null(),
]);
export type FlyPrecedentLifetime = z.infer<typeof flyPrecedentLifetimeSchema>;

/** Memory scope — per-chat (default) or global; switching = relearn. */
export const flyMemoryScopeSchema = z.enum(['chat', 'global']);
export type FlyMemoryScope = z.infer<typeof flyMemoryScopeSchema>;

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * One hint template — plain text that MUST contain `{detected}` (FT-13
 * renders the placeholder with the matched-evidence text). An empty list is
 * valid: the settings UI seeds localized default copy on first open (Wave 4)
 * and a user may delete every template.
 */
export const flyHintTemplateSchema = z
  .string()
  .min(1)
  .max(FLY_HINT_TEMPLATE_MAX_LENGTH)
  .refine((t) => t.includes(FLY_HINT_PLACEHOLDER), {
    message: `hint template must contain ${FLY_HINT_PLACEHOLDER}`,
  });
export type FlyHintTemplate = z.infer<typeof flyHintTemplateSchema>;

/**
 * The whole tribunal settings object (GET response + PUT body — clients send
 * the complete form state; every field carries its default so a fresh
 * install parses `{}` into the shipped defaults below).
 *
 * Defaults are owner decisions (FLY_TRIBUNAL_RESEARCH decisions log):
 * feature off until enabled, indication tier, cap 2, обычная чуткость,
 * высокий auto-swipe bar, training on, lifetime 14 days, per-chat memory.
 */
export const flyTribunalSettingsSchema = z.object({
  /** Tribunal row toggle; the UI refuses enable without a cached brain. */
  enabled: z.boolean().default(false),
  reactionTier: flyReactionTierSchema.default('indication'),
  /** «суд устал» — auto-swipe retry cap for one message. */
  regenCap: z
    .number()
    .int()
    .min(FLY_TRIBUNAL_REGEN_CAP_MIN)
    .max(FLY_TRIBUNAL_REGEN_CAP_MAX)
    .default(2),
  sensitivity: flySensitivitySchema.default('normal'),
  autoSwipeConfidence: flyAutoSwipeConfidenceSchema.default('high'),
  /** «обучаться на свайпах» — off = the fly observes but never plasticizes. */
  trainingEnabled: z.boolean().default(true),
  trainingSpeed: flyTrainingSpeedSchema.default('normal'),
  /** Days before a precedent decays toward baseline; `null` = ∞. */
  precedentLifetimeDays: flyPrecedentLifetimeSchema.default(14),
  hints: z.array(flyHintTemplateSchema).max(FLY_HINT_LIST_MAX).default([]),
  memoryScope: flyMemoryScopeSchema.default('chat'),
});
export type FlyTribunalSettings = z.infer<typeof flyTribunalSettingsSchema>;

// ─── Brain manifest ───────────────────────────────────────────────────────────

/**
 * Wire twin of `services/api/assets/fly/fly-brain-manifest.json` (emitted by
 * `scripts/build-fly-connectome.ts`, FT-1). The client (Wave 3 brain loader)
 * verifies the downloaded binary against `binary.sha256`, shows
 * `binary.sizeBytes` as MB in the progress UI, renders `source.attribution`
 * (CC-BY 4.0), and hands `groups` to the worker's binary parser.
 */
export const flyBrainManifestSchema = z.object({
  format: z.literal('fly-brain-manifest/1'),
  generatedAt: z.string(),
  generator: z.string(),
  source: z.object({
    dataset: z.string(),
    version: z.string(),
    access: z.string(),
    license: z.string(),
    attribution: z.string(),
  }),
  binary: z.object({
    file: z.string(),
    formatVersion: z.number().int().nonnegative(),
    /** Lowercase hex sha256 of the connectome binary. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive(),
    neuronCount: z.number().int().positive(),
    edgeCount: z.number().int().positive(),
  }),
  weights: z.object({
    unit: z.string(),
    aggregation: z.string(),
    excitatory: z.array(z.string()),
    inhibitory: z.array(z.string()),
    unknownDefaultsTo: z.string(),
  }),
  groups: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      name: z.string(),
      region: z.string(),
    }),
  ),
  countsByGroup: z.record(z.string(), z.number().int().nonnegative()),
  /** Per-neuron cell-type strings (evidence rendering); empty string is a
   *  valid entry (untyped OTHER neurons). */
  types: z.array(z.string()),
});
export type FlyBrainManifest = z.infer<typeof flyBrainManifestSchema>;

// ─── Memory (persisted learning state) ────────────────────────────────────────

/** Base64 of the gzipped sparse weight deltas; `null` = fresh fly (no
 *  deltas yet — amnesty/first boot). */
const weightsBlobSchema = z
  .string()
  .min(1)
  .max(FLY_WEIGHTS_MAX_BASE64_LENGTH)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'weights must be base64' });

/**
 * PUT /api/fly/memory/:scope body. `chatId` is required iff `scope` is
 * `chat` (the row's nullable-unique key: null = global). Amnesty is a
 * normal PUT with `precedentCount: 0` and `weights: null`.
 */
export const flyMemoryPutSchema = z
  .object({
    scope: flyMemoryScopeSchema,
    chatId: z.string().min(1).optional(),
    /** Learning-state blob format version (bump on encoding change). */
    schemaVersion: z.number().int().nonnegative(),
    precedentCount: z.number().int().nonnegative(),
    weights: weightsBlobSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'chat' && !v.chatId) {
      ctx.addIssue({
        code: 'custom',
        path: ['chatId'],
        message: 'chatId is required when scope is "chat"',
      });
    }
    if (v.scope === 'global' && v.chatId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['chatId'],
        message: 'chatId must be absent when scope is "global"',
      });
    }
  });
export type FlyMemoryPut = z.infer<typeof flyMemoryPutSchema>;

/**
 * GET /api/fly/memory/:scope response — the put payload echoed back plus the
 * scope pair and the store's `updatedAt`. A missing row is served as the
 * fresh-fly shape (`precedentCount: 0`, `weights: null`), never a 404.
 */
export const flyMemoryGetResponseSchema = z
  .object({
    scope: flyMemoryScopeSchema,
    chatId: z.string().optional(),
    schemaVersion: z.number().int().nonnegative(),
    precedentCount: z.number().int().nonnegative(),
    weights: weightsBlobSchema.nullable(),
    updatedAt: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'chat' && !v.chatId) {
      ctx.addIssue({
        code: 'custom',
        path: ['chatId'],
        message: 'chatId is required when scope is "chat"',
      });
    }
  });
export type FlyMemoryGetResponse = z.infer<typeof flyMemoryGetResponseSchema>;
