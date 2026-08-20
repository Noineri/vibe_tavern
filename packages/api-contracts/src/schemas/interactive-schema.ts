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

export const experienceEffectKindSchema = z.enum(["model", "timer"]);

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
/** Max fields in one setup descriptor (IR-70F). */
export const INTERACTIVE_SCHEMA_MAX_SETUP_FIELDS = 32;
/** Max options in one select setup field (IR-70F). */
export const INTERACTIVE_SCHEMA_MAX_SETUP_OPTIONS = 64;
/** Max serialized length of a resolved chatter text (one model reply). */
export const INTERACTIVE_SCHEMA_MAX_CHATTER_TEXT = 4000;

const boundedId = z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_ID);
const boundedLabel = z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_LABEL);
const boundedString = z.string().max(INTERACTIVE_SCHEMA_MAX_STRING);
const boundedChatterText = z.string().max(INTERACTIVE_SCHEMA_MAX_CHATTER_TEXT);
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

const experienceParticipantFields = {
  id: boundedId,
  label: boundedLabel,
  controller: experienceControllerSchema,
  providerProfileId: boundedId.optional(),
  modelId: boundedId.optional(),
  /** User-pulled library character behind this seat (report item 6b). Optional
   *  on every seat: a label-only seat stays legal, and a character seat is only
   *  meaningful for model controllers (the strict start schema enforces that). */
  characterId: boundedId.optional(),
};

/** Persisted/response participant shape. Optional assignment fields preserve
 * legacy session compatibility; NEW starts use the stricter schema below. */
export const experienceParticipantSchema = z.object({
  ...experienceParticipantFields,
  /** Frozen character-card snapshot (report item 6b) — server-authoritative,
   * built at start; present on the response/persisted shape only, never
   * accepted from a start request. Structurally mirrors the domain's
   * ExperienceSeatCharacter. */
  character: z
    .object({
      id: boundedId,
      name: boundedLabel,
      description: z.string(),
      scenario: z.string().nullable().optional(),
      personality: z.string().nullable().optional(),
    })
    .optional(),
});

/** NEW-session participant input: model seats pin both assignment fields while
 * human/script seats carry neither. Kept separate from the response schema so
 * legacy model seats without assignments remain readable and resumable. */
export const experienceStartParticipantSchema = z
  .object(experienceParticipantFields)
  .strict()
  .superRefine((p, ctx) => {
    const isModel = p.controller === "model";
    const hasProvider = p.providerProfileId !== undefined;
    const hasModel = p.modelId !== undefined;
    const hasCharacter = p.characterId !== undefined;
    if (isModel) {
      // A model-controlled seat must pin BOTH a provider profile and a model
      // (IR-70E). Neither may be blank — `boundedId` already enforces min(1).
      if (!hasProvider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providerProfileId"],
          message: "model participant requires a providerProfileId",
        });
      }
      if (!hasModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modelId"],
          message: "model participant requires a modelId",
        });
      }
    } else {
      if (hasProvider || hasModel) {
        // A human/script seat must carry NEITHER assignment field — only model
        // seats pin a provider/model (IR-70E).
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [hasProvider ? "providerProfileId" : "modelId"],
          message: `${p.controller} participant must not carry a provider/model assignment`,
        });
      }
      if (hasCharacter) {
        // A character card is a model-seat identity layer: human/script seats
        // must not carry one (report item 6b).
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["characterId"],
          message: `${p.controller} participant must not carry a characterId`,
        });
      }
    }
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

// ─── Async flavor chatter (item 4 / ASYNC_FLAVOR_CHATTER_PLAN) ──────────────
//
// The optional `flavor(context, viewer)` method may return a declarative
// model-chatter REQUEST instead of (or alongside) static cosmetic data. This is
// the contract the HOST interprets; the kernel (`runFlavor`) stays pure — it
// only bounds the returned JSON and never inspects the marker's meaning.
//
// Parse rule: flavor output is chatter IFF it is a plain object whose top level
// carries the single meaningful key `experienceChatter` whose value matches
// `experienceChatterRequestSchema`. A plain object WITHOUT that key remains
// free-form static flavor (fully backward compatible). The host fires at most
// ONE model attempt per (session, viewer, revision) and degrades to `fallback`
// (or a host default) on any failure — chatter is cosmetic best-effort, never
// an error surface, and never touches authoritative state or the deterministic
// cursor.

