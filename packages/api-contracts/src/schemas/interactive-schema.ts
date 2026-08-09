/**
 * Strict Interactive Runtime Zod schemas (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 1 / IR-11).
 *
 * Mirrors the canonical domain envelopes (`@vibe-tavern/domain` entities + the
 * `EXPERIENCE_*` constants) with the server-authoritative validation rules:
 * bounded JSON depth/size, bounded ids/labels/arrays/numbers, per-viewer
 * action/transition/effect envelopes, and the request/response shapes for the
 * session lifecycle. The host never trusts a script's returned transition merely
 * because it came from the VM — every boundary is validated here (and again in
 * the kernel, IR-12) before persistence or visual delivery.
 *
 * The bounded-JSON guard (`jsonBoundsError`) is exported as a standalone pure
 * function so the synchronous kernel (IR-12) can reuse the exact same depth +
 * size + JSON-round-trip enforcement without coupling to Zod.
 *
 * Convention follows dice-schema.ts: canonical enum literals mirror
 * platform-constants.ts exactly; request/update schemas carry NO defaults unless
 * a field is genuinely optional; cross-field rules use `superRefine`.
 */

import { z } from "zod";

// ─── Enums (canonical — mirror packages/domain/src/platform-constants.ts) ────

export const experienceCapabilitySchema = z.enum([
  "participants",
  "deterministic_random",
  "model",
  "rp_context",
  "rp_attachment",
]);

export const experienceControllerSchema = z.enum(["human", "script", "model"]);

export const experienceViewerKindSchema = z.enum([
  "human",
  "script",
  "model",
  "observer",
]);

export const experienceSessionStatusSchema = z.enum([
  "active",
  "completed",
  "interrupted",
]);

/**
 * Reducer-output session status — a deliberate subset of session status: a
 * reducer may keep the game `active` or end it `completed`. `interrupted` is
 * host-only (an explicit user end recorded as a system transition), so a script
 * returning it is rejected before persistence.
 */
export const experienceReducerStatusSchema = z.enum(["active", "completed"]);

export const experienceEventVisibilitySchema = z.enum(["public", "private"]);

export const experienceEffectStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

export const experienceEffectKindSchema = z.enum(["model"]);

export const experienceContextModeSchema = z.enum([
  "none",
  "current_branch",
  "recent",
  "summaries_recent",
  "compact_summary",
]);

export const experienceStarterKindSchema = z.enum(["rules", "visual"]);

// ─── Bounds ──────────────────────────────────────────────────────────────────
//
// Centralized limits mirrored by the kernel (IR-12) and the persistence layer
// (Wave 2). States/views/payloads are bounded JSON (depth + serialized size);
// ids/labels are bounded strings; action/event/participant arrays are bounded.

/** Max serialized length of a short id (manifest id, participant id, action type). */
export const INTERACTIVE_SCHEMA_MAX_ID = 100;
/** Max serialized length of a human-facing label. */
export const INTERACTIVE_SCHEMA_MAX_LABEL = 200;
/** Max serialized length of a free-form bounded string (reason, message, description). */
export const INTERACTIVE_SCHEMA_MAX_STRING = 2000;
/** Max serialized length of a request id (idempotency key). */
export const INTERACTIVE_SCHEMA_MAX_REQUEST_ID = 200;
/** Max JSON nesting depth for state/view/payload values. */
export const INTERACTIVE_SCHEMA_MAX_DEPTH = 12;
/** Max serialized size (bytes) of authoritative/projected state. */
export const INTERACTIVE_SCHEMA_MAX_STATE_BYTES = 256 * 1024;
/** Max serialized size (bytes) of an action payload / event detail / effect request. */
export const INTERACTIVE_SCHEMA_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Max serialized size (bytes) of an action descriptor's payloadSchema. */
export const INTERACTIVE_SCHEMA_MAX_PAYLOAD_SCHEMA_BYTES = 16 * 1024;
/** Max depth for an action descriptor's payloadSchema (descriptions, not state). */
export const INTERACTIVE_SCHEMA_MAX_PAYLOAD_SCHEMA_DEPTH = 6;
/** Max legal actions returned by one `actions()` projection. */
export const INTERACTIVE_SCHEMA_MAX_ACTIONS = 64;
/** Max events emitted by one transition. */
export const INTERACTIVE_SCHEMA_MAX_EVENTS = 128;
/** Max participants on one session. */
export const INTERACTIVE_SCHEMA_MAX_PARTICIPANTS = 16;
/** Max declared/granted capabilities. */
export const INTERACTIVE_SCHEMA_MAX_CAPABILITIES = 8;
/** Max durable effects requested by one transition. */
export const INTERACTIVE_SCHEMA_MAX_EFFECTS = 16;
/** Upper bound on a monotonic revision / frontier integer. */
export const INTERACTIVE_SCHEMA_MAX_REVISION = 1_000_000_000;

