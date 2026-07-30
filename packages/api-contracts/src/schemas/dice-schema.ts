/**
 * Strict Dice request/result Zod schemas (DICE_SYSTEM_BACKEND_PLAN, Wave B1).
 *
 * Mirrors the domain envelope (`@vibe-tavern/domain` entities + the pure `dice`
 * kernel) with the server-authoritative validation rules: bounded
 * arrays/strings/numbers, per-face arithmetic, duplicate-id rejection,
 * strict-vs-narrative adjudication rules, attempt/final consistency, and the
 * script-provided retry-reason/policy string channel. The client never submits
 * authoritative faces/totals; these schemas validate the authoritative result
 * the SERVER produces (and defends against VM/script drift) plus the thin
 * request/update shapes clients send.
 *
 * Partial-update schemas (set-included / choose-final) intentionally carry NO
 * defaults — they are pure patches, mirroring `updateScriptSchema`'s contract
 * so a PATCH cannot silently reset an unmentioned key.
 */

import { z } from "zod";

// ─── Enums (canonical — mirror packages/domain/src/platform-constants.ts) ────

/** Runtime contract of a script. Defaults to `prompt` for every legacy row. */
export const scriptKindSchema = z.enum(["prompt", "dice"]);

export const diceModeSchema = z.enum(["normal", "immersive"]);
export const diceActorTypeSchema = z.enum(["persona", "character"]);
export const diceResolutionSchema = z.enum(["strict", "narrative"]);
export const diceFinalizationPolicySchema = z.enum([
  "replace",
  "keep_best",
  "keep_worst",
  "choose",
]);
export const diceFaceShapeSchema = z.enum(["d4", "d6", "d8", "d10", "d12", "d20", "d%"]);

// ─── Bounds (mirror domain DICE_* bounds) ────────────────────────────────────

export const DICE_SCHEMA_MAX_DICE_COUNT = 32;
export const DICE_SCHEMA_MAX_SIDES = 100;
export const DICE_SCHEMA_MAX_STRING = 500;
export const DICE_SCHEMA_MAX_ATTEMPTS = 20;

const nonEmptyString = z.string().min(1).max(DICE_SCHEMA_MAX_STRING);
const boundedLabel = z.string().max(DICE_SCHEMA_MAX_STRING);
/** A validated face value: integer in `[1..max sides]`. */
const faceValueSchema = z.number().int().min(1).max(DICE_SCHEMA_MAX_SIDES);

// ─── Attempt ─────────────────────────────────────────────────────────────────

/**
 * One authorized roll of a check. The per-face arithmetic
 * (`subtotal === sum(faces)`, `total === subtotal + modifier`) is enforced
 * here via `superRefine` so a fabricated or drifted tuple is rejected before
 * persistence regardless of who produced it.
 */
export const diceAttemptSchema = z
  .object({
    attemptId: nonEmptyString,
    faces: z.array(faceValueSchema).min(1).max(DICE_SCHEMA_MAX_DICE_COUNT),
    modifier: z.number().int(),
    subtotal: z.number().int(),
    total: z.number().int(),
    /** Script-provided reason this extra attempt was granted (Immersive only). */
    grantReason: boundedLabel.optional(),
    /** True on the attempt finalized as the result (choose policy). */
    chosenFinal: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    let sum = 0;
    for (const f of a.faces) sum += f;
    if (a.subtotal !== sum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtotal"],
        message: `subtotal ${a.subtotal} must equal sum(faces) ${sum}`,
      });
    }
    if (a.total !== a.subtotal + a.modifier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total"],
        message: `total ${a.total} must equal subtotal ${a.subtotal} + modifier ${a.modifier}`,
      });
    }
  });

// ─── Actor snapshot / final ──────────────────────────────────────────────────

export const diceActorSnapshotSchema = z.object({
  actorType: diceActorTypeSchema,
  actorId: nonEmptyString,
  actorLabel: boundedLabel,
});

export const diceRollFinalSchema = z.object({
  total: z.number().int(),
  outcome: boundedLabel.optional(),
  degree: boundedLabel.optional(),
  constraint: boundedLabel.optional(),
});

// ─── Roll snapshot (the immutable, message-bindable unit) ────────────────────

/**
 * The authoritative Dice result. Cross-field rules enforced via `superRefine`:
 *  - no duplicate attempt ids within `attempts`;
 *  - `finalAttemptId` (when set) must reference an existing attempt;
 *  - strict resolution REQUIRES `final.outcome`; narrative resolution FORBIDS it;
 *  - `choose` policy requires exactly one `chosenFinal` attempt matching
 *    `finalAttemptId`.
 */