/**
 * The author-authored chatter request nested under the `experienceChatter` key
 * of a flavor return. `seatId` selects the pinned model seat (IR-70E) whose
 * provider/model answers; `instructions` is the prompt hint; `fallback` is the
 * text shown while pending and on failure. The seat's provider/model are
 * resolved host-side, never trusted from the author. */
export const experienceChatterRequestSchema = z.object({
  seatId: boundedId,
  instructions: boundedString,
  fallback: boundedString.optional(),
});

/**
 * The host-normalized chatter payload carried in `flavor` once a chatter
 * request is detected. `pending` → the model call is in flight; `resolved` →
 * `text` carries the model's reply; `failed` → the call errored and `fallback`
 * (or the host default) is shown. Host-produced: never carries unknown keys. */
export const experienceChatterViewSchema = z.object({
  status: z.enum(["pending", "resolved", "failed"]),
  seatId: boundedId,
  text: boundedChatterText.optional(),
  fallback: boundedString.optional(),
});

// ─── Setup descriptor (IR-70F) ───────────────────────────────────────────────
//
// A package may declare an optional bounded setup-field list (at most 32
// fields, unique ids) so the host can render validated settings before launch
// (IR-73A). This is discovery metadata only: it adds no lifecycle method and
// does not affect runtime create/project/actions/reduce/choose/flavor. Every
// object is strict at this boundary so an author cannot smuggle unknown keys;
// cross-field rules (min<=max, default within bounds, unique ids/option values,
// select default equals an option value) are enforced here. No Zod defaults
// are fabricated inside descriptors — author omission is preserved so the host
// renders exactly what the package declared.

/** Base id/label/description shared by every setup field variant. */
const setupFieldBase = {
  id: boundedId,
  label: boundedLabel,
  description: boundedString.optional(),
};

const experienceSetupFieldTextSchema = z.object({
  ...setupFieldBase,
  kind: z.literal("text"),
  placeholder: boundedString.optional(),
  required: z.boolean().optional(),
  default: boundedString.optional(),
  minLength: z.number().int().min(0).max(INTERACTIVE_SCHEMA_MAX_STRING).optional(),
  maxLength: z.number().int().min(0).max(INTERACTIVE_SCHEMA_MAX_STRING).optional(),
}).strict();

const experienceSetupFieldNumberSchema = z.object({
  ...setupFieldBase,
  kind: z.literal("number"),
  required: z.boolean().optional(),
  default: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
}).strict();

const experienceSetupFieldBooleanSchema = z.object({
  ...setupFieldBase,
  kind: z.literal("boolean"),
  default: z.boolean().optional(),
}).strict();

/** One option of a select setup field. Value is a bounded nonblank id; label is
 *  human-facing. Strict so an option cannot carry extra keys. */
export const experienceSetupFieldOptionSchema = z.object({
  value: boundedId,
  label: boundedLabel,
}).strict();

const experienceSetupFieldSelectSchema = z.object({
  ...setupFieldBase,
  kind: z.literal("select"),
  required: z.boolean().optional(),
  default: boundedId.optional(),
  options: z
    .array(experienceSetupFieldOptionSchema)
    .min(1)
    .max(INTERACTIVE_SCHEMA_MAX_SETUP_OPTIONS),
}).strict();

/**
 * A single declared setup field, discriminated by `kind`. The four variants are
 * strict objects; the per-kind cross-field rules (min<=max, default within
 * bounds, unique option values, select default equals an option value) run in
 * the refinement below so the discriminated-union members stay plain ZodObjects.
 */