const boundedId = z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_ID);
const boundedLabel = z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_LABEL);
const boundedString = z.string().max(INTERACTIVE_SCHEMA_MAX_STRING);
const boundedRequestId = z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_REQUEST_ID);
const boundedRevision = z.number().int().min(0).max(INTERACTIVE_SCHEMA_MAX_REVISION);

// ─── Bounded JSON guard ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate that `value` is JSON-safe, nests no deeper than `maxDepth`, and
 * serializes to no more than `maxBytes`. Returns a stable error reason string,
 * or `null` when valid. Pure (no I/O, no Zod) so the synchronous kernel (IR-12)
 * reuses the exact same enforcement as the wire schema. Rejects `undefined`,
 * functions, symbols, bigints, non-finite numbers, and cyclic structures — none
 * of these round-trip through `JSON.parse(JSON.stringify(…))`.
 */
export function jsonBoundsError(
  value: unknown,
  opts: { maxDepth: number; maxBytes: number },
): string | null {
  const { maxDepth, maxBytes } = opts;
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    const t = typeof v;
    if (v === null || t === "boolean") continue;
    if (t === "number") {
      if (!Number.isFinite(v)) return "non-finite number is not JSON-safe";
      continue;
    }
    if (t === "string") continue;
    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
      return `value of type ${t} is not JSON-safe`;
    }
    // Object or array: enforce depth + cycle guard before descending.
    if (d + 1 > maxDepth) {
      return `json nesting depth exceeds ${maxDepth}`;
    }
    if (seen.has(v)) {
      return "cyclic structure is not JSON-safe";
    }
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        stack.push({ v: v[i], d: d + 1 });
      }
    } else if (isPlainObject(v)) {
      for (const child of Object.values(v)) {
        stack.push({ v: child, d: d + 1 });
      }
    } else {
      return "value is not JSON-safe";
    }
  }
  // Size guard via serialization (also catches anything the walk could miss).
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "value is not JSON-serializable";
  }
  if (serialized.length > maxBytes) {
    return `json size ${serialized.length} exceeds ${maxBytes} bytes`;
  }
  return null;
}

/**
 * A `z.unknown()` refined by {@link jsonBoundsError}. Use for authoritative
 * state, projected state, action payloads, event details, and effect requests —
 * anywhere untrusted/sandbox-produced JSON must be bounded before persistence or
 * visual delivery.
 */
export function boundedJsonValue(opts: { maxDepth: number; maxBytes: number }) {
  return z.unknown().superRefine((value, ctx) => {
    const err = jsonBoundsError(value, opts);
    if (err !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }
  });
}

const boundedState = boundedJsonValue({
  maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
  maxBytes: INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
});
const boundedPayload = boundedJsonValue({
  maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
  maxBytes: INTERACTIVE_SCHEMA_MAX_PAYLOAD_BYTES,
});
const boundedPayloadSchema = boundedJsonValue({
  maxDepth: INTERACTIVE_SCHEMA_MAX_PAYLOAD_SCHEMA_DEPTH,
  maxBytes: INTERACTIVE_SCHEMA_MAX_PAYLOAD_SCHEMA_BYTES,
});

// ─── Core envelopes (mirror domain entities) ─────────────────────────────────

export const experienceManifestSchema = z.object({
  id: boundedId,
  name: boundedLabel,
});

export const experienceDeclaredCapabilitySchema = z.object({
  capability: experienceCapabilitySchema,
  reason: boundedString.optional(),
});

export const experienceParticipantSchema = z.object({
  id: boundedId,
  label: boundedLabel,
  controller: experienceControllerSchema,
});

/**
 * The viewer a `project`/`actions` call is for. A seat viewer
 * (`human`/`script`/`model`) MUST carry a `participantId`; an `observer` view
 * MUST NOT — it sees no private data and has no seat.
 */
export const experienceViewerSchema = z
  .object({
    kind: experienceViewerKindSchema,
    participantId: boundedId.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== "observer" && !v.participantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["participantId"],
        message: `${v.kind} viewer requires a participantId`,
      });
    }
    if (v.kind === "observer" && v.participantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["participantId"],
        message: "observer viewer must not carry a participantId",
      });
    }
  });

