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
		triggers: [] as string[],
		matchSources: [] as string[],
		enabled: true,
		sortOrder: 0,
		...overrides,
	};
}

function makeInput(entries: ReturnType<typeof makeEntry>[]): ActivationInput {
	return {
		lorebooks: [
			{
				id: "lb_test",
				scanDepth: 1,
				tokenBudget: 100_000,
				recursiveScanning: false,
				maxRecursionSteps: 0,
				includeNames: false,
				minActivations: 0,
				minActivationsDepthMax: 0,
				entries,
			},
		],
		messages: [],
		mode: "normal",
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