export const experienceSetupFieldSchema = z
  .discriminatedUnion("kind", [
    experienceSetupFieldTextSchema,
    experienceSetupFieldNumberSchema,
    experienceSetupFieldBooleanSchema,
    experienceSetupFieldSelectSchema,
  ])
  .superRefine((field, ctx) => {
    if (field.kind === "text") {
      const { minLength, maxLength, default: def } = field;
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minLength"],
          message: "minLength must not exceed maxLength",
        });
      }
      if (def !== undefined) {
        const len = def.length;
        if (minLength !== undefined && len < minLength) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["default"],
            message: `default length ${len} is below minLength ${minLength}`,
          });
        }
        if (maxLength !== undefined && len > maxLength) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["default"],
            message: `default length ${len} exceeds maxLength ${maxLength}`,
          });
        }
      }
      return;
    }
    if (field.kind === "number") {
      const { min, max, default: def } = field;
      if (min !== undefined && max !== undefined && min > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["min"],
          message: "min must not exceed max",
        });
      }
      if (def !== undefined) {
        if (min !== undefined && def < min) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["default"],
            message: `default ${def} is below min ${min}`,
          });
        }
        if (max !== undefined && def > max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["default"],
            message: `default ${def} exceeds max ${max}`,
          });
        }
      }
      return;
    }
    if (field.kind === "select") {
      const seen = new Set<string>();
      field.options.forEach((opt, idx) => {
        if (seen.has(opt.value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", idx, "value"],
            message: `duplicate option value "${opt.value}"`,
          });
        }
        seen.add(opt.value);
      });
      if (
        field.default !== undefined &&
        !field.options.some((opt) => opt.value === field.default)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: `select default "${field.default}" is not one of the option values`,
        });
      }
    }
  });

/** The optional setup descriptor a package may declare: a bounded field list
 *  (at most 32) with unique ids. Strict so no extra top-level keys sneak in. */
export const experienceSetupDefinitionSchema = z
  .object({
    fields: z.array(experienceSetupFieldSchema).max(INTERACTIVE_SCHEMA_MAX_SETUP_FIELDS),
  })
  .strict()
  .superRefine((setup, ctx) => {
    const seen = new Set<string>();
    setup.fields.forEach((field, idx) => {
      if (seen.has(field.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", idx, "id"],
          message: `duplicate setup field id "${field.id}"`,
        });
      }
      seen.add(field.id);
    });
  });

// ─── Discovered definition (what register() produced) ────────────────────────
//
// Emitted only when registration succeeded: the four mandatory methods are
// present and the manifest + capabilities are valid. Method presence itself is
// enforced by the sandbox (IR-12), so this schema describes a clean discovery.
// The optional `setup` (IR-70F) is normalized here when a package declares it;
// packages without one omit it and remain byte-for-byte valid.

export const experienceDefinitionSchema = z.object({
  apiVersion: z.number().int().min(1),
  manifest: experienceManifestSchema,
  declaredCapabilities: z.array(experienceDeclaredCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES),
  /** Optional package-authored setup-field descriptor (IR-70F). */
  setup: experienceSetupDefinitionSchema.optional(),
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
  participants: z.array(experienceStartParticipantSchema).max(INTERACTIVE_SCHEMA_MAX_PARTICIPANTS).default([]),
});

/** Submit one action intention (also the per-action idempotency + CAS carrier). */
export const experienceActionRequestSchema = experienceActionSchema;

/** Explicit user finish. The client pins the live revision; termination is
 * always host-owned `interrupted`, never a client-selected terminal status.
 * `quiet`: end the session WITHOUT any public report card — no `experience_finished`
 * system event, no frozen terminal attachment, and any still-unbound queued
 * attachment is dropped (nothing experience-related binds on the next message).
 * Defaults to false (the with-report finish). */
export const experienceFinishRequestSchema = z.object({
  expectedRevision: boundedRevision,
  quiet: z.boolean().optional(),
}).strict();

/** Restart as a NEW match on the same branch (lobby report LB-2/LB-3): fresh
 * session id under a new seed. Both fields optional — omitted falls back to
 * the source session's frozen snapshots; explicit values win. */
export const experienceRestartRequestSchema = z.object({
  settings: boundedState.optional(),
  participants: z.array(experienceStartParticipantSchema).max(INTERACTIVE_SCHEMA_MAX_PARTICIPANTS).optional(),
}).strict();

