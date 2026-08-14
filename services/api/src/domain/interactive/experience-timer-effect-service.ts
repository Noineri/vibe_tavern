/**
 * Experience timer-effect service (INTERACTIVE_ENGINE_EXPANSION, fix step 2b).
 *
 * Runs ONE persisted `timer` effect to a durable terminal state and feeds the
 * fired tick action back into the reducer. Structural mirror of the model-effect
 * service (IR-43) minus the prompt/provider machinery: claim → resolve → sleep →
 * complete → CAS feed-back.
 *
 * Durable lifecycle (the same invariants as the model path):
 *  - `claim` (pending → running) happens BEFORE the sleep ("persist before
 *    run"), so a crash after claim leaves a `running` effect that restart
 *    reconciles to `unknown` (never silently re-run).
 *  - An aborted signal (client cancel) persists `cancelled`.
 *  - A resolve-time failure (malformed request, missing participant, illegal or
 *    schema-violating tick) persists `failed` with a machine-readable reason and
 *    NEVER sleeps.
 *  - Only an explicit user retry (retryEffect) creates a new attempt.
 *
 * Host owns the clock: `afterMs` counts from the moment this service claims the
 * effect. Game time does not advance while the server is down; a restart
 * restarts the countdown. The host scheduler that drives this service is fix
 * step 2c — out of scope here.
 *
 * Stale completion (the IR-22 invariant): the tick's feed-back is an
 * `effect_result` transition whose `expectedRevision` is the effect's
 * `originatingRevision`; if the session advanced past it, the CAS rejects the
 * feed-back and the effect stays `succeeded`-but-undelivered — it can never
 * overwrite newer state. The reducer remains the final authority at fire time
 * (the legal-set check at claim is an early typed failure, not the gate).
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type { ExperienceAction } from "@vibe-tavern/domain";

import type {
	ExperienceProjection,
	ExperienceSessionView,
	ExperienceService,
} from "./experience-service.js";
import { type ExperienceResult, err, ok } from "./experience-shared.js";
import { validatePayloadValue } from "./experience-payload-schema.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** The durable outcome of one `runEffect` call (always terminal or running). */
export interface TimerEffectOutcome {
	effectId: string;
	status: "succeeded" | "failed" | "cancelled" | "running";
	/** Present when failed (machine-readable reason). */
	error?: string;
	/** Whether the tick was delivered into the reducer (false on stale completion). */
	delivered?: boolean;
	/** Present when delivered (the post-feed-back session view + projection). */
	session?: ExperienceSessionView;
	projection?: ExperienceProjection;
}

