import { describe, expect, test } from "bun:test";
import {
	PROVIDER_QUOTA_EVENT_KIND,
	PROVIDER_QUOTA_KIND,
	PROVIDER_QUOTA_WINDOW_KIND,
	QUOTA_LOW_REMAINING_CROSSING,
	QUOTA_RESET_DETECTION,
	type ProviderQuotaWindow,
	type QuotaTransitionState,
	type WindowedProviderQuotaConfig,
	type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import { evaluateWindowedQuotaTransitions } from "../src/domain/quota/quota-transitions.js";

const PROFILE = "prov_1";
const CAPABILITY = "zai";
const SESSION_RESET_A = "2026-08-07T14:00:00.000Z";
const SESSION_RESET_B = "2026-08-07T19:00:00.000Z";

const CONFIG: WindowedProviderQuotaConfig = {
	kind: PROVIDER_QUOTA_KIND.windowed,
	displayEnabled: true,
	lowQuotaEnabled: true,
	lowQuotaRemainingPercent: 10,
	resetNotifyEnabled: true,
};

function session(usedPercent: number, resetsAt: string | null = SESSION_RESET_A): ProviderQuotaWindow {
	return { kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "5h", usedPercent, resetsAt };
}

function snapshot(observedAt: string, windows: ProviderQuotaWindow[]): WindowedProviderQuotaSnapshot {
	return {
		kind: PROVIDER_QUOTA_KIND.windowed,
		providerProfileId: PROFILE,
		capabilityId: CAPABILITY,
		capabilityVersion: 1,
		observedAt,
		windows,
	};
}

/** Feed a sequence of snapshots through the machine exactly as the poller would. */
function replay(
	snapshots: WindowedProviderQuotaSnapshot[],
	config: WindowedProviderQuotaConfig = CONFIG,
	initialState: QuotaTransitionState | null = null,
	now = "2026-08-07T20:00:00.000Z",
) {
	let state = initialState;
	let previous: WindowedProviderQuotaSnapshot | null = null;
	const rounds: ReturnType<typeof evaluateWindowedQuotaTransitions>[] = [];
	for (const current of snapshots) {
		const result = evaluateWindowedQuotaTransitions(previous, current, config, state, now);
		rounds.push(result);
		state = result.state;
		previous = current;
	}
	return { rounds, state };
}

describe("baseline", () => {
	test("the first poll of a healthy window emits nothing and records the reading", () => {
		const { rounds, state } = replay([snapshot("2026-08-07T10:00:00.000Z", [session(20)])]);

		expect(rounds[0]!.events).toEqual([]);
		expect(state?.windows.session).toEqual({
			lastUsedPercent: 20,
			lastResetsAt: SESSION_RESET_A,
			lowQuotaLatched: false,
			rearmCount: 0,
		});
	});

	test("a first poll that is ALREADY past the threshold warns once, then never again", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(95)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(96)]),
			snapshot("2026-08-07T10:10:00.000Z", [session(97)]),
		]);

		expect(rounds[0]!.events).toHaveLength(1);
		expect(rounds[0]!.events[0]).toMatchObject({
			kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
			crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
			remainingPercent: 5,
			thresholdPercent: 10,
		});
		expect(rounds[1]!.events).toEqual([]);
		expect(rounds[2]!.events).toEqual([]);
	});
});