/** Explicit queue/Add-later report freeze. The client must pin the exact live
 * revision; it can never silently include actions which arrived afterwards. */
export const experienceReportQueueRequestSchema = z.object({
  expectedRevision: boundedRevision,
});

/**
 * The session response: authoritative metadata plus the projected view for the
 * human viewer. Never includes hidden state for other seats, provider reasoning,
 * rules source (only the revision + hash are public), or the full authoritative
 * state. The pinned visual source snapshot (IR-70G) is exposed so the client
 * renders the exact source captured at session start — not a mutable live
 * re-fetch that could drift after the resource is edited or deleted.
 */
export const experienceSessionResponseSchema = z
  .object({
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
    /** Frozen initial-settings snapshot (lobby LB-5) — the restart
     * modal's prefill source; bounded by the same limits as the start
     * settings input. Never authoritative state. */
    initialSettings: boundedState,
    /** Pinned visual resource id (snapshot at session start; no FK — survives
     *  source delete). Null when the session has no visual. */
    visualId: boundedId.nullable(),
    /** Pinned visual source snapshot (IR-70G; client-executable, contains no
     *  hidden authoritative state). Null when the session has no visual. */
    visualSource: z.string().min(1).nullable(),
    /** Hash of the pinned visual source. Null when the session has no visual. */
    visualSourceHash: boundedId.nullable(),
  })
  .superRefine((s, ctx) => {
    // Coherence (IR-70G): the three visual-pinning fields are all null
    // together (no visual) or all non-null together (pinned snapshot). A mixed
    // state is an inconsistent snapshot that a valid start never produces.
    const hasVisualId = s.visualId !== null;
    const hasSource = s.visualSource !== null;
    const hasHash = s.visualSourceHash !== null;
    if (hasVisualId !== hasSource || hasVisualId !== hasHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "visualId, visualSource, and visualSourceHash must be all null or all non-null together",
        path: ["visualId"],
      });
    }
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
  /** User-chosen RP-context source (report item 6 / Wave 3). Null clears to
   *  ambient. Character + chat are the RP-context source; the persona is the
   *  user-identity override (separate picker, PS-4). */
  contextSourceCharacterId: boundedId.nullable().optional(),
  contextSourceChatId: boundedId.nullable().optional(),
  contextSourcePersonaId: boundedId.nullable().optional(),
  capabilityGrants: z.array(experienceCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES).optional(),
  contextMode: experienceContextModeSchema.optional(),
  launcherVisible: z.boolean().optional(),
});

/** Create a visual resource (global or character-scoped in V1). Source may
 *  be empty — a saved visual can be a placeholder draft the user (or the
 *  copilot) fills in later; an empty frame simply renders blank. */
export const experienceVisualCreateSchema = z.object({
  name: boundedLabel,
  source: z.string(),
  apiVersion: z.number().int().min(1),
  compatibleManifestIds: z.array(boundedId).optional(),
  scopeType: z.enum(["global", "character", "persona", "chat"]).optional(),
  characterId: boundedId.optional(),
});

