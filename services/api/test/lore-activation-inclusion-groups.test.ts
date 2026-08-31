import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Characterization tests for the inclusion-group subsystem of the LIVE
 * activation engine (`lore-activation-engine.ts`).
 *
 * These were written to pin the `group` → `groupName` field rename: the
 * group field is load-bearing for the engine's inclusion-group filter
 * (`applyInclusionGroups`), which keeps only ONE entry per group under
 * certain rules (prioritizeInclusion override, useGroupScoring, else
 * weighted random). The rename must not regress that behavior.
 *
 * Setup: every entry is `constant: true` + `ignoreBudget: true`, so all
 * entries pass the activation gates independently and reach the group
 * resolver. The group resolver is then the ONLY thing pruning entries.
 */

function makeEntry(overrides: Record<string, unknown> = {}) {
	return {
		id: `e_${Math.random().toString(36).slice(2, 8)}`,
		title: "Constant entry",
		content: "Constant lore content.",
		keys: [] as string[],
		secondaryKeys: [] as string[],
		logic: "and_any",
		position: "before_char",
		depth: 0,
		priority: 10,
		stickyWindow: 0,
		cooldownWindow: 0,
		delayWindow: 0,
		constant: true,
		probability: 100,
		ignoreBudget: true,
		role: "system",
		groupName: "",
		groupWeight: 0,
		prioritizeInclusion: false,
		useGroupScoring: false,
		excludeRecursion: false,
		preventRecursion: false,
		delayUntilRecursion: false,
		recursionLevel: 0,
		scanDepthOverride: null,
		caseSensitive: false,
		matchWholeWords: false,
		characterFilter: [] as Array<{ id: string | null; name: string }>,
		characterFilterExclude: false,
		matchSources: [] as string[],
		enabled: true,
		sortOrder: 0,
		...overrides,
	};
}

function makeInput(entries: ReturnType<typeof makeEntry>[], text: string[] = []): ActivationInput {
	return {
		lorebooks: [
			{
				id: "lb_test",
				scanDepth: 1,
				tokenBudget: 100_000,
			tokenBudgetPercent: null,
				recursiveScanning: false,
				maxRecursionSteps: 0,
				includeNames: false,
				minActivations: 0,
				minActivationsDepthMax: 0,
				entries,
			},
		],
		messages: text.map((t, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: t })),
		macroMap: {},
		characterId: "c_test",
		characterName: "Test",
		activationState: {},
		currentTurn: 1,
	};
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
	return result.activatedEntries.map((e) => e.id);
}

describe("probability ordering (LG-11 characterization)", () => {
	// Characterization-first (LG-11): the first four tests were pinned against
	// the pre-rework engine (probability rolled inside tryActivateEntry, BEFORE
	// the group pipeline, and only on the key-match path — constants and the
	// sticky auto-pass early-returned above the roll), then flipped to ST
	// semantics (verifyProbability, world-info.js 4909-4931): the roll runs in
	// the pass-survivor loop, AFTER the group filter, for EVERY survivor except
	// sticky-active (auto-pass). Group losers never roll; a prob-failed WINNER
	// leaves its group empty; the sticky-first candidate order becomes the
	// budget consumption order.
	const g = { groupName: "weather", useGroupScoring: true, groupWeight: 0 };

	it("LG-11: a probability-0 group WINNER fails AFTER the filter — the group is left EMPTY", () => {
		const winner = makeEntry({ id: "w", ...g, constant: false, keys: ["storm", "rain"], probability: 0 });
		const runner = makeEntry({ id: "r", ...g, constant: false, keys: ["storm"], probability: 100 });
		const result = resolveActivatedEntries(makeInput([winner, runner], ["storm rain"]));
		// Pre-LG11 pin: ["r"] (the winner failed inside activation, so the
		// runner-up became the sole candidate). ST: the runner-up was already
		// REMOVED by the scoring filter when the winner fails probability.
		expect(activatedIds(result)).toEqual([]);
	});

	it("LG-11: a probability-0 CONSTANT fails the post-group roll like any survivor", () => {
		const c = makeEntry({ id: "c", probability: 0 });
		const result = resolveActivatedEntries(makeInput([c]));
		// Pre-LG11 pin: ["c"] (the constant step early-returned above the roll,
		// so constants never rolled at all). ST rolls constants in the same
		// verifyProbability loop; the failure is permanent for the resolve.
		expect(activatedIds(result)).toEqual([]);
	});

	it("LG-11: delay setup happens at match time — a prob-0 entry still becomes delay-pending", () => {
		const d = makeEntry({ id: "d", constant: false, keys: ["storm"], delayWindow: 2, probability: 0 });
		const result = resolveActivatedEntries(makeInput([d], ["storm"]));
		expect(activatedIds(result)).toEqual([]);
		// Pre-LG11 pin: undefined (the roll preceded the delay setup). ST
		// writes delay state at match time; probability rolls after the groups.
		expect(result.updatedState.d).toEqual({ pendingDelayUntilTurn: 3 });
	});

	it("LG-11: sticky-first candidate order is the BUDGET consumption order — a sticky survivor beats an earlier plain entry", () => {
		const plain = makeEntry({ id: "p", constant: false, keys: ["storm"], content: "P".repeat(400), ignoreBudget: false });
		const sticky = makeEntry({ id: "s", stickyWindow: 5, content: "S".repeat(400), ignoreBudget: false });
		const input = {
			...makeInput([plain, sticky], ["storm"]),
			activationState: { s: { activatedAtTurn: 1, lastMatchedAtTurn: 1 } },
		};
		input.lorebooks[0].tokenBudget = 100; // fits exactly ONE ~100-token entry
		const result = resolveActivatedEntries(input);
		// Pre-LG11 pin: ["p"] (the final priority/id sort decided the budget
		// queue). ST sorts candidates sticky-first (world-info.js 4881-4886)
		// before the probability/budget loop, so the sticky survivor consumes
		// the budget first.
		expect(activatedIds(result)).toEqual(["s"]);
	});
});

