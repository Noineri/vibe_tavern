import { z } from "zod";
import { scriptKindSchema, diceFaceShapeSchema, diceResolutionSchema, diceCheckDescriptorSchema } from "./dice-schema.js";
import { experienceDefinitionSchema } from "./interactive-schema.js";

// ─── Link management ─────────────────────────────────────────────────────────
// One owner binding: since migration 0107 (LORE_SCRIPT_OWNERS_AS_LINKS) a
// script's ONLY owners are these link rows — there is no home-owner column.
// Mirrors `lorebookLinkSchema`; defined before the create schema because
// `createScriptSchema.links` consumes it (module-init order).

export const scriptLinkSchema = z.object({
  targetType: z.enum(["character", "persona"]),
  targetId: z.string().min(1),
});

export const createScriptSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  code: z.string().optional().default(""),
  /** Runtime contract; defaults to `prompt` so legacy creates are unchanged. */
  scriptKind: scriptKindSchema.optional().default("prompt"),
  /** Server-idempotent creation key (optional). A duplicate returns the
   *  existing script. NOT mutable content: absent from updateScriptSchema. */
  creationIntentId: z.string().min(1).max(500).optional(),
  scopeType: z.string(),
  /** Explicit owner list (LORE_SCRIPT_OWNERS_AS_LINKS step 2): the link rows
   *  written at create. Empty/omitted = unbound — the API never derives an
   *  owner from context; the deprecated `characterId`/`personaId` inputs were
   *  removed with it. */
  links: z.array(scriptLinkSchema).optional().default([]),
  chatId: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  sortOrder: z.number().optional().default(0),
  /** Provenance stamp for import-side creations (SCRIPT_SAFETY_PLAN
   *  decision 9): the ONLY client-settable value is `"imported"` — the
   *  mini-app file-import path rides `createScript`; omitting it means an
   *  in-app creation (`"in_app"` server-side default). Read-only afterwards —
   *  absent from updateScriptSchema; an imported create always arrives
   *  disabled regardless of `enabled`. */
  origin: z.literal("imported").optional(),
});

export const updateScriptSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  code: z.string().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().optional(),
  /** Default visual paired with an interactive experience. Set by the creation
   *  wizard after both assets exist; null clears it. Not a source revision —
   *  does not affect trust/enabled state. */
  defaultVisualId: z.string().nullable().optional(),
  /** Copilot profile assigned to the experience (EXPERIENCE_COPILOT_PROFILES_PLAN,
   *  CP-6). Null unassigns (reverts to the built-in seed). Soft link — the
   *  resolver falls back to the built-in seed for a dangling id. */
  copilotProfileId: z.string().nullable().optional(),
});

/** Reassign a script's scope atomically (PR-6 binding). Clears stale FKs.
 *  `ownerId` is omitted/null for 'global'. */
export const setScriptScopeSchema = z.object({
  scopeType: z.enum(['global', 'entity', 'chat']),
  ownerId: z.string().nullable().optional(),
});

export const testScriptSchema = z.object({
  /** Optional unsaved authoring buffer. Test-only override; never persisted. */
  code: z.string().optional(),
  /** Simulated chat messages for test execution */
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional().default([]),
  /** Character name for test context */
  characterName: z.string().optional().default("Assistant"),
  /** Character personality for test context */
  characterPersonality: z.string().optional().default(""),
  /** Character scenario for test context */
  characterScenario: z.string().optional().default(""),
  /** Persona name — when provided, exposed as `context.persona.name` (P3) */
  personaName: z.string().optional(),
  /** Persona description — exposed as `context.persona.description` (P3) */
  personaDescription: z.string().optional(),
  /** Last message text (shorthand for messages[messages.length-1]) */
  lastMessage: z.string().optional().default(""),
  /** Import-warning acknowledgement (SCRIPT_SAFETY_PLAN decision 14): set by
   *  the web warning modal — the ONLY way an imported never-enabled script may
   *  execute in the test panel. Absent ⇒ the server refuses untrusted scripts
   *  with the typed `script_not_enabled` error. */
  warningAcknowledged: z.boolean().optional(),
});;

export const importScriptSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("js"),
    code: z.string().min(1),
    name: z.string().optional(),
    scriptKind: scriptKindSchema.optional().default("prompt"),
    scopeType: z.string().optional().default("entity"),
    chatId: z.string().optional(),
  }),
  z.object({
    format: z.literal("json"),
    jsonText: z.string().min(1),
    scriptKind: scriptKindSchema.optional().default("prompt"),
    scopeType: z.string().optional().default("entity"),
    chatId: z.string().optional(),
  }),
]);

