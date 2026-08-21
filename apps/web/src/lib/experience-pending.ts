/**
 * Timer-pending → visual-pending mapping (timer-freedom fix).
 *
 * The visual bridge's `pending` contract means "host work is in flight for
 * YOUR last action — show a working indicator and avoid double-submitting".
 * Model-effect work fits that contract (the model is thinking; a second
 * submit would race the reply). A live TIMER does not: for a timer-driven
 * experience (falling pieces, countdown clocks) "a timer is pending" is the
 * RESTING state of the session, not work — forwarding it as `effect` keeps
 * the visual's controls disabled for the whole session and locks the player
 * out (the exact regression this module exists to prevent).
 *
 * So: timer waits are never forwarded to the visual as pending. The host
 * chrome may still show its own trusted status chip — but the visual keeps
 * its controls enabled while only timers are live. Races between a human
 * action and a firing tick are resolved by the engine's revision CAS
 * (a late tick is dropped; a stale human action is rejected with the fresh
 * revision for a retry), not by disabling input.
 */

/** The phases the visual bridge protocol defines (`sendPending`). */
export type VisualPendingPhase = "idle" | "typing" | "effect";

/** Host-side pending phase (the modal's prop): adds the timer-wait phase the
 *  visual never sees. `undefined` (no phase computed yet) maps to idle. */
export function visualPendingFromPhase(
	phase: "idle" | "typing" | "effect" | "timer" | undefined,
): VisualPendingPhase {
	if (phase === "typing" || phase === "effect") return phase;
	// "timer" and "idle"/undefined stay interactive — see the module header.
	return "idle";
}

/** Effect-row shape the effects-based derivation needs (structural so both the
 *  store rows and test fixtures satisfy it without importing the store). */
export interface PendingEffectLike {
	readonly kind: string;
	readonly status: string;
}

/** Derive the visual pending phase from live effect rows: ONLY model-kind
 *  pending/running rows mean host work; timer rows (pending or running) are
 *  the resting state of a timer-driven session and must not gate the visual. */
export function visualPendingFromEffects(effects: readonly PendingEffectLike[]): VisualPendingPhase {
	return effects.some((e) => e.kind === "model" && (e.status === "pending" || e.status === "running"))
		? "effect"
		: "idle";
}
