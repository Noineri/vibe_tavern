/**
 * Visual host bridge — wire schema (IR-61).
 *
 * The versioned MessageChannel protocol between the trusted Vibe Tavern host and
 * the isolated visual frame. This module is HOST-SIDE only (it lives in the app
 * bundle, has the module graph, and depends on zod). The frame-side
 * `VibeExperience` SDK is a separate plain-JS string (see `experience-sdk.ts`)
 * because the sandboxed iframe has no module system and an opaque origin.
 *
 * Security model (why a nonce and not an origin check):
 *   The visual iframe runs under `sandbox="allow-scripts"` WITHOUT
 *   `allow-same-origin`, so its origin is always the opaque `"null"` origin and
 *   the host cannot filter messages by `event.origin` (it is always `"null"`).
 *   Identity is therefore established by a host-generated per-session nonce:
 *   the host sends `hello { nonce }` right after transferring the port; the SDK
 *   echoes that nonce on every message; the host rejects any message whose
 *   nonce does not match the active session. This drops a stale frame from a
 *   previous session (still alive, still posting) or any foreign message. The
 *   real isolation is the sandbox (no host-DOM access, no network); the nonce is
 *   the session-binding check on top of it.
 *
 * Direction summary (matches SCRIPTED_GAMES_DESIGN.md "Host bridge"):
 *   Host → Visual: hello (handshake), state (authoritative projection),
 *                   result (committed action), error (structured), pending,
 *                   lifecycle (suspend/resume/finish/reset).
 *   Visual → Host: ready (handshake ack), action (intention + revision),
 *                   resize (content size), finish (privileged request).
 *
 * The projected-view and action-intention payloads reuse the exact
 * api-contracts shapes (`experienceProjectedViewSchema`, `experienceActionSchema`)
 * so the bridge never invents a parallel wire shape for what the backend already
 * validates — see AGENTS.md §4 (verify before workaround): the canonical shapes
 * already exist and are imported, not redeclared.
 */
import { z } from "zod";
import {
  experienceActionSchema,
  experienceProjectedViewSchema,
  experienceSessionStatusSchema,
} from "@vibe-tavern/api-contracts";
import type { ExperienceSessionStatus } from "@vibe-tavern/domain";

// ─── Protocol version ───────────────────────────────────────────────────────

/**
 * Wire protocol version. Bumped only on a breaking change to the envelope or a
 * message kind's contract. The SDK refuses `hello` messages whose `v` differs,
 * and the host refuses `ready`/`action` messages whose `v` differs, so a
 * version skew fails closed (no silent misinterpretation).
 */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

// ─── Session nonce ──────────────────────────────────────────────────────────

/** Length (bytes) of the per-session identity nonce. 16 bytes = 128 bits. */
export const BRIDGE_NONCE_BYTES = 16;

/**
 * Cryptographically-random session nonce, hex-encoded. Uses the Web Crypto
 * `crypto.getRandomValues` (available in the host browser context and in
 * happy-dom/bun:test). Never reused across sessions; never derived from
 * anything guessable. Returned hex is 32 chars for 16 bytes.
 */
export function generateSessionNonce(): string {
  const bytes = new Uint8Array(BRIDGE_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Host → Visual ──────────────────────────────────────────────────────────

export const hostHelloSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("hello"),
  nonce: z.string().min(1),
  /** The host session id (for display/telemetry only inside the frame). */
  sessionId: z.string().min(1),
  /** Revision the frame is starting from (the host's authoritative frontier). */
  initialRevision: z.number().int().min(0),
});

export const hostStateSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("state"),
  nonce: z.string().min(1),
  /** The authoritative per-viewer projection. Carries no hidden state. */
  view: experienceProjectedViewSchema,
  /**
   * The viewer this projection was computed for, so a frame that was bound to
   * one seat but is reprojected for another can re-render. Opaque to the wire
   * (bounded JSON), surfaced for the SDK's convenience.
   */
  viewer: z.unknown().optional(),
});

