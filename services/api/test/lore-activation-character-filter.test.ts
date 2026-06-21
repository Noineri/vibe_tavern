import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Tests for the characterFilter matching path of the LIVE activation engine
 * (`lore-activation-engine.ts`), after the id-based migration
 * (CHARACTER_FILTER_ID_MIGRATION_PLAN.md, Option B: name fallback for ghosts).
 *
 * Option B semantics under test: a filter entry matches the active character if
 * EITHER its bound `id` equals the active `characterId` (rename-resilient), OR
 * it is a ghost (`id === null`) whose `name` equals the active `characterName`
 * (legacy / imported data keeps working by name until bound in the UI).
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
		characterFilter: [] as Array<{ id: string | null; name: string }>,
		characterFilterExclude: false,
		matchSources: [] as string[],
		enabled: true,
		sortOrder: 0,
		...overrides,
	};
}

function makeInput(
	entries: ReturnType<typeof makeEntry>[],
	character: { id: string; name: string },
): ActivationInput {
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
		messages: [],
		macroMap: {},
		characterId: character.id,
		characterName: character.name,
		activationState: {},
		currentTurn: 1,
	};
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
	return result.activatedEntries.map((e) => e.id);
}

describe("characterFilter — id-based matching (Option B)", () => {
	describe("include mode (exclude=false)", () => {
		it("activates when an id-bound entry matches the active characterId", () => {
			const entry = makeEntry({ characterFilter: [{ id: "c_alice", name: "Alice" }] });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_alice", name: "Alice" }));
			expect(activatedIds(result)).toEqual([entry.id]);
		});

		it("skips when no id-bound entry matches the active characterId", () => {
			const entry = makeEntry({ characterFilter: [{ id: "c_alice", name: "Alice" }] });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_bob", name: "Bob" }));
			expect(activatedIds(result)).toEqual([]);
		});

		it("still matches by id after the character is renamed (the whole point of the migration)", () => {
			// Filter bound to Alice's id; the active character has that id but a new name.
			const entry = makeEntry({ characterFilter: [{ id: "c_alice", name: "Alice" }] });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_alice", name: "Alice Renamed" }));
			expect(activatedIds(result)).toEqual([entry.id]);
		});

		it("ghost (id=null) matches by name fallback — legacy data keeps working", () => {
			const entry = makeEntry({ characterFilter: [{ id: null, name: "Alice" }] });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_alice", name: "Alice" }));
			expect(activatedIds(result)).toEqual([entry.id]);
		});

		it("ghost (id=null) does NOT match when the active name differs", () => {
			const entry = makeEntry({ characterFilter: [{ id: null, name: "Alice" }] });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_bob", name: "Bob" }));
			expect(activatedIds(result)).toEqual([]);
		});

		it("bound id wins: an entry bound to a different id does not match by name", () => {
			// Entry is bound to c_alice but still named "Alice"; active char is c_bob named "Alice".
			// The name matches but the bound id belongs to someone else → no match (no name fallback
			// for id-bound entries — that's what makes binding a permanent upgrade).
			const entry = makeEntry({ characterFilter: [{ id: "c_alice", name: "Alice" }] });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_bob", name: "Alice" }));
			expect(activatedIds(result)).toEqual([]);
		});

		it("empty filter = no gate (activates for anyone)", () => {
			const entry = makeEntry({ characterFilter: [] });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_anyone", name: "Anyone" }));
			expect(activatedIds(result)).toEqual([entry.id]);
		});
	});

	describe("exclude mode (exclude=true)", () => {
		it("skips when an id-bound entry matches the active characterId", () => {
			const entry = makeEntry({ characterFilter: [{ id: "c_alice", name: "Alice" }], characterFilterExclude: true });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_alice", name: "Alice" }));
			expect(activatedIds(result)).toEqual([]);
		});

		it("activates when the active characterId is NOT in the filter", () => {
			const entry = makeEntry({ characterFilter: [{ id: "c_alice", name: "Alice" }], characterFilterExclude: true });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_bob", name: "Bob" }));
			expect(activatedIds(result)).toEqual([entry.id]);
		});

		it("ghost (id=null) excludes by name fallback", () => {
			const entry = makeEntry({ characterFilter: [{ id: null, name: "Alice" }], characterFilterExclude: true });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_alice", name: "Alice" }));
			expect(activatedIds(result)).toEqual([]);
		});

		it("ghost (id=null) does not exclude a differently-named character", () => {
			const entry = makeEntry({ characterFilter: [{ id: null, name: "Alice" }], characterFilterExclude: true });
			const result = resolveActivatedEntries(makeInput([entry], { id: "c_bob", name: "Bob" }));
			expect(activatedIds(result)).toEqual([entry.id]);
		});
	});
});