describe("inclusion groups — groupScore follows ST getScore (LG-3)", () => {
	// The score that decides a scoring group is primary matches plus secondary
	// matches per logic (ST world-info.js getScore), NOT the bare primary
	// matchCount. Constants score at their real key matches; no primary keys → 0.
	const g = { groupName: "weather", useGroupScoring: true, groupWeight: 0 };

	it("and_any sums primary + secondary matches (secondary flips the winner)", () => {
		// A: 1 primary + 2 secondary (and_any) = 3; B: 2 primary = 2 → A survives.
		const a = makeEntry({ id: "a", ...g, constant: false, keys: ["storm"], secondaryKeys: ["rain", "thunder"], logic: "and_any" });
		const b = makeEntry({ id: "b", ...g, constant: false, keys: ["storm", "rain"] });
		const result = resolveActivatedEntries(makeInput([a, b], ["storm rain thunder calm"]));
		expect(activatedIds(result)).toEqual(["a"]);
	});

	it("not_any never adds secondary even when matched — pinned via a constant (the only place the branch is observable)", () => {
		// A constant (active without the key gate) with not_any logic and MATCHED
		// secondary keys scores primary-only (1); B's 2 primary keys (2) win.
		// If secondary were wrongly summed, A would score 3 and win instead.
		const a = makeEntry({ id: "a", ...g, keys: ["storm"], secondaryKeys: ["rain", "thunder"], logic: "not_any" });
		const b = makeEntry({ id: "b", ...g, constant: false, keys: ["storm", "rain"] });
		const result = resolveActivatedEntries(makeInput([a, b], ["storm rain thunder calm"]));
		expect(activatedIds(result)).toEqual(["b"]);
	});

	it("constant with matching keys competes at those matches; constant without keys scores 0", () => {
		// Keyed constant (2 matches) beats a 1-match keyed entry...
		const c1 = makeEntry({ id: "c1", ...g, keys: ["storm", "rain"] });
		const k1 = makeEntry({ id: "k1", ...g, constant: false, keys: ["calm"] });
		expect(activatedIds(resolveActivatedEntries(makeInput([c1, k1], ["storm rain calm"])))).toEqual(["c1"]);
		// ...but a keyless constant (0) loses to a 1-match keyed entry.
		const c2 = makeEntry({ id: "c2", ...g, keys: [] });
		const k2 = makeEntry({ id: "k2", ...g, constant: false, keys: ["calm"] });
		expect(activatedIds(resolveActivatedEntries(makeInput([c2, k2], ["storm rain calm"])))).toEqual(["k2"]);
	});
});

describe("inclusion groups — groupName field drives group resolution", () => {
	it("entries with no group are all kept (no pruning)", () => {
		const a = makeEntry({ id: "a" });
		const b = makeEntry({ id: "b" });
		const result = resolveActivatedEntries(makeInput([a, b]));
		// No group → group resolver leaves them both in.
		expect(activatedIds(result).sort()).toEqual(["a", "b"]);
	});

	it("keeps at most one entry per group when several share a groupName (weighted random)", () => {
		// Two entries in the same group, no prioritizeInclusion/useGroupScoring.
		// The resolver must keep exactly ONE of them.
		const a = makeEntry({ id: "a", groupName: "weather", groupWeight: 100 });
		const b = makeEntry({ id: "b", groupName: "weather", groupWeight: 100 });
		const result = resolveActivatedEntries(makeInput([a, b]));
		const ids = activatedIds(result);
		expect(ids).toHaveLength(1);
		expect(["a", "b"]).toContain(ids[0]);
	});

	it("prioritizeInclusion wins its group regardless of weight", () => {
		const winner = makeEntry({ id: "winner", groupName: "weather", groupWeight: 1, prioritizeInclusion: true });
		const heavy = makeEntry({ id: "heavy", groupName: "weather", groupWeight: 1000 });
		const result = resolveActivatedEntries(makeInput([winner, heavy]));
		expect(activatedIds(result)).toEqual(["winner"]);
	});

	it("entries in different groups are independent (one kept from each)", () => {
		const weather = makeEntry({ id: "weather", groupName: "weather", groupWeight: 100 });
		const mood = makeEntry({ id: "mood", groupName: "mood", groupWeight: 100 });
		const result = resolveActivatedEntries(makeInput([weather, mood]));
		// Each group has a single entry → both survive (no competitor to lose to).
		expect(activatedIds(result).sort()).toEqual(["mood", "weather"]);
	});

	it("comma-separated groupName is supported (ST-compatible multi-group)", () => {
		// ST allows an entry to belong to multiple groups via "g1, g2".
		// Here the entry competes in BOTH groups; it should still resolve once.
		const shared = makeEntry({ id: "shared", groupName: "weather, mood" });
		const wOnly = makeEntry({ id: "wOnly", groupName: "weather", groupWeight: 100 });
		const result = resolveActivatedEntries(makeInput([shared, wOnly]));
		// Only the "weather" group has 2 competitors → exactly one of weather's
		// entries survives. "mood" group has only "shared" but shared may already
		// have been pruned. Total activated = 1 (either shared or wOnly).
		expect(activatedIds(result)).toHaveLength(1);
	});
});

