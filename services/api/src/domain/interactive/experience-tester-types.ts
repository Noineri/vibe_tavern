/**
 * Result, error and input types of the stateless unsaved-source experience
 * tester (`experience-tester.ts`) — the typed failure, the per-step trace, the
 * run / simulate / discover payloads and the request inputs. Pure type
 * declarations with no runtime behavior; extracted from experience-tester.ts to
 * keep that file within its arch-gate size budget. experience-tester.ts
 * re-exports every type here, so importers keep resolving them from there.
 */

import type { ExperienceDefinition } from "./experience-kernel.js";
import type { ExperienceConsoleEntry } from "./experience-sandbox.js";
import type {
  ExperienceAction,
  ExperienceActionDescriptor,
  ExperienceCapability,
  ExperienceEffectRequest,
  ExperienceEvent,
  ExperienceParticipant,
  ExperienceSessionStatus,
} from "@vibe-tavern/domain";
import type { ExperienceSeatLegalityMatrix } from "@vibe-tavern/api-contracts";

// ─── Result / error types ────────────────────────────────────────────────────

/**
 * A typed tester failure. Carries the host-managed HTTP status (409 for a
 * stale-revision CAS conflict, 422 for every authoring/validation/VM fault), a
 * stable `code`, the kernel/sandbox `kind` (for vm_error), and the VM console
 * captured up to the failure point — a diagnostic tester surfaces console even
 * on the error path so an author sees `console.log` output before a throw.
 */
export interface ExperienceTestError {
  readonly status: 409 | 422;
  readonly code: string;
  readonly message: string;
  readonly console: ExperienceConsoleEntry[];
  /** Kernel/sandbox failure kind (timeout/syntax/runtime/no_registration/…). */
  readonly kind?: string;
  /** Present on a stale_revision failure (the live in-memory revision). */
  readonly currentRevision?: number;
  /** Present on a no_choose_method configuration error. */
  readonly participantId?: string;
  /** Present on a capability_denied failure (the over-granted capabilities). */
  readonly granted?: readonly ExperienceCapability[];
  readonly needs?: readonly ExperienceCapability[];
}

/** One replayed action's outcome inside a test run / simulation trace. */
export interface ExperienceTestStepTrace {
  readonly requestId: string;
  readonly actionType: string;
  readonly participantId?: string;
  /** True when this requestId was already applied — the step is an idempotent
   *  replay (the revision did NOT advance; the transition was not re-reduced). */
  readonly replayed: boolean;
  /** The in-memory revision AFTER this step applied. */
  readonly revision: number;
  readonly status: ExperienceSessionStatus;
  readonly events: ExperienceEvent[];
  /** Effects the reducer requested at this step (reported, never executed). */
  readonly effects: ExperienceEffectRequest[];
  readonly console: ExperienceConsoleEntry[];
}

/** The projected view for the response viewer at the final state. */
export interface ExperienceTestProjection {
  readonly state: unknown;
  readonly actions: ExperienceActionDescriptor[];
  /** Cosmetic display data from the optional `flavor` method (best-effort; may
   *  be absent). The stateless tester never sets it; the playground driver
   *  (IR-84A) computes it and, when a chatter service is wired, normalizes a
   *  chatter-marked flavor through it (async flavor, item 4 / AC-2b). */
  readonly flavor?: unknown;
}

/** `ExperienceSeatLegality` / `ExperienceSeatLegalityMatrix` (the per-seat
 *  legality matrix, EXPERIENCE_TURN_LEGALITY_DIAGNOSTICS_REPORT step 3) are
 *  imported above from the shared wire contract
 *  `@vibe-tavern/api-contracts` — the backend produces exactly the shape the
 *  frontend renders, so drift is a compile error. */

