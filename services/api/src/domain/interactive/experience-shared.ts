/**
 * Shared types + helpers for the interactive-runtime service layer
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-31).
 *
 * The three services (resource / lifecycle / replay) share one typed-error
 * vocabulary that IR-32 maps to HTTP responses, plus a couple of pure helpers:
 * deriving a numeric snapshot revision from a source hash (scripts and visuals
 * version by hash, not a counter), and the declared⊇granted capability check
 * deferred from IR-12.
 */

import {
  EXPERIENCE_CAPABILITY,
  type ExperienceCapability,
  type ExperienceDeclaredCapability,
  type ExperienceParticipant,
} from "@vibe-tavern/domain";
import type { ExperienceCapabilityContext, ExperienceKernelError } from "./experience-kernel.js";
import type { DeterministicRandom, EphemeralRandom } from "./experience-kernel.js";

// ─── Typed errors ────────────────────────────────────────────────────────────

export type ExperienceApiError =
  // 404 — something referenced does not exist
  | { status: 404; code: "chat_not_found"; message: string }
  | { status: 404; code: "branch_not_found"; message: string }
  | { status: 404; code: "session_not_found"; message: string }
  | { status: 404; code: "no_active_session"; message: string }
  | { status: 404; code: "script_not_found"; message: string }
  | { status: 404; code: "visual_not_found"; message: string }
  | { status: 404; code: "effect_not_found"; message: string }
  // 409 — conflict with current state
  | { status: 409; code: "stale_revision"; message: string; currentRevision: number }
  | { status: 409; code: "branch_has_active"; message: string }
  | { status: 409; code: "not_enabled"; message: string }
  | { status: 409; code: "effect_not_retryable"; message: string; currentStatus: string }
  // 422 — validation / semantic rejection
  | { status: 422; code: "validation_error"; message: string }
  | { status: 422; code: "illegal_action"; message: string }
  | { status: 422; code: "capability_denied"; message: string; granted: ExperienceCapability[]; needs: ExperienceCapability[] }
  | { status: 422; code: "incompatible_visual"; message: string; manifestId: string; compatible: string[] }
  | { status: 422; code: "vm_error"; message: string; kind: string }
  | { status: 422; code: "session_not_active"; message: string; currentStatus: string }
  | { status: 422; code: "replay_failed"; message: string; failedActionIndex: number }
  | { status: 422; code: "no_choose_method"; message: string; participantId: string }
  // 500 — unexpected
  | { status: 500; code: "internal"; message: string };

export type ExperienceResult<T> = { ok: true; data: T } | { ok: false; error: ExperienceApiError };

export const ok = <T>(data: T): ExperienceResult<T> => ({ ok: true, data });
export const err = (error: ExperienceApiError): ExperienceResult<never> => ({ ok: false, error });

/** Map a kernel/sandbox failure to a typed 422 vm_error (or validation_error). */
export function fromKernelError(e: ExperienceKernelError): ExperienceApiError {
  // Discovery/validation failures are authoring-time input problems (422), not
  // runtime VM faults — surface the kernel kind so the caller can distinguish.
  if (e.kind === "invalid_definition" || e.kind === "invalid_state" || e.kind === "illegal_action") {
    return { status: 422, code: "validation_error", message: e.message };
  }
  return { status: 422, code: "vm_error", message: e.message, kind: e.kind };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Derive a stable numeric revision from a SHA-256 source hash. Scripts and
 * visuals version by hash (no revision-counter column): identical source →
 * identical revision; any edit → different hash → different revision. This is
 * the snapshot's `revision` signal used for "this session is on revision X".
 */
export function numericRevisionFromHash(sourceHash: string): number {
  return parseInt(sourceHash.slice(0, 8), 16) >>> 0;
}

/**
 * The declared⊇granted capability check deferred from IR-12. A session may only
 * grant capabilities the package declared; an undeclared grant is a 422. Returns
 * the offending capabilities (requested minus declared) when the check fails.
 */
export function undeclaredGrantedCapabilities(
  declared: readonly ExperienceDeclaredCapability[],
  granted: readonly ExperienceCapability[],
): ExperienceCapability[] {
  const declaredSet = new Set(declared.map((d) => d.capability));
  return granted.filter((c) => !declaredSet.has(c));
}

/** Whether a capability value is a recognized capability id. */
export function isValidCapability(value: string): value is ExperienceCapability {
  return (Object.values(EXPERIENCE_CAPABILITY) as readonly string[]).includes(value);
}

/**
 * Build the VM capability context from the granted capabilities + roster. This
 * is the single source of truth for the capability-gating policy: `participants`
 * and `deterministic_random` are the only V1 synchronous VM capabilities (model /
 * rp_context / rp_attachment are durable effects, Wave 4+); `chance` (ephemeral,
 * non-recorded) is pass-through, injected only into `choose`/`flavor` by the
 * caller. Shared by the lifecycle service and the replay service so live +
 * replay cannot diverge.
 */
export function buildCapabilityContext(
  grants: readonly ExperienceCapability[],
  participants: readonly ExperienceParticipant[],
  random?: DeterministicRandom,
  chance?: EphemeralRandom,
): ExperienceCapabilityContext {
  const includeParticipants = grants.includes(EXPERIENCE_CAPABILITY.participants);
  const includeRandom = random !== undefined && grants.includes(EXPERIENCE_CAPABILITY.deterministicRandom);
  return {
    ...(includeParticipants ? { participants } : {}),
    ...(includeRandom ? { random } : {}),
    ...(chance !== undefined ? { chance } : {}),
  };
}

// ─── Model-effect request payload contract (Wave 4 / IR-43) ───────────────────
/**
 * The opaque `request` payload a reducer emits inside a `kind: "model"`
 * {@link ExperienceEffectRequest}. The host interprets this fixed V1 contract:
 * the model seat's projected view + legal actions become the private view;
 * the model output is validated and fed back into the reducer as an
 * `effect_result` transition. `mode: "action"` asks the model to choose among
 * the legal actions the script exposes for `viewer` (re-discovered via
 * `actions()`); `mode: "text"` asks for a free-text reply that becomes the
 * `actionType` action. The package's own prompt contribution is `instruction`
 * (appended to the private view); the host protocol + overrides + character/
 * persona + frozen RP context are layered by the prompt builder (IR-41).
 */
export interface ModelEffectRequestPayload {
  /** The participantId whose projected view + legal actions the model receives. */
  viewer: string;
  mode: "action" | "text";
  /** Required for `mode: "text"`: the action type the model's reply becomes. */
  actionType?: string;
  /** Optional package-authored instruction appended to the private view. */
  instruction?: string;
}

/** The validated terminal result persisted on a `succeeded` model effect. */
export type ModelEffectResultPayload =
  | { mode: "action"; actionId: string; args?: unknown }
  | { mode: "text"; text: string };