describe("inclusion groups — sticky × groups (LG-6 characterization)", () => {
	// Characterization-first (LG-6): the first four tests were pinned against
	// the pre-rework engine (sticky ignored by the group stage; losers
	// persisting activation state), then flipped to ST semantics: sticky-active
	// members (timed effect persisted from a PREVIOUS scan) dominate their
	// group — scoring/override/roll are all skipped, non-sticky members are
	// removed, ALL sticky members survive together — and only pass SURVIVORS
	// write activation state (ST setTimedEffects runs after the scan).
	const g = { groupName: "g", useGroupScoring: true, groupWeight: 0 };
	const stickyState = { activatedAtTurn: 1, lastMatchedAtTurn: 1 };

	it("LG-6: a sticky-active constant dominates its group — the higher scorer is removed (D8)", () => {
		const sSticky = makeEntry({ id: "s_sticky", ...g, keys: [] as string[], stickyWindow: 5 });
		const sScorer = makeEntry({ id: "s_scorer", ...g, keys: ["storm", "rain"] });
		const result = resolveActivatedEntries({
			...makeInput([sSticky, sScorer], ["storm rain calm"]),
			activationState: { s_sticky: stickyState },
		});
		// Pre-LG6 pin: ["s_scorer"] (the sticky constant scored 0 and lost).
		expect(activatedIds(result)).toEqual(["s_sticky"]);
	});

	it("LG-6: a sticky AUTO-activation (no keys this scan) also dominates the group", () => {
		const autoSticky = makeEntry({
			id: "auto_sticky", ...g, constant: false, keys: [] as string[], stickyWindow: 5,
		});
		const competitor = makeEntry({ id: "competitor", ...g, keys: ["storm"] });
		const result = resolveActivatedEntries({
			...makeInput([autoSticky, competitor], ["storm calm"]),
			activationState: { auto_sticky: stickyState },
		});
		// Pre-LG6 pin: ["competitor"] (the sticky auto-activation scored 0).
		expect(activatedIds(result)).toEqual(["auto_sticky"]);
	});

	it("LG-6: ALL sticky-active members survive together — no single winner is rolled", () => {
		const stickyA = makeEntry({ id: "sticky_a", ...g, keys: [] as string[], stickyWindow: 5 });
		const stickyB = makeEntry({ id: "sticky_b", ...g, keys: [] as string[], stickyWindow: 5 });
		const scorer = makeEntry({ id: "scorer", ...g, keys: ["storm", "rain"] });
		const result = resolveActivatedEntries({
			...makeInput([stickyA, stickyB, scorer], ["storm rain calm"]),
			activationState: { sticky_a: stickyState, sticky_b: stickyState },
		});
		// Pre-LG6 pin: ["scorer"]. ST keeps every sticky member (no resolution).
		expect(activatedIds(result).sort()).toEqual(["sticky_a", "sticky_b"]);
	});

	it("LG-6: a group LOSER writes NO state — no sticky resurrection on the next scan (ST setTimedEffects parity)", () => {
		// Scan 1: loser (stickyWindow 5) activates by key match but loses the
		// scoring filter; its state was still written at activation time.
		const loser = makeEntry({ id: "loser", ...g, constant: false, keys: ["storm"], stickyWindow: 5 });
		const winner = makeEntry({ id: "winner", ...g, constant: false, keys: ["storm", "rain"] });
		const scan1 = resolveActivatedEntries(makeInput([loser, winner], ["storm rain calm"]));
		expect(activatedIds(scan1)).toEqual(["winner"]);
		// Pre-LG6 pin: the loser persisted activatedAtTurn=1 despite losing.
		expect(scan1.updatedState.loser).toBeUndefined();

		// Scan 2 (next turn, no key matches at all): nothing resurrects the
		// loser — it never reached the prompt, so it never got sticky state.
		const scan2 = resolveActivatedEntries({
			...makeInput([loser], ["nothing relevant"]),
			activationState: scan1.updatedState,
			currentTurn: 2,
		});
		expect(activatedIds(scan2)).toEqual([]);
	});
});
