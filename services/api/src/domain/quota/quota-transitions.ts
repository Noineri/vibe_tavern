/**
 * @module quota-transitions
 *
 * Pure state machine deciding WHICH quota notifications a poll should produce.
 *
 * The rule that shapes everything here: notifications are TRANSITION-based, not
 * level-based. A window sitting at 3% remaining must produce exactly one warning
 * — not one every five minutes until it resets. So each window carries a latch,
 * and the latch only clears when the window genuinely rolls over (or, for a
 * window that never resets, when usage recovers past a hysteresis band).
 *
 * Restarts are handled by the event ids being deterministic: replaying the same
 * situation produces the same id, which the event ledger rejects as a duplicate.
 * Nothing here reads a clock beyond the `now` argument, does any I/O, or knows
 * that a database exists.
 *
 * Windowed snapshots only — balance profiles have no denominator and `none`
 * profiles have no data, so neither type-checks as an input.
 */

import {
	PROVIDER_QUOTA_EVENT_KIND,
	QUOTA_LOW_REMAINING_CROSSING,
	QUOTA_REARM_HYSTERESIS_POINTS,
	QUOTA_RESET_DETECTION,
	QUOTA_RESET_DROP_POINTS,
	type ProviderQuotaEvent,
	type ProviderQuotaWindow,
	type ProviderQuotaWindowKind,
	type QuotaResetDetection,
	type QuotaTransitionState,
	type QuotaWindowTransitionState,
	type WindowedProviderQuotaConfig,
	type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";

export interface QuotaTransitionResult {
	/** In snapshot window order. Empty on a baseline, a stale poll, or no change. */
	readonly events: readonly ProviderQuotaEvent[];
	/** The state to persist. Always returned, even when no events fired. */
	readonly state: QuotaTransitionState;
}

/** Marker used in an event id in place of a reset boundary that does not exist. */
const NO_RESET_MARKER = "noreset";

/**
 * Deterministic event id — the entire restart-dedupe contract.
 *
 * `<profileId>:<capabilityId>:<windowKind>:<eventKind>:<resetsAt>`
 *
 * The trailing segment is what makes a NEW notification possible: a window that
 * resets gets an advanced `resetsAt`, so the next period's warning is a
 * different id. A window that never resets has no such boundary, so its re-arm
 * counter takes that slot instead (`noreset` on the first arm, `noreset#N`
 * after N hysteresis re-arms) — without it, raising an OpenRouter key limit and
 * burning through it again could never notify a second time.
 */
function buildEventId(
	snapshot: WindowedProviderQuotaSnapshot,
	windowKind: ProviderQuotaWindowKind,
	eventKind: string,
	resetsAt: string | null,
	rearmCount: number,
): string {
	const boundary = resetsAt ?? (rearmCount > 0 ? `${NO_RESET_MARKER}#${rearmCount}` : NO_RESET_MARKER);
	return [snapshot.providerProfileId, snapshot.capabilityId, windowKind, eventKind, boundary].join(":");
}

function remainingOf(usedPercent: number): number {
	return 100 - usedPercent;
}

/**
 * Did this window roll over into a fresh period?
 *
 * Vendors are inconsistent: some advance `nextResetTime` the moment the window
 * turns over, some keep serving the old boundary for a while but report a usage
 * that has clearly dropped. Both are a reset. A window with no boundary at all
 * can never be one.
 */
function detectReset(
	current: ProviderQuotaWindow,
	previous: QuotaWindowTransitionState,
	now: string,
): QuotaResetDetection | null {
	if (current.resetsAt === null) return null;

	const boundaryAdvanced = previous.lastResetsAt === null || current.resetsAt > previous.lastResetsAt;
	if (boundaryAdvanced) {
		return current.usedPercent < previous.lastUsedPercent
			? QUOTA_RESET_DETECTION.boundaryAdvancedWithUsageDrop
			: QUOTA_RESET_DETECTION.boundaryAdvanced;
	}

	const usageDrop = previous.lastUsedPercent - current.usedPercent;
	const boundaryPassed = previous.lastResetsAt !== null && now >= previous.lastResetsAt;
	if (usageDrop >= QUOTA_RESET_DROP_POINTS && boundaryPassed) {
		return QUOTA_RESET_DETECTION.usageDropAfterBoundary;
	}

	return null;
}

/**
 * The stored state, or `null` when it no longer describes the question being
 * asked. A different adapter, a bumped adapter version, an edited threshold or
 * a flipped low-quota toggle all invalidate the latches: keeping them would
 * either suppress a warning the user just asked for or fire one they tuned away.
 */
function carryState(
	state: QuotaTransitionState | null,
	current: WindowedProviderQuotaSnapshot,
	config: WindowedProviderQuotaConfig,
): QuotaTransitionState | null {
	if (state === null) return null;
	const sameQuestion = state.capabilityId === current.capabilityId
		&& state.capabilityVersion === current.capabilityVersion
		&& state.thresholdPercent === config.lowQuotaRemainingPercent
		&& state.lowQuotaEnabled === config.lowQuotaEnabled;
	return sameQuestion ? state : null;
}

/**
 * Evaluate one poll.
 *
 * @param previous the snapshot the stored state was derived from, or `null` on
 *   the first poll. Used only to assert identity — the per-window numbers come
 *   from `previousState`, which is what actually survives a restart.
 * @param current the freshly normalized snapshot.
 * @param previousState stored transition memory, or `null` to baseline.
 * @param now canonical UTC instant, used to decide whether a stale reset
 *   boundary has already passed.
 *
 * @throws when `previous` describes a different profile or adapter than
 *   `current` — that combination can only be a caller wiring bug, and silently
 *   proceeding would emit event ids attributed to the wrong profile.
 */
export function evaluateWindowedQuotaTransitions(
	previous: WindowedProviderQuotaSnapshot | null,
	current: WindowedProviderQuotaSnapshot,
	config: WindowedProviderQuotaConfig,
	previousState: QuotaTransitionState | null,
	now: string,
): QuotaTransitionResult {
	if (previous !== null) {
		if (previous.providerProfileId !== current.providerProfileId) {
			throw new Error(
				`quota transition identity mismatch: previous snapshot is for profile ${previous.providerProfileId}, current for ${current.providerProfileId}`,
			);
		}
		if (previous.capabilityId !== current.capabilityId) {
			throw new Error(
				`quota transition identity mismatch: previous snapshot is from adapter ${previous.capabilityId}, current from ${current.capabilityId}`,
			);
		}
	}

	// An out-of-order response must never rewrite newer memory. Dropping it is
	// safe: the next scheduled poll re-reads the truth anyway.
	if (previousState !== null && current.observedAt <= previousState.observedAt) {
		return { events: [], state: previousState };
	}

	const threshold = config.lowQuotaRemainingPercent;
	const carried = carryState(previousState, current, config);
	const events: ProviderQuotaEvent[] = [];
	const windows: Partial<Record<ProviderQuotaWindowKind, QuotaWindowTransitionState>> = {};

	for (const window of current.windows) {
		const remaining = remainingOf(window.usedPercent);
		const stored = carried?.windows[window.kind];

		// No memory for this window — either the very first poll, a rebaseline,
		// or a window the vendor only just started reporting. Fire once if the
		// user is already past their threshold, so enabling notifications
		// mid-crisis actually tells them; then latch.
		if (!stored) {
			const latched = remaining <= threshold;
			if (latched && config.lowQuotaEnabled) {
				events.push({
					kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
					eventId: buildEventId(current, window.kind, PROVIDER_QUOTA_EVENT_KIND.lowRemaining, window.resetsAt, 0),
					providerProfileId: current.providerProfileId,
					capabilityId: current.capabilityId,
					windowKind: window.kind,
					windowLabel: window.label,
					usedPercent: window.usedPercent,
					remainingPercent: remaining,
					thresholdPercent: threshold,
					resetsAt: window.resetsAt,
					crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
					observedAt: current.observedAt,
				});
			}
			windows[window.kind] = {
				lastUsedPercent: window.usedPercent,
				lastResetsAt: window.resetsAt,
				lowQuotaLatched: latched,
				rearmCount: 0,
			};
			continue;
		}

		const detection = detectReset(window, stored, now);
		let latched = stored.lowQuotaLatched;
		let rearmCount = stored.rearmCount;

		if (detection !== null) {
			if (config.resetNotifyEnabled) {
				events.push({
					kind: PROVIDER_QUOTA_EVENT_KIND.windowReset,
					eventId: buildEventId(current, window.kind, PROVIDER_QUOTA_EVENT_KIND.windowReset, window.resetsAt, rearmCount),
					providerProfileId: current.providerProfileId,
					capabilityId: current.capabilityId,
					windowKind: window.kind,
					windowLabel: window.label,
					usedPercent: window.usedPercent,
					remainingPercent: remaining,
					resetsAt: window.resetsAt,
					detection,
					observedAt: current.observedAt,
				});
			}
			// A reset re-arms the warning unconditionally: the advanced boundary
			// already gives the next warning a distinct id.
			latched = false;

			// A fresh window can still open beyond the threshold (a big weekly
			// burn leaving the new period already low). Say so once, marked as
			// inferred so the payload does not claim we watched it cross.
			if (remaining <= threshold) {
				latched = true;
				if (config.lowQuotaEnabled) {
					events.push({
						kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
						eventId: buildEventId(current, window.kind, PROVIDER_QUOTA_EVENT_KIND.lowRemaining, window.resetsAt, rearmCount),
						providerProfileId: current.providerProfileId,
						capabilityId: current.capabilityId,
						windowKind: window.kind,
						windowLabel: window.label,
						usedPercent: window.usedPercent,
						remainingPercent: remaining,
						thresholdPercent: threshold,
						resetsAt: window.resetsAt,
						crossing: QUOTA_LOW_REMAINING_CROSSING.inferredAfterReset,
						observedAt: current.observedAt,
					});
				}
			}
		} else {
			// A window with no reset boundary re-arms on recovery instead. The
			// hysteresis band stops a reading that hovers on the threshold from
			// re-notifying on every poll.
			if (latched && window.resetsAt === null && remaining >= threshold + QUOTA_REARM_HYSTERESIS_POINTS) {
				latched = false;
				rearmCount += 1;
			}

			const crossedDown = remainingOf(stored.lastUsedPercent) > threshold && remaining <= threshold;
			if (!latched && crossedDown) {
				latched = true;
				if (config.lowQuotaEnabled) {
					events.push({
						kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
						eventId: buildEventId(current, window.kind, PROVIDER_QUOTA_EVENT_KIND.lowRemaining, window.resetsAt, rearmCount),
						providerProfileId: current.providerProfileId,
						capabilityId: current.capabilityId,
						windowKind: window.kind,
						windowLabel: window.label,
						usedPercent: window.usedPercent,
						remainingPercent: remaining,
						thresholdPercent: threshold,
						resetsAt: window.resetsAt,
						crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
						observedAt: current.observedAt,
					});
				}
			}
		}

		windows[window.kind] = {
			lastUsedPercent: window.usedPercent,
			lastResetsAt: window.resetsAt,
			lowQuotaLatched: latched,
			rearmCount,
		};
	}

	return {
		events,
		state: {
			capabilityId: current.capabilityId,
			capabilityVersion: current.capabilityVersion,
			thresholdPercent: threshold,
			lowQuotaEnabled: config.lowQuotaEnabled,
			observedAt: current.observedAt,
			windows,
		},
	};
}