export interface ExperienceTestRunData {
  readonly definition: ExperienceDefinition;
  readonly sourceHash: string;
  /** Authoritative state immediately after `create` (revision 0). */
  readonly initialState: unknown;
  /** Authoritative state after the final applied action (== initialState when
   *  no actions were supplied). */
  readonly finalState: unknown;
  /** Host-managed monotonic revision (0 after create; +1 per applied reduce). */
  readonly revision: number;
  readonly status: ExperienceSessionStatus;
  /** Projected view for the human seat (or observer) at the final state. */
  readonly projection: ExperienceTestProjection;
  /** All events emitted across create + every applied reduce. */
  readonly events: ExperienceEvent[];
  /** All effects requested across the run (reported, never executed). */
  readonly effects: ExperienceEffectRequest[];
  /** VM console captured across discovery + every method call. */
  readonly console: ExperienceConsoleEntry[];
  readonly steps: ExperienceTestStepTrace[];
  /** Per-seat legality matrix at the final state (one entry per roster
   *  participant, computed under that seat's own viewer). Empty seats array
   *  when the run carried no roster. */
  readonly seatLegality: ExperienceSeatLegalityMatrix;
}

export type ExperienceTestRunResult =
  | { readonly ok: true; readonly data: ExperienceTestRunData }
  | { readonly ok: false; readonly error: ExperienceTestError };

/**
 * Why a bounded simulation stopped. The diagnostic surface distinguishes
 * ordinary boundaries (a human/model seat, a terminal status) from authoring
 * faults (a script seat with legal actions but no `choose`, a stuck position
 * with no legal action, or a non-terminating loop that hit the host bound).
 */
export type ExperienceTestStopReason =
  | "completed"
  | "awaiting_human"
  | "awaiting_model"
  | "no_legal_action"
  | "no_choose_method"
  | "bounded_non_termination"
  | "effects_bound";

export interface ExperienceTestSimulateData {
  readonly definition: ExperienceDefinition;
  readonly sourceHash: string;
  readonly initialState: unknown;
  readonly finalState: unknown;
  readonly revision: number;
  readonly status: ExperienceSessionStatus;
  readonly events: ExperienceEvent[];
  readonly effects: ExperienceEffectRequest[];
  readonly console: ExperienceConsoleEntry[];
  readonly steps: ExperienceTestStepTrace[];
  readonly stopReason: ExperienceTestStopReason;
  /** Number of script-seat reduces performed. */
  readonly iterations: number;
  /** Present on a no_choose_method stop (the offending participant). */
  readonly stopDetail?: { readonly participantId?: string };
}

export type ExperienceTestSimulateResult =
  | { readonly ok: true; readonly data: ExperienceTestSimulateData }
  | { readonly ok: false; readonly error: ExperienceTestError };

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface ExperienceTestRunInput {
  readonly rulesCode: string;
  readonly scriptName?: string;
  /** Game-specific setup passed to `create`; defaults to `{}` when omitted (the
   *  wire schema applies the same default at the route boundary). */
  readonly settings?: unknown;
  readonly participants?: readonly ExperienceParticipant[];
  readonly capabilityGrants?: readonly ExperienceCapability[];
  readonly seed?: string;
  /** Seat whose view is projected in the response; defaults to the first human. */
  readonly humanSeatId?: string;
  /** Ordered action intentions to replay after create. An empty/omitted list
   *  yields a create-only run (discover + create + project + legal actions). */
  readonly actions?: readonly ExperienceAction[];
}

export interface ExperienceTestSimulateInput {
  readonly rulesCode: string;
  readonly scriptName?: string;
  /** Game-specific setup passed to `create`; defaults to `{}` when omitted. */
  readonly settings?: unknown;
  readonly participants?: readonly ExperienceParticipant[];
  readonly capabilityGrants?: readonly ExperienceCapability[];
  readonly seed?: string;
  readonly maxIterations?: number;
  readonly maxEffects?: number;
}

// ─── Discovery preamble ──────────────────────────────────────────────────────

export interface DiscoveredPreamble {
  readonly definition: ExperienceDefinition;
  readonly sourceHash: string;
  readonly console: readonly ExperienceConsoleEntry[];
}

/** Success payload of {@link discoverExperienceTest}: the validated definition,
 *  its source hash, and the discovery console. */
export type ExperienceTestDiscoverData = DiscoveredPreamble;
export type ExperienceTestDiscoverResult =
  | { readonly ok: true; readonly data: ExperienceTestDiscoverData }
  | { readonly ok: false; readonly error: ExperienceTestError };