export const diceRollSnapshotSchema = z
  .object({
    rollId: nonEmptyString,
    requestId: nonEmptyString,
    actor: diceActorSnapshotSchema,
    scriptId: nonEmptyString,
    scriptLabel: boundedLabel,
    scriptRevision: z.number().int().min(0),
    checkId: nonEmptyString,
    checkLabel: boundedLabel,
    notation: nonEmptyString,
    faceShape: diceFaceShapeSchema,
    resolution: diceResolutionSchema,
    mode: diceModeSchema,
    /** Immersive include/exclude-from-binding (server-persisted, with undo). */
    included: z.boolean(),
    /** The attempt id chosen as the final result, or null while unchosen. */
    finalAttemptId: z.string().min(1).nullable(),
    attempts: z.array(diceAttemptSchema).min(1).max(DICE_SCHEMA_MAX_ATTEMPTS),
    /** Present on strict checks; always absent on narrative checks. */
    final: diceRollFinalSchema.optional(),
    /** Script-provided retry reason/policy channel (e.g. "Second chance: Lucky"). */
    retryReason: boundedLabel.optional(),
    policy: diceFinalizationPolicySchema.optional(),
    /** Set when the result binds to a committed user message; null/absent while pending. */
    boundMessageId: z.string().min(1).nullable().optional(),
    createdAt: z.string().min(1),
  })
  .superRefine((r, ctx) => {
    // Duplicate attempt ids are rejected outright.
    const ids = new Set<string>();
    for (const a of r.attempts) {
      if (ids.has(a.attemptId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attempts"],
          message: `duplicate attemptId "${a.attemptId}"`,
        });
      }
      ids.add(a.attemptId);
    }
    // finalAttemptId must point at a real attempt when set.
    if (r.finalAttemptId !== null && !ids.has(r.finalAttemptId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalAttemptId"],
        message: `finalAttemptId "${r.finalAttemptId}" does not match any attempt`,
      });
    }
    // Strict/narrative adjudication rules.
    if (r.resolution === "strict") {
      if (!r.final || r.final.outcome === undefined || r.final.outcome === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["final", "outcome"],
          message: "strict resolution requires a non-empty final.outcome",
        });
      }
    } else {
      // narrative: no authoritative outcome (mechanical facts only).
      if (r.final && r.final.outcome !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["final", "outcome"],
          message: "narrative resolution must not carry an authoritative outcome",
        });
      }
    }
    // choose policy: exactly one chosen attempt, matching finalAttemptId.
    if (r.policy === "choose") {
      const chosen = r.attempts.filter((a) => a.chosenFinal === true);
      if (chosen.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attempts"],
          message: "choose policy requires exactly one chosenFinal attempt",
        });
      } else if (r.finalAttemptId !== chosen[0].attemptId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finalAttemptId"],
          message: "finalAttemptId must match the chosenFinal attempt",
        });
      }
    }
  });

// ─── Request (POST /roll body) ───────────────────────────────────────────────
//
// The client never submits authoritative faces/totals — it only identifies the
// check, actor, mode, and a DB-unique idempotency key. The server rolls.

export const diceRollRequestSchema = z.object({
  scriptId: nonEmptyString,
  checkId: nonEmptyString,
  actorType: diceActorTypeSchema,
  actorId: nonEmptyString,
  mode: diceModeSchema,
  /** DB-unique idempotency key: rapid clicks/retries/two tabs cannot dup a roll. */
  requestId: nonEmptyString,
});

// ─── Partial-update schemas (NO defaults — pure patches) ─────────────────────

/** Immersive include/exclude-from-binding (undo via `included: true`). */
export const diceSetIncludedSchema = z.object({
  included: z.boolean(),
});

/** Finalize a `choose`-policy attempt; send is blocked until one exists. */
export const diceChooseFinalSchema = z.object({
  attemptId: nonEmptyString,
});

// ─── Check descriptor / definitions response ─────────────────────────────────

/** One resolvable check published by a Dice script (GET /definitions, per-check). */
export const diceCheckDescriptorSchema = z.object({
  id: nonEmptyString,
  label: boundedLabel,
  notation: nonEmptyString,
  actors: z.array(diceActorTypeSchema).min(1),
  resolution: diceResolutionSchema,
  faceShape: diceFaceShapeSchema,
  /** Optional short rule help shown in the composer tray (F8). Absent when the
   *  script did not register help; bounded to DICE_SCHEMA_MAX_STRING. */
  help: boundedLabel.optional(),
});

/** A script's checks for one chat (GET /definitions, grouped by script). */
export const diceScriptDefinitionsSchema = z.object({
  scriptId: nonEmptyString,
  scriptLabel: boundedLabel,
  scriptRevision: z.number().int().min(0),
  checks: z.array(diceCheckDescriptorSchema),
});

/**
 * The GET /definitions response. Rejects a duplicate check `id` anywhere across
 * the whole response (within one script or across scripts) — a check id must
 * resolve to one descriptor per chat.
 */
export const diceDefinitionsResponseSchema = z
  .object({
    scripts: z.array(diceScriptDefinitionsSchema),
  })
  .superRefine((d, ctx) => {
    const ids = new Set<string>();
    for (const s of d.scripts) {
      for (const c of s.checks) {
        if (ids.has(c.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scripts"],
            message: `duplicate check id "${c.id}"`,
          });
        }
        ids.add(c.id);
      }
    }
  });