export interface ExperienceTimerEffectServiceDeps {
	stores: StoreContainer;
	experienceService: ExperienceService;
	/** Sleep seam — injectable for tests. Default: real abortable setTimeout. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ExperienceTimerEffectService {
	private readonly deps: ExperienceTimerEffectServiceDeps;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(deps: ExperienceTimerEffectServiceDeps) {
		this.deps = deps;
		this.sleep = deps.sleep ?? defaultSleep;
	}

	/**
	 * Resolve one persisted timer effect to a terminal state and feed the fired
	 * tick back into the reducer. Idempotent: a non-pending effect returns its
	 * current status without re-running (a concurrent worker, a retry of a
	 * terminal effect, or a re-delivery).
	 */
	async runEffect(effectId: string, signal?: AbortSignal): Promise<ExperienceResult<TimerEffectOutcome>> {
		const effect = await this.deps.stores.experiences.getEffectById(effectId);
		if (effect === null) {
			return err({ status: 404, code: "effect_not_found", message: `Effect '${effectId}' not found` });
		}
		// Idempotent re-entry: a terminal/running effect is NOT re-run.
		if (effect.status !== "pending") {
			return ok({ effectId, status: toOutcomeStatus(effect.status) });
		}

		// 1. Claim (pending → running) BEFORE the sleep. A crash after this
		//    leaves a `running` effect that restart reconciles to `unknown`.
		const claimed = await this.deps.stores.experiences.claimEffect(effectId);
		if (claimed === null) {
			const raced = await this.deps.stores.experiences.getEffectById(effectId);
			return ok({ effectId, status: toOutcomeStatus(raced?.status ?? "running") });
		}

		// 2. Resolve the VM context (parse + participant + legal set). A failure
		//    here persists `failed` and never sleeps.
		const vmCtx = await this.deps.experienceService.resolveTimerEffectContext(effectId);
		if (!vmCtx.ok) {
			await this.deps.stores.experiences.failEffect(effectId, vmCtx.error.code);
			return ok({ effectId, status: "failed", error: vmCtx.error.code });
		}

		// 3. Early typed failure: the tick action type must be legal for the
		//    viewer at claim time; a schema-declaring action's fixed args must
		//    satisfy its payloadSchema (mirrors fix step 1b). The reducer is
		//    still the final authority at fire time.
		const descriptor = vmCtx.data.legalActions.find((a) => a.type === vmCtx.data.request.actionType);
		if (descriptor === undefined) {
			await this.deps.stores.experiences.failEffect(effectId, "illegal_action");
			return ok({ effectId, status: "failed", error: "illegal_action" });
		}
		if (descriptor.payloadSchema !== undefined && vmCtx.data.request.args !== undefined) {
			const schemaResult = validatePayloadValue(vmCtx.data.request.args, descriptor.payloadSchema, "args");
			if (!schemaResult.ok) {
				await this.deps.stores.experiences.failEffect(effectId, "invalid_payload");
				return ok({ effectId, status: "failed", error: "invalid_payload" });
			}
		}

		// 4. Sleep the declared delay (host-owned clock: from claim, not from
		//    effect creation).
		try {
			await this.sleep(vmCtx.data.request.afterMs, signal);
		} catch (e) {
			// Cancellation: an aborted signal persists `cancelled`.
			if (signal?.aborted) {
				await this.deps.stores.experiences.cancelEffect(effectId);
				return ok({ effectId, status: "cancelled" });
			}
			const message = describeError(e);
			await this.deps.stores.experiences.failEffect(effectId, message);
			return ok({ effectId, status: "failed", error: message });
		}
		// Some timers may resolve cleanly despite an abort — re-check.
		if (signal?.aborted) {
			await this.deps.stores.experiences.cancelEffect(effectId);
			return ok({ effectId, status: "cancelled" });
		}

		// 5. Persist the terminal result BEFORE the feed-back (applyEffectResult
		//    requires status "succeeded").
		await this.deps.stores.experiences.completeEffect(
			effectId,
			JSON.stringify({
				fired: true,
				actionType: vmCtx.data.request.actionType,
				...(vmCtx.data.request.args !== undefined ? { args: vmCtx.data.request.args } : {}),
			}),
		);

		// 6. Build the tick action + feed it back (CAS). A stale session rejects
		//    it and the effect stays succeeded-but-undelivered.
		const action: ExperienceAction = {
			type: vmCtx.data.request.actionType,
			requestId: `effect:${effectId}`,
			expectedRevision: effect.originatingRevision,
			participantId: vmCtx.data.request.viewer,
			...(vmCtx.data.request.args !== undefined ? { payload: vmCtx.data.request.args } : {}),
		};
		const delivery = await this.deps.experienceService.applyEffectResult(effectId, action, { actorKind: "timer" });
		if (!delivery.ok) {
			// The reducer rejected the mapped action (illegal at the current state).
			// The effect is already succeeded; surface the delivery failure without
			// mutating the terminal result.
			return ok({ effectId, status: "succeeded", delivered: false, error: delivery.error.code });
		}
		return ok({
			effectId,
			status: "succeeded",
			delivered: delivery.data.delivered,
			...(delivery.data.delivered ? { session: delivery.data.session, projection: delivery.data.projection } : {}),
		});
	}
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Default abortable sleep. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer);
			reject(new Error("aborted"));
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Extract a human-readable message from a thrown value without instanceof (cross-realm safe). */
function describeError(e: unknown): string {
	if (e !== null && typeof e === "object") {
		const message = (e as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
		const name = (e as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) return name;
	}
	return typeof e === "string" ? e : "unknown_error";
}

/** Narrow a persisted effect status (a broad string) to the outcome union. `unknown` (process loss) surfaces as `failed`. */
function toOutcomeStatus(status: string): TimerEffectOutcome["status"] {
	if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "running") return status;
	return "failed";
}