/** Patch a visual resource. A source edit changes the sourceHash (trust signal). */
export const experienceVisualUpdateSchema = z.object({
  name: boundedLabel.optional(),
  source: z.string().optional(),
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

/** Capture (or replace) the session's frozen RP-context bundle. */
export const experienceContextCaptureRequestSchema = z.object({
  mode: experienceContextModeSchema.optional(),
  providerProfileId: boundedId.optional(),
  model: boundedString.min(1).optional(),
  recentMessageLimit: z.number().int().min(1).max(1000).optional(),
  /** Per-capture source override (report item 6 / Wave 3). Null explicitly
   *  opts back into the ambient/config default. Resolution is CS-3 / PS-3. */
  contextSourceCharacterId: boundedId.nullable().optional(),
  contextSourceChatId: boundedId.nullable().optional(),
  contextSourcePersonaId: boundedId.nullable().optional(),
}).strict();

/**
 * Bounded content for a prompt-override write. A prompt override can be
 * empty (to clear it) but must not exceed the practical content size limit.
 */
export const experiencePromptOverrideContentSchema = z.object({
  content: z.string().max(100_000),
}).strict();

// ─── Stateless unsaved-source tester requests (Wave 8 / IR-81B) ──────────────
//
// Two self-contained scenarios that drive UNSAVED rules source through the real
// sandbox/kernel with zero persistence and zero chat/session/DB binding. Each
// request is an independent in-memory run; there is no server-side state between
// requests. `run` replays an ordered action list with host-managed revision /
// requestId-idempotency / expectedRevision-CAS; `simulate` auto-advances script
// seats via `choose` under host bounds. Both carry the capability grants the
// caller chose from the package's declared capabilities (granted ⊆ declared is
// enforced by the tester, mirroring the resource-service gate).

/** Max action steps a single test-run request may replay (mirrors the
 *  persistent service's MAX_SCRIPT_TURNS; kept distinct so the tester bound is
 *  visible and tunable independently). Also the default simulation bound. */
export const INTERACTIVE_SCHEMA_MAX_TEST_STEPS = 200;

/** Drive unsaved rules source through the real kernel: discover + create +
 *  project + legal actions, then replay an ordered list of action intentions
 *  (each carrying requestId + expectedRevision) with the host managing the
 *  in-memory revision counter, requestId idempotency, and expectedRevision CAS.
 *  An empty/omitted `actions` list yields a create-only preview. */
export const experienceTestRunRequestSchema = z.object({
  rulesCode: z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_STATE_BYTES),
  scriptName: boundedString.optional(),
  settings: boundedState.default({}),
  participants: z.array(experienceParticipantSchema).max(INTERACTIVE_SCHEMA_MAX_PARTICIPANTS).default([]),
  capabilityGrants: z.array(experienceCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES).default([]),
  seed: boundedString.optional(),
  actions: z.array(experienceActionSchema).max(INTERACTIVE_SCHEMA_MAX_TEST_STEPS).default([]),
});

/** Discover + create, then run a bounded automated simulation that advances
 *  script-controlled seats via the real `choose` until a human/model boundary,
 *  a terminal status, no legal action, or a host bound is reached. */
export const experienceTestSimulateRequestSchema = z.object({
  rulesCode: z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_STATE_BYTES),
  scriptName: boundedString.optional(),
  settings: boundedState.default({}),
  participants: z.array(experienceParticipantSchema).max(INTERACTIVE_SCHEMA_MAX_PARTICIPANTS).default([]),
  capabilityGrants: z.array(experienceCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES).default([]),
  seed: boundedString.optional(),
  maxIterations: z.number().int().min(1).max(INTERACTIVE_SCHEMA_MAX_TEST_STEPS).default(INTERACTIVE_SCHEMA_MAX_TEST_STEPS),
  maxEffects: z.number().int().min(1).max(1000).default(256),
});

// ─── Interactive playground requests (Wave 8 / IR-84A) ───────────────────────
//
// The interactive play loop: start creates an in-memory session (discover +
// create + project + advance leading script seats); advance applies ONE human
// action then advances script seats until the next human/model/idle boundary.
// Both reuse the real sandbox/kernel with ZERO persistence and ZERO chat/session/
// DB binding — the session lives in process memory keyed by the returned
// playground session id. Mirrors the tester request shapes (same bounds) plus a
// `humanSeatId` so the author picks the seat to drive.

/** Start an interactive playground session from unsaved-or-saved rules source.
 *  Discover + create + project the initial viewer state, then advance any
 *  leading script-controlled seats via the real `choose` until the first
 *  human/model/idle boundary. Returns the validated definition, initial state,
 *  projection, accumulated events/effects/console, revision, status, and the
 *  boundary stop-reason, plus the opaque playground session id. */
