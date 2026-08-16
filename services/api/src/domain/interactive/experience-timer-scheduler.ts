/**
 * Experience timer-effect scheduler (INTERACTIVE_ENGINE_EXPANSION, fix step 2c).
 *
 * Host-side driver for `timer` effects: timers must fire with the page closed,
 * so nothing here depends on a frontend connection. An interval poll discovers
 * pending timer rows across ALL sessions (`getPendingEffectsByKind`) and hands
 * each to the {@link ExperienceTimerEffectService}, which owns the claim →
 * sleep(afterMs) → tick feed-back lifecycle. `afterMs` counts from the moment
 * the service CLAIMS the effect — the host owns the clock; game time does not
 * advance while the server is down, and a restart restarts the countdown.
 *
 * Durability boundaries (deliberate):
 *  - One in-flight run per effect id (in-memory guard): a poll that re-observes
 *    a claimed-but-still-`pending` row cannot double-run it.
 *  - `stop()` only clears the interval; it does NOT abort in-flight sleeps.
 *    Aborting would persist `cancelled` (a terminal status) and silently kill
 *    timers that a restart should have continued. Instead, shutdown lets the
 *    process die with claimed rows left `running`, and the NEXT start's
 *    `reconcileUnknownEffects()` folds them into `unknown` — the exact
 *    crash-durability semantics the model-effect path already has.
 *  - `runEffect` never throws here: every failure path inside it is a typed
 *    terminal persist; the poll only logs unexpected rejections so one bad
 *    effect can never kill the loop.
 */

import { EXPERIENCE_EFFECT_KIND } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";

import type { ExperienceTimerEffectService } from "./experience-timer-effect-service.js";

export interface ExperienceTimerSchedulerDeps {
	stores: StoreContainer;
	timerEffects: ExperienceTimerEffectService;
	/** Poll cadence in ms (default 1000). The sleep inside the timer service
	 *  absorbs the remainder, so poll granularity only delays discovery. */
	pollIntervalMs?: number;
	/** Unexpected-error sink (tests inject a recorder; production logs). */
	onError?: (error: unknown) => void;
}

export class ExperienceTimerScheduler {
	private readonly deps: ExperienceTimerSchedulerDeps;
	private readonly inFlight = new Set<string>();
	private interval: ReturnType<typeof setInterval> | undefined;

	constructor(deps: ExperienceTimerSchedulerDeps) {
		this.deps = deps;
	}

	/** Begin polling. Safe to call once per process start. */
	start(): void {
		if (this.interval !== undefined) return;
		void this.pollOnce();
		this.interval = setInterval(() => void this.pollOnce(), this.deps.pollIntervalMs ?? 1000);
	}

	/** Stop polling. In-flight sleeps are NOT aborted (see file header):
	 *  claimed rows stay `running` and the next start reconciles them. */
	stop(): void {
		if (this.interval === undefined) return;
		clearInterval(this.interval);
		this.interval = undefined;
	}

	/** Number of effects currently being run by this scheduler (observable for
	 *  tests; the production runtime never reads it). */
	get inFlightCount(): number {
		return this.inFlight.size;
	}

	private async pollOnce(): Promise<void> {
		let pending;
		try {
			pending = await this.deps.stores.experiences.getPendingEffectsByKind(EXPERIENCE_EFFECT_KIND.timer);
		} catch (error) {
			this.deps.onError?.(error);
			return;
		}
		for (const effect of pending) {
			if (this.inFlight.has(effect.id)) continue;
			this.inFlight.add(effect.id);
			void this.deps.timerEffects
				.runEffect(effect.id)
				.then((run) => {
					// Typed err outcomes (e.g. the row vanished between list and
					// run) are surfaced, not swallowed — the poll continues either way.
					if (!run.ok) this.deps.onError?.(new Error(`timer effect ${effect.id}: ${run.error.code}`));
				})
				.catch((error: unknown) => this.deps.onError?.(error))
				.finally(() => this.inFlight.delete(effect.id));
		}
	}
}