/** A pinned rules/visual source snapshot (exact id/label/revision/source/hash). */
export const experienceSourceSnapshotSchema = z.object({
  id: boundedId,
  label: boundedLabel,
  revision: z.number().int().min(0),
  source: z.string().min(1),
  sourceHash: boundedId,
});

export const experienceActionDescriptorSchema = z.object({
  type: boundedId,
  participantId: boundedId.optional(),
  label: boundedLabel.optional(),
  payloadSchema: boundedPayloadSchema.optional(),
  /** True only when the package permits free text (model controllers). */
  allowsText: z.boolean().optional(),
});

/**
 * A submitted action intention. `requestId` + `expectedRevision` are the
 * idempotency + compare-and-swap pair: a duplicate requestId returns the prior
 * result; a stale expectedRevision is rejected without writing.
 */
export const experienceActionSchema = z.object({
  type: boundedId,
  requestId: boundedRequestId,
  expectedRevision: boundedRevision,
  participantId: boundedId.optional(),
  payload: boundedPayload.optional(),
});

export const experienceEventSchema = z.object({
  visibility: experienceEventVisibilitySchema,
  type: boundedId,
  detail: boundedPayload.optional(),
});

export const experienceEffectRequestSchema = z.object({
  kind: experienceEffectKindSchema,
  request: boundedPayload,
});

/**
 * The output of `reduce`. `status` is schema-narrowed to `active`/`completed`
 * (never `interrupted`). State must round-trip as bounded JSON; events/effects
 * are bounded arrays.
 */
export const experienceTransitionSchema = z.object({
  state: boundedState,
  status: experienceReducerStatusSchema,
  events: z.array(experienceEventSchema).max(INTERACTIVE_SCHEMA_MAX_EVENTS),
  effects: z.array(experienceEffectRequestSchema).max(INTERACTIVE_SCHEMA_MAX_EFFECTS).optional(),
  message: boundedString.optional(),
});

/**
 * The per-viewer projection the visual/bridge receive: bounded projected state,
 * bounded legal actions at this revision, the revision, and session status.
 * Carries no hidden state for the viewer it was computed for.
 */
export const experienceProjectedViewSchema = z.object({
  state: boundedState,
  actions: z.array(experienceActionDescriptorSchema).max(INTERACTIVE_SCHEMA_MAX_ACTIONS),
  /** Cosmetic display data from the optional `flavor` method (best-effort; may be absent). */
  flavor: boundedPayload.optional(),
  revision: boundedRevision,
  status: experienceSessionStatusSchema,
});

// ─── Discovered definition (what register() produced) ────────────────────────
//
// Emitted only when registration succeeded: the four mandatory methods are
// present and the manifest + capabilities are valid. Method presence itself is
// enforced by the sandbox (IR-12), so this schema describes a clean discovery.

export const experienceDefinitionSchema = z.object({
  apiVersion: z.number().int().min(1),
  manifest: experienceManifestSchema,
  declaredCapabilities: z.array(experienceDeclaredCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES),
});

// ─── Starter manifest ────────────────────────────────────────────────────────
//
// Describes a copyable rules/visual starter (Wave 6/8). A starter is copied
// into user-owned source on use and is never silently rewritten later; this
// manifest is its catalog entry.

export const experienceStarterManifestSchema = z.object({
  id: boundedId,
  name: boundedLabel,
  kind: experienceStarterKindSchema,
  description: boundedString.optional(),
  /** Rules starters: the capabilities they exercise (informational). */
  capabilities: z.array(experienceCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES).default([]),
});

// ─── Session lifecycle request/response envelopes ────────────────────────────
//
// The canonical wire shapes IR-32 binds to typed Hono routes. The client never
// submits authoritative state, events, effects, or transitions — only
// identifiers, bounded settings, participant/grant choices, and action
// intentions carrying requestId + expectedRevision. The server returns the
// authoritative projected view.

/** Start a branch-scoped session. Config-driven: the rules script, visual,
 *  capability grants, and context mode come from the chat's experience config
 *  (set via the config endpoint and resolved server-side by
 *  `resolveEffectiveSetup`); the request carries only the branch, the
 *  game-specific settings, and the seat roster. Branch uniqueness (one active
 *  session per branch) is the start guard, so no request idempotency key is
 *  required — per-action idempotency uses the action's own `requestId`. */
export const experienceStartRequestSchema = z.object({
  branchId: boundedId,
  /** Initial settings passed to `create()`; defaults to `{}` when omitted so an
   *  absent setting never reaches the kernel as non-JSON-safe `undefined`. */
  settings: boundedState.default({}),
  participants: z.array(experienceParticipantSchema).max(INTERACTIVE_SCHEMA_MAX_PARTICIPANTS).default([]),
});