describe("low-remaining crossing", () => {
	test("fires exactly once on the poll that crosses down, and latches", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(89)]),
			snapshot("2026-08-07T10:10:00.000Z", [session(90)]),
			snapshot("2026-08-07T10:15:00.000Z", [session(93)]),
			snapshot("2026-08-07T10:20:00.000Z", [session(99)]),
		]);

		expect(rounds.map((round) => round.events.length)).toEqual([0, 0, 1, 0, 0]);
		expect(rounds[2]!.events[0]).toMatchObject({
			crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
			usedPercent: 90,
			remainingPercent: 10,
		});
	});

	test("no event when the toggle is off, but the latch still tracks reality", () => {
		const config = { ...CONFIG, lowQuotaEnabled: false };
		const { rounds, state } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
		], config);

		expect(rounds.flatMap((round) => round.events)).toEqual([]);
		expect(state?.windows.session?.lowQuotaLatched).toBe(true);
	});

	test("turning the toggle ON mid-crisis warns on the next poll", () => {
		const off = { ...CONFIG, lowQuotaEnabled: false };
		const { state } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
		], off);

		const after = evaluateWindowedQuotaTransitions(
			snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
			snapshot("2026-08-07T10:10:00.000Z", [session(95)]),
			CONFIG,
			state,
			"2026-08-07T10:10:00.000Z",
		);

		expect(after.events).toHaveLength(1);
		expect(after.events[0]).toMatchObject({ crossing: QUOTA_LOW_REMAINING_CROSSING.observed });
	});

	test("raising the threshold over the current reading warns once (config rebaseline)", () => {
		const { state } = replay([snapshot("2026-08-07T10:00:00.000Z", [session(60)])]);
		expect(state?.windows.session?.lowQuotaLatched).toBe(false);

		const after = evaluateWindowedQuotaTransitions(
			snapshot("2026-08-07T10:00:00.000Z", [session(60)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(60)]),
			{ ...CONFIG, lowQuotaRemainingPercent: 50 },
			state,
			"2026-08-07T10:05:00.000Z",
		);

		expect(after.events).toHaveLength(1);
		expect(after.events[0]).toMatchObject({ thresholdPercent: 50, remainingPercent: 40 });
		expect(after.state.thresholdPercent).toBe(50);
	});

	test("lowering the threshold below the current reading clears the latch without an event", () => {
		const { state } = replay([snapshot("2026-08-07T10:00:00.000Z", [session(95)])]);
		expect(state?.windows.session?.lowQuotaLatched).toBe(true);

		const after = evaluateWindowedQuotaTransitions(
			snapshot("2026-08-07T10:00:00.000Z", [session(95)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
			{ ...CONFIG, lowQuotaRemainingPercent: 2 },
			state,
			"2026-08-07T10:05:00.000Z",
		);

		expect(after.events).toEqual([]);
		expect(after.state.windows.session?.lowQuotaLatched).toBe(false);
	});
});