export const hostResultSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("result"),
  nonce: z.string().min(1),
  /** The requestId the host is acknowledging (matches the action's requestId). */
  requestId: z.string().min(1),
  /** Revision after the committed action (== view.revision of the next state). */
  revision: z.number().int().min(0),
  /** Session status after the action (lets the frame show "completed"). */
  status: experienceSessionStatusSchema,
});

/** Structured error codes. `stale_revision`/`duplicate_request` are host-side. */
export const bridgeErrorCodes = [
  "stale_revision",
  "duplicate_request",
  "invalid_action",
  "handshake_failed",
  "protocol_error",
  "session_ended",
] as const;
export type BridgeErrorCode = (typeof bridgeErrorCodes)[number];

export const hostErrorSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("error"),
  nonce: z.string().min(1),
  /** The requestId the error applies to, when the error is tied to an action. */
  requestId: z.string().min(1).optional(),
  code: z.enum(bridgeErrorCodes),
  /** Human-readable detail (already localized by the host for surfacing). */
  message: z.string().min(1),
  /** Current authoritative revision, when known, so the SDK can resync. */
  revision: z.number().int().min(0).optional(),
});

/** Pending phase the host signals to the frame (typing indicator, model effect). */
export const pendingPhaseSchema = z.enum(["idle", "typing", "effect"]);

export const hostPendingSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("pending"),
  nonce: z.string().min(1),
  phase: pendingPhaseSchema,
});

export const lifecycleEventSchema = z.enum(["suspend", "resume", "finish", "reset"]);

export const hostLifecycleSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("lifecycle"),
  nonce: z.string().min(1),
  event: lifecycleEventSchema,
});

/** The async model-seam reply returning into a realtime round (RM-5). */
export const hostModelResultSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("model_result"),
  nonce: z.string().min(1),
  seatId: z.string().min(1),
  requestId: z.string().min(1).optional(),
  /** The model's reply — DATA for the round log, never re-generated on replay. */
  result: z.unknown(),
});

export const hostToVisualSchema = z.discriminatedUnion("kind", [
  hostHelloSchema,
  hostStateSchema,
  hostResultSchema,
  hostErrorSchema,
  hostPendingSchema,
  hostLifecycleSchema,
  hostModelResultSchema,
]);

export type HostToVisual = z.infer<typeof hostToVisualSchema>;

// ─── Visual → Host ──────────────────────────────────────────────────────────

export const visualReadySchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("ready"),
  nonce: z.string().min(1),
});

export const visualActionSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("action"),
  nonce: z.string().min(1),
  /** The submitted intention. `requestId` + `expectedRevision` are CAS + lock. */
  action: experienceActionSchema,
});

export const visualResizeSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("resize"),
  nonce: z.string().min(1),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
});

export const visualFinishSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("finish"),
  nonce: z.string().min(1),
  /** Revision at which finish is requested (the host still re-validates CAS). */
  revision: z.number().int().min(0),
});

// ─── Realtime round vocabulary (RM-5) ──────────────────────────────────────

/**
 * Bridge-side bound on a committed round log. The loop's own bound is
 * structural (watchdog ticks / batched flushes); this cap only protects the
 * host from an absurd payload — the authoritative log contract lives in the
 * api-contracts commit route (RM-7).
 */
export const BRIDGE_MAX_ROUND_LOG_EVENTS = 10_000;

/** A model seat asks the host seam for a reply (SDK auto-forward, RM-5). */
export const visualModelRequestSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("model_request"),
  nonce: z.string().min(1),
  seatId: z.string().min(1),
  /** Wire correlation id (the loop logged it; the host echoes it back). */
  requestId: z.string().min(1).optional(),
  /** Author-built prompt data (opaque to the bridge; the seam interprets it). */
  prompt: z.unknown(),
});