// ─── Link management ─────────────────────────────────────────────────────────
// A script can be M:N bound to characters and personas; the link rows ARE the
// owner bindings (mirrors lorebookLinkSchema / setLorebookLinksSchema).

export const setScriptLinksSchema = z.object({
  links: z.array(scriptLinkSchema),
});

/** Body for POST /api/scripts/:scriptId/visuals — bind a visual to a script. */
export const bindScriptVisualSchema = z.object({
  visualId: z.string().min(1),
});

// ─── Script test result (POST /scripts/:scriptId/test) ───────────────────────
// Mirrors the backend's PromptScriptTestResult / DiceScriptTestResult /
// ScriptTestResult (services/api/.../script-test-service.ts). Discriminated by
// `kind` so the frontend test panel dispatches on scriptKind. These are
// RESPONSE schemas; the request body is `testScriptSchema` above.

export const scriptTestInjectedMessageSchema = z.object({
  content: z.string(),
  role: z.enum(["system", "user", "assistant"]),
});

export const scriptTestConsoleEntrySchema = z.object({
  level: z.enum(["log", "warn", "error"]),
  args: z.string(),
});

export const scriptTestErrorSchema = z.object({
  scriptId: z.string(),
  scriptName: z.string(),
  error: z.string(),
  line: z.number().optional(),
});

export const promptScriptTestResultSchema = z.object({
  personality: z.string(),
  scenario: z.string(),
  state: z.record(z.string(), z.unknown()),
  injectedMessages: z.array(scriptTestInjectedMessageSchema),
  console: z.array(scriptTestConsoleEntrySchema),
  shared: z.record(z.string(), z.unknown()),
  errors: z.array(scriptTestErrorSchema),
});

export const diceSampleRollResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    faces: z.array(z.number()),
    modifier: z.number(),
    subtotal: z.number(),
    total: z.number(),
    final: z.object({
      total: z.number(),
      outcome: z.string().optional(),
      degree: z.string().optional(),
      constraint: z.string().optional(),
    }).optional(),
    retryReason: z.string().optional(),
    policy: z.string().optional(),
    grantReason: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export const diceSampleRollSchema = z.object({
  checkId: z.string(),
  checkLabel: z.string(),
  notation: z.string(),
  faceShape: diceFaceShapeSchema,
  resolution: diceResolutionSchema,
  result: diceSampleRollResultSchema,
});

export const diceScriptTestResultSchema = z.object({
  /** Validated check descriptors from discovery. */
  checks: z.array(diceCheckDescriptorSchema),
  /** One deterministic sample roll per valid check (first allowed actor). */
  sampleRolls: z.array(diceSampleRollSchema),
  /** Discovery VM error (syntax/runtime/timeout); null when clean. */
  discoveryError: z.string().nullable(),
});

/** Interactive-script test result (Wave 1 IR-12 sandbox discovery). Mirrors the
 *  dice discovery shape: the validated definition when registration succeeded,
 *  plus a nullable discovery error. Full action-sequence testing arrives in
 *  Wave 8 (InteractiveTester). */
export const interactiveScriptTestResultSchema = z.object({
  /** Discovered definition when registration succeeded; null on error. */
  definition: experienceDefinitionSchema.nullable(),
  /** Registration/discovery VM error (syntax/runtime/timeout/missing-method); null when clean. */
  discoveryError: z.string().nullable(),
});

export const scriptTestResultSchema = z.discriminatedUnion("kind", [
  promptScriptTestResultSchema.extend({ kind: z.literal("prompt") }),
  diceScriptTestResultSchema.extend({ kind: z.literal("dice") }),
  interactiveScriptTestResultSchema.extend({ kind: z.literal("interactive") }),
]);

export type ScriptTestResult = z.infer<typeof scriptTestResultSchema>;
export type PromptScriptTestResult = z.infer<typeof promptScriptTestResultSchema>;
export type DiceScriptTestResult = z.infer<typeof diceScriptTestResultSchema>;
export type DiceSampleRoll = z.infer<typeof diceSampleRollSchema>;
export type InteractiveScriptTestResult = z.infer<typeof interactiveScriptTestResultSchema>;