describe("reset detection", () => {
	test("an advanced boundary with a usage drop is boundary_advanced_with_usage_drop", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T13:55:00.000Z", [session(95)]),
			snapshot("2026-08-07T14:05:00.000Z", [session(3, SESSION_RESET_B)]),
		]);

		expect(rounds[1]!.events).toHaveLength(1);
		expect(rounds[1]!.events[0]).toMatchObject({
			kind: PROVIDER_QUOTA_EVENT_KIND.windowReset,
			detection: QUOTA_RESET_DETECTION.boundaryAdvancedWithUsageDrop,
			resetsAt: SESSION_RESET_B,
		});
	});

	test("an advanced boundary without a usage drop is boundary_advanced", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T13:55:00.000Z", [session(4)]),
			snapshot("2026-08-07T14:05:00.000Z", [session(6, SESSION_RESET_B)]),
		]);

		expect(rounds[1]!.events[0]).toMatchObject({ detection: QUOTA_RESET_DETECTION.boundaryAdvanced });
	});

	test("a stale boundary plus a big usage drop after it passed is usage_drop_after_boundary", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T13:55:00.000Z", [session(95)]),
			snapshot("2026-08-07T14:05:00.000Z", [session(2)]),
		], CONFIG, null, "2026-08-07T14:05:00.000Z");

		expect(rounds[1]!.events[0]).toMatchObject({ detection: QUOTA_RESET_DETECTION.usageDropAfterBoundary });
	});

	test("a big usage drop BEFORE the boundary passes is not a reset", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T11:00:00.000Z", [session(95)]),
			snapshot("2026-08-07T11:05:00.000Z", [session(2)]),
		], CONFIG, null, "2026-08-07T11:05:00.000Z");

		expect(rounds[1]!.events).toEqual([]);
	});

	test("a reset clears the latch so the next crossing warns again", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
			snapshot("2026-08-07T14:05:00.000Z", [session(5, SESSION_RESET_B)]),
			snapshot("2026-08-07T15:00:00.000Z", [session(50, SESSION_RESET_B)]),
			snapshot("2026-08-07T16:00:00.000Z", [session(95, SESSION_RESET_B)]),
		]);

		expect(rounds[1]!.events.map((event) => event.kind)).toEqual([PROVIDER_QUOTA_EVENT_KIND.lowRemaining]);
		expect(rounds[2]!.events.map((event) => event.kind)).toEqual([PROVIDER_QUOTA_EVENT_KIND.windowReset]);
		expect(rounds[3]!.events).toEqual([]);
		expect(rounds[4]!.events.map((event) => event.kind)).toEqual([PROVIDER_QUOTA_EVENT_KIND.lowRemaining]);
		expect(rounds[4]!.events[0]!.eventId).not.toBe(rounds[1]!.events[0]!.eventId);
	});

	test("a fresh window that opens already low emits reset + inferred_after_reset", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T13:55:00.000Z", [session(99)]),
			snapshot("2026-08-07T14:05:00.000Z", [session(94, SESSION_RESET_B)]),
		]);

		expect(rounds[1]!.events.map((event) => event.kind)).toEqual([
			PROVIDER_QUOTA_EVENT_KIND.windowReset,
			PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
		]);
		expect(rounds[1]!.events[1]).toMatchObject({ crossing: QUOTA_LOW_REMAINING_CROSSING.inferredAfterReset });
	});

	test("no reset event when the toggle is off, but the latch still clears", () => {
		const config = { ...CONFIG, resetNotifyEnabled: false };
		const { rounds, state } = replay([
			snapshot("2026-08-07T13:55:00.000Z", [session(95)]),
			snapshot("2026-08-07T14:05:00.000Z", [session(3, SESSION_RESET_B)]),
		], config);

		expect(rounds[1]!.events).toEqual([]);
		expect(state?.windows.session?.lowQuotaLatched).toBe(false);
	});
});

describe("windows without a reset boundary (spend limits)", () => {
	const spend = (usedPercent: number): ProviderQuotaWindow => ({
		kind: PROVIDER_QUOTA_WINDOW_KIND.spendLimit,
		label: "Key limit",
		usedPercent,
		resetsAt: null,
	});

	test("never produce a reset event even when usage collapses", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [spend(95)]),
			snapshot("2026-08-07T10:05:00.000Z", [spend(1)]),
		]);

		expect(rounds[1]!.events).toEqual([]);
	});

	test("re-arm needs the full hysteresis band, and the re-fired id is distinct", () => {
		const { rounds } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [spend(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [spend(95)]),
			// Back to exactly the threshold — inside the band, still latched.
			snapshot("2026-08-07T10:10:00.000Z", [spend(90)]),
			snapshot("2026-08-07T10:15:00.000Z", [spend(95)]),
			// Past threshold + hysteresis: re-armed.
			snapshot("2026-08-07T10:20:00.000Z", [spend(80)]),
			snapshot("2026-08-07T10:25:00.000Z", [spend(96)]),
		]);

		expect(rounds.map((round) => round.events.length)).toEqual([0, 1, 0, 0, 0, 1]);
		expect(rounds[5]!.events[0]!.eventId).not.toBe(rounds[1]!.events[0]!.eventId);
		expect(rounds[5]!.events[0]!.eventId).toContain("noreset#1");
	});
});

describe("event ids", () => {
	test("are deterministic — replaying the identical sequence yields identical ids", () => {
		const sequence = () => replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
		]);

		const first = sequence().rounds.flatMap((round) => round.events.map((event) => event.eventId));
		const second = sequence().rounds.flatMap((round) => round.events.map((event) => event.eventId));

		expect(first).toEqual(second);
		expect(first).toEqual([`${PROFILE}:${CAPABILITY}:session:low_remaining:${SESSION_RESET_A}`]);
	});

	test("a restart replaying the last poll against stored state emits nothing new", () => {
		const { state } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
		]);

		const afterRestart = evaluateWindowedQuotaTransitions(
			null,
			snapshot("2026-08-07T10:10:00.000Z", [session(95)]),
			CONFIG,
			state,
			"2026-08-07T10:10:00.000Z",
		);

		expect(afterRestart.events).toEqual([]);
	});
});