/** The finished round, as the loop finalized it (SDK auto-forward, RM-5). */
export const visualRoundCommitSchema = z.object({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  kind: z.literal("round_commit"),
  nonce: z.string().min(1),
  /** `interrupted` is the visual-driven abandon claim ("completed" otherwise). */
  status: z.enum(["completed", "interrupted"]),
  /** The loop's final state claim — RM-8 replay-verifies it before applying. */
  finalState: z.unknown(),
  /** The ordered round-log events (bounded; opaque here, typed by RM-7). */
  log: z.array(z.unknown()).max(BRIDGE_MAX_ROUND_LOG_EVENTS),
  /** Commit metadata for the chat card (optional, visual-supplied). */
  score: z.number().optional(),
  summary: z.string().max(4000).optional(),
});

export const visualToHostSchema = z.discriminatedUnion("kind", [
  visualReadySchema,
  visualActionSchema,
  visualResizeSchema,
  visualFinishSchema,
  visualModelRequestSchema,
  visualRoundCommitSchema,
]);

export type VisualToHost = z.infer<typeof visualToHostSchema>;

// ─── Constructors (host side) ───────────────────────────────────────────────
//
// Typed builders so call sites cannot assemble a malformed host→visual message.
// Each stamps the protocol version + nonce; the discriminated union then keeps
// the payload shape honest at compile time.

/** Minimal payload every host→visual message carries. */
interface HostEnvelope {
  readonly nonce: string;
}

export function buildHello(
  env: HostEnvelope,
  sessionId: string,
  initialRevision: number,
): HostToVisual {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "hello",
    nonce: env.nonce,
    sessionId,
    initialRevision,
  };
}

export function buildState(
  env: HostEnvelope,
  view: z.infer<typeof experienceProjectedViewSchema>,
  viewer?: unknown,
): HostToVisual {
  return { v: BRIDGE_PROTOCOL_VERSION, kind: "state", nonce: env.nonce, view, viewer };
}

export function buildResult(
  env: HostEnvelope,
  requestId: string,
  revision: number,
  status: ExperienceSessionStatus,
): HostToVisual {
  return { v: BRIDGE_PROTOCOL_VERSION, kind: "result", nonce: env.nonce, requestId, revision, status };
}

export function buildError(
  env: HostEnvelope,
  code: BridgeErrorCode,
  message: string,
  detail?: { requestId?: string; revision?: number },
): HostToVisual {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "error",
    nonce: env.nonce,
    code,
    message,
    ...(detail?.requestId !== undefined ? { requestId: detail.requestId } : {}),
    ...(detail?.revision !== undefined ? { revision: detail.revision } : {}),
  };
}

export function buildPending(
  env: HostEnvelope,
  phase: "idle" | "typing" | "effect",
): HostToVisual {
  return { v: BRIDGE_PROTOCOL_VERSION, kind: "pending", nonce: env.nonce, phase };
}

export function buildLifecycle(
  env: HostEnvelope,
  event: "suspend" | "resume" | "finish" | "reset",
): HostToVisual {
  return { v: BRIDGE_PROTOCOL_VERSION, kind: "lifecycle", nonce: env.nonce, event };
}

/** Deliver an async model-seam reply back into a realtime round (RM-5). */
export function buildModelResult(
  env: HostEnvelope,
  seatId: string,
  result: unknown,
  requestId?: string,
): HostToVisual {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    kind: "model_result",
    nonce: env.nonce,
    seatId,
    result,
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

// ─── Parse entry points ─────────────────────────────────────────────────────

/**
 * Parse a message arriving on the host side. Returns the typed message or
 * `null` (never throws) so a malformed frame message can be dropped without
 * taking down the host React tree. The bridge logs + emits a structured error.
 */
export function parseVisualToHost(raw: unknown): VisualToHost | null {
  const result = visualToHostSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Parse a message arriving inside the frame (SDK side, loose). The SDK trusts
 * the host more than the host trusts the frame, but still refuses a version
 * mismatch or a nonce it does not recognise. Implemented as a plain shape check
 * (no zod in the frame) — see `experience-sdk.ts`.
 */
export function parseHostToVisualStrict(raw: unknown): HostToVisual | null {
  const result = hostToVisualSchema.safeParse(raw);
  return result.success ? result.data : null;
}
