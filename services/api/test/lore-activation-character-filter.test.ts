import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Characterization tests for the characterFilter matching path of the LIVE
 * activation engine (`lore-activation-engine.ts`).
 *
 * The live engine had ZERO characterFilter coverage before this file (the
 * sibling `packages/prompt-pipeline/test/lore-activation.test.ts` covers a
 * DEAD orphan copy with a different API). These tests pin the CURRENT name-based
 * behavior at `tryActivateEntry` step 2 so the id-based migration (see
 * CHARACTER_FILTER_ID_MIGRATION_PLAN.md) can prove it preserves/changes
 * behavior deliberately.
 *
 * Isolation strategy: every entry is `constant: true` + `ignoreBudget: true`.
 * Constant entries activate at step 4 (after the characterFilter gate at step 2),
 * so the filter is the ONLY thing that can block activation — no keys/messages
 * needed.
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
		group: "",
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
		characterFilter: [] as string[],
		characterFilterExclude: false,
		triggers: [] as string[],
		matchSources: [] as string[],
		enabled: true,
		sortOrder: 0,
		...overrides,
	};
}

function makeInput(entries: ReturnType<typeof makeEntry>[], characterName: string): ActivationInput {
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
		characterName,
		activationState: {},
		currentTurn: 1,
	};
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
	return result.activatedEntries.map((e) => e.id);
}

describe("characterFilter — current name-based matching (characterization)", () => {
	it("include mode (exclude=false): activates when characterName is in the filter", () => {
		const entry = makeEntry({ characterFilter: ["Alice"] });
		const result = resolveActivatedEntries(makeInput([entry], "Alice"));
		expect(activatedIds(result)).toEqual([entry.id]);
	});

	it("include mode (exclude=false): skips when characterName is NOT in the filter", () => {
		const entry = makeEntry({ characterFilter: ["Alice"] });
		const result = resolveActivatedEntries(makeInput([entry], "Bob"));
		expect(activatedIds(result)).toEqual([]);
	});

	it("include mode (exclude=false): empty filter = no gate (activates for anyone)", () => {
		const entry = makeEntry({ characterFilter: [] });
		const result = resolveActivatedEntries(makeInput([entry], "Anyone"));
		expect(activatedIds(result)).toEqual([entry.id]);
	});

	it("include mode (exclude=false): matches by exact name (case-sensitive)", () => {
		const entry = makeEntry({ characterFilter: ["Alice"] });
		// Different case does NOT match — current behavior is a plain `.includes()`.
		const result = resolveActivatedEntries(makeInput([entry], "alice"));
		expect(activatedIds(result)).toEqual([]);
	});

	it("exclude mode (exclude=true): skips when characterName IS in the filter", () => {
		const entry = makeEntry({ characterFilter: ["Alice"], characterFilterExclude: true });
		const result = resolveActivatedEntries(makeInput([entry], "Alice"));
		expect(activatedIds(result)).toEqual([]);
	});

	it("exclude mode (exclude=true): activates when characterName is NOT in the filter", () => {
		const entry = makeEntry({ characterFilter: ["Alice"], characterFilterExclude: true });
		const result = resolveActivatedEntries(makeInput([entry], "Bob"));
		expect(activatedIds(result)).toEqual([entry.id]);
	});

	it("exclude mode (exclude=true): empty filter = no gate (activates for anyone)", () => {
		const entry = makeEntry({ characterFilter: [], characterFilterExclude: true });
		const result = resolveActivatedEntries(makeInput([entry], "Anyone"));
		expect(activatedIds(result)).toEqual([entry.id]);
	});
});
