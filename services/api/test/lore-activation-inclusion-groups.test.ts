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