export const experiencePlaygroundStartRequestSchema = z.object({
  rulesCode: z.string().min(1).max(INTERACTIVE_SCHEMA_MAX_STATE_BYTES),
  scriptName: boundedString.optional(),
  settings: boundedState.default({}),
  participants: z.array(experienceParticipantSchema).max(INTERACTIVE_SCHEMA_MAX_PARTICIPANTS).default([]),
  capabilityGrants: z.array(experienceCapabilitySchema).max(INTERACTIVE_SCHEMA_MAX_CAPABILITIES).default([]),
  seed: boundedString.optional(),
  humanSeatId: boundedId.optional(),
});

/** Advance an interactive playground session by ONE human action, then advance
 *  script-controlled seats via the real `choose` until the next boundary.
 *  `playgroundSessionId` is the opaque handle returned by start; `humanAction`
 *  carries the requestId + expectedRevision CAS pair (idempotency precedes CAS). */
export const experiencePlaygroundAdvanceRequestSchema = z.object({
  playgroundSessionId: boundedId,
  humanAction: experienceActionSchema,
});

/** Execute ONE timer beat for an interactive playground session: fire the
 *  oldest pending timer effect (sleep its `afterMs`, then feed the tick back
 *  through the real reducer) and return the standard turn envelope. The
 *  client re-issues a beat whenever a response reports `pendingTimers > 0` on
 *  an active session — that loop is what makes real-time experiences
 *  (falling pieces, countdowns) actually tick in the sandbox. */
export const experiencePlaygroundTimerRequestSchema = z.object({
  playgroundSessionId: boundedId,
});

// ─── DTO types (wire-only shapes; canonical envelopes come from Domain) ──────

export type ExperienceStartRequestDto = z.infer<typeof experienceStartRequestSchema>;
export type ExperienceActionDto = z.infer<typeof experienceActionSchema>;
export type ExperienceFinishRequestDto = z.infer<typeof experienceFinishRequestSchema>;
export type ExperienceRestartRequestDto = z.infer<typeof experienceRestartRequestSchema>;
export type ExperienceReportQueueRequestDto = z.infer<typeof experienceReportQueueRequestSchema>;
export type ExperienceSessionResponseDto = z.infer<typeof experienceSessionResponseSchema>;
export type ExperienceDefinitionDto = z.infer<typeof experienceDefinitionSchema>;
export type ExperienceStarterManifestDto = z.infer<typeof experienceStarterManifestSchema>;
export type ExperienceConfigUpdateDto = z.infer<typeof experienceConfigUpdateSchema>;
export type ExperienceVisualCreateDto = z.infer<typeof experienceVisualCreateSchema>;
export type ExperienceVisualUpdateDto = z.infer<typeof experienceVisualUpdateSchema>;
export type ExperienceUndoRequestDto = z.infer<typeof experienceUndoRequestSchema>;
export type ExperienceRecalculateRequestDto = z.infer<typeof experienceRecalculateRequestSchema>;
export type ExperienceContextCaptureRequestDto = z.infer<typeof experienceContextCaptureRequestSchema>;
export type ExperiencePromptOverrideContentDto = z.infer<typeof experiencePromptOverrideContentSchema>;
export type ExperienceTestRunRequestDto = z.infer<typeof experienceTestRunRequestSchema>;
export type ExperienceTestSimulateRequestDto = z.infer<typeof experienceTestSimulateRequestSchema>;
export type ExperiencePlaygroundStartRequestDto = z.infer<typeof experiencePlaygroundStartRequestSchema>;
export type ExperiencePlaygroundAdvanceRequestDto = z.infer<typeof experiencePlaygroundAdvanceRequestSchema>;
export type ExperiencePlaygroundTimerRequestDto = z.infer<typeof experiencePlaygroundTimerRequestSchema>;
export type ExperienceSetupFieldOptionDto = z.infer<typeof experienceSetupFieldOptionSchema>;
export type ExperienceSetupFieldDto = z.infer<typeof experienceSetupFieldSchema>;
export type ExperienceSetupDefinitionDto = z.infer<typeof experienceSetupDefinitionSchema>;
export type ExperienceChatterRequestDto = z.infer<typeof experienceChatterRequestSchema>;
export type ExperienceChatterViewDto = z.infer<typeof experienceChatterViewSchema>;