/** Submit one action intention (also the per-action idempotency + CAS carrier). */
export const experienceActionRequestSchema = experienceActionSchema;

/** Explicit user finish. The client pins the live revision; termination is
 * always host-owned `interrupted`, never a client-selected terminal status. */
export const experienceFinishRequestSchema = z.object({
  expectedRevision: boundedRevision,
}).strict();

/** Explicit queue/Add-later report freeze. The client must pin the exact live
 * revision; it can never silently include actions which arrived afterwards. */
export const experienceReportQueueRequestSchema = z.object({
  expectedRevision: boundedRevision,
});

/**
 * The session response: authoritative metadata plus the projected view for the
 * human viewer. Never includes hidden state for other seats, provider reasoning,
 * or the full authoritative state.
 */
export const experienceSessionResponseSchema = z.object({
  sessionId: boundedId,
  chatId: boundedId,
  branchId: boundedId,
  manifest: experienceManifestSchema,
  apiVersion: z.number().int().min(1),
  status: experienceSessionStatusSchema,
  revision: boundedRevision,
  reportFrontier: boundedRevision,
  /** Server-authoritative projected view for the human viewer. */
  view: experienceProjectedViewSchema,
  capabilityGrants: z.array(experienceCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES),
  contextMode: experienceContextModeSchema,
  participants: z.array(experienceParticipantSchema).max(INTERACTIVE_SCHEMA_MAX_PARTICIPANTS),
});

// ─── Runtime request envelopes (IR-32 routes) ───────────────────────────────

/** Scope selector for the visuals list. */
export const experienceVisualsQuerySchema = z.object({
  scopeType: z.enum(["global", "character", "persona", "chat"]),
  ownerId: boundedId.optional(),
});

/** Viewer selector for per-viewer projection reads (defaults to the human seat). */
export const experienceViewerQuerySchema = z.object({
  participantId: boundedId.optional(),
});

/** Patch a chat's experience config (the config-driven setup source). */
export const experienceConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  scriptId: boundedId.nullable().optional(),
  visualId: boundedId.nullable().optional(),
  capabilityGrants: z.array(experienceCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES).optional(),
  contextMode: experienceContextModeSchema.optional(),
  launcherVisible: z.boolean().optional(),
});

/** Create a visual resource (global or character-scoped in V1). */
export const experienceVisualCreateSchema = z.object({
  name: boundedLabel,
  source: z.string().min(1),
  apiVersion: z.number().int().min(1),
  compatibleManifestIds: z.array(boundedId).optional(),
  scopeType: z.enum(["global", "character", "persona", "chat"]).optional(),
  characterId: boundedId.optional(),
});

/** Patch a visual resource. A source edit changes the sourceHash (trust signal). */
export const experienceVisualUpdateSchema = z.object({
  name: boundedLabel.optional(),
  source: z.string().min(1).optional(),
  apiVersion: z.number().int().min(1).optional(),
  compatibleManifestIds: z.array(boundedId).optional(),
});

/** Undo to a prior revision (append-only: creates a new system revision). */
export const experienceUndoRequestSchema = z.object({
  targetRevision: boundedRevision,
});

/** Preview recalculation under candidate rules source (safe: no commit). */
export const experienceRecalculateRequestSchema = z.object({
  rulesCode: z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_STATE_BYTES),
});

// ─── DTO types (wire-only shapes; canonical envelopes come from Domain) ──────

export type ExperienceStartRequestDto = z.infer<typeof experienceStartRequestSchema>;
export type ExperienceActionDto = z.infer<typeof experienceActionSchema>;
export type ExperienceFinishRequestDto = z.infer<typeof experienceFinishRequestSchema>;
export type ExperienceReportQueueRequestDto = z.infer<typeof experienceReportQueueRequestSchema>;
export type ExperienceSessionResponseDto = z.infer<typeof experienceSessionResponseSchema>;
export type ExperienceDefinitionDto = z.infer<typeof experienceDefinitionSchema>;
export type ExperienceStarterManifestDto = z.infer<typeof experienceStarterManifestSchema>;
export type ExperienceConfigUpdateDto = z.infer<typeof experienceConfigUpdateSchema>;
export type ExperienceVisualCreateDto = z.infer<typeof experienceVisualCreateSchema>;
export type ExperienceVisualUpdateDto = z.infer<typeof experienceVisualUpdateSchema>;
export type ExperienceUndoRequestDto = z.infer<typeof experienceUndoRequestSchema>;
export type ExperienceRecalculateRequestDto = z.infer<typeof experienceRecalculateRequestSchema>;