describe("guards", () => {
	test("a stale poll is ignored and leaves the state untouched", () => {
		const { state } = replay([snapshot("2026-08-07T10:05:00.000Z", [session(50)])]);

		const stale = evaluateWindowedQuotaTransitions(
			snapshot("2026-08-07T10:05:00.000Z", [session(50)]),
			snapshot("2026-08-07T10:00:00.000Z", [session(99)]),
			CONFIG,
			state,
			"2026-08-07T10:06:00.000Z",
		);

		expect(stale.events).toEqual([]);
		expect(stale.state).toBe(state!);
	});

	test("a previous snapshot from another profile throws", () => {
		const other: WindowedProviderQuotaSnapshot = {
			...snapshot("2026-08-07T10:00:00.000Z", [session(10)]),
			providerProfileId: "prov_other",
		};
		expect(() => evaluateWindowedQuotaTransitions(
			other,
			snapshot("2026-08-07T10:05:00.000Z", [session(20)]),
			CONFIG,
			null,
			"2026-08-07T10:05:00.000Z",
		)).toThrow(/identity mismatch/);
	});

	test("a previous snapshot from another adapter throws", () => {
		const other: WindowedProviderQuotaSnapshot = {
			...snapshot("2026-08-07T10:00:00.000Z", [session(10)]),
			capabilityId: "kimi",
		};
		expect(() => evaluateWindowedQuotaTransitions(
			other,
			snapshot("2026-08-07T10:05:00.000Z", [session(20)]),
			CONFIG,
			null,
			"2026-08-07T10:05:00.000Z",
		)).toThrow(/identity mismatch/);
	});

	test("an adapter version bump rebaselines instead of comparing across shapes", () => {
		const { state } = replay([snapshot("2026-08-07T10:00:00.000Z", [session(50)])]);
		const bumped: WindowedProviderQuotaSnapshot = {
			...snapshot("2026-08-07T10:05:00.000Z", [session(95)]),
			capabilityVersion: 2,
		};

		const after = evaluateWindowedQuotaTransitions(
			snapshot("2026-08-07T10:00:00.000Z", [session(50)]),
			bumped,
			CONFIG,
			state,
			"2026-08-07T10:05:00.000Z",
		);

		expect(after.events).toHaveLength(1);
		expect(after.events[0]).toMatchObject({ crossing: QUOTA_LOW_REMAINING_CROSSING.observed });
		expect(after.state.capabilityVersion).toBe(2);
	});
});

describe("multiple windows", () => {
	const weekly = (usedPercent: number, resetsAt = "2026-08-11T00:00:00.000Z"): ProviderQuotaWindow => ({
		kind: PROVIDER_QUOTA_WINDOW_KIND.weekly,
		label: "Weekly",
		usedPercent,
		resetsAt,
	});

	test("each window latches independently", () => {
		const { rounds, state } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50), weekly(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(95), weekly(60)]),
			snapshot("2026-08-07T10:10:00.000Z", [session(96), weekly(96)]),
		]);

		expect(rounds[1]!.events.map((event) => event.windowKind)).toEqual([PROVIDER_QUOTA_WINDOW_KIND.session]);
		expect(rounds[2]!.events.map((event) => event.windowKind)).toEqual([PROVIDER_QUOTA_WINDOW_KIND.weekly]);
		expect(state?.windows.session?.lowQuotaLatched).toBe(true);
		expect(state?.windows.weekly?.lowQuotaLatched).toBe(true);
	});

	test("a window the vendor stops reporting drops out of the state", () => {
		const { state } = replay([
			snapshot("2026-08-07T10:00:00.000Z", [session(50), weekly(50)]),
			snapshot("2026-08-07T10:05:00.000Z", [session(55)]),
		]);

		expect(Object.keys(state!.windows)).toEqual([PROVIDER_QUOTA_WINDOW_KIND.session]);
	});
});
