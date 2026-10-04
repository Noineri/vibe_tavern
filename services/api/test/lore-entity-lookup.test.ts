/**
 * CE-B1 — lore entity lookup mapper + factory tests.
 *
 * Pins the decoded-store-row → co-author-draft-contract projection and the
 * `createLoreEntityLookup` factory's null/known-id contract. The store mock is
 * a plain object satisfying `LoreDraftReadStore` (no cast) — the lookup reads
 * only the draft-relevant fields.
 */
import { describe, expect, it } from "bun:test";
import {
	createLoreEntityLookup,
	entryToDraft,
	lorebookToDraft,
	type LoreDraftReadStore,
} from "../src/domain/coauthor/lore/lore-entity-lookup.js";

describe("lore-entity-lookup mappers (CE-B1)", () => {
	it("lorebookToDraft projects the FULL current state (every contract settings field) and stamps no mode", () => {
		const draft = lorebookToDraft({
			id: "lb_1", name: "N", description: "d", scopeType: "entity",
			scanDepth: 7, tokenBudget: 500, tokenBudgetPercent: 30, tokenBudgetCap: 2000,
			recursiveScanning: true, useGroupScoring: true, caseSensitive: true, matchWholeWords: true,
			maxRecursionSteps: 3, includeNames: false, minActivations: 2, minActivationsDepthMax: 20,
			overflowAlert: true, characterStrategy: 2, enabled: false,
		});
		expect(draft).toEqual({
			id: "lb_1", name: "N", description: "d", scopeType: "entity",
			scanDepth: 7, tokenBudget: 500, recursiveScanning: true, enabled: false,
			tokenBudgetPercent: 30, tokenBudgetCap: 2000, useGroupScoring: true,
			caseSensitive: true, matchWholeWords: true, maxRecursionSteps: 3,
			includeNames: false, minActivations: 2, minActivationsDepthMax: 20,
			overflowAlert: true, characterStrategy: 2,
		});
		// No mode here — LoreDraftState.importLorebook stamps mode:"edit".
		expect(draft.mode).toBeUndefined();
	});

	it("entryToDraft projects the FULL current state (every contract settings field)", () => {
		const draft = entryToDraft({
			id: "le_1", lorebookId: "lb_1", title: "T", content: "c",
			keys: ["k1"], secondaryKeys: ["s1"], constant: true,
			position: "before_char", depth: 4, logic: "and_all", enabled: true,
			priority: 42, probability: 77, ignoreBudget: true, role: "assistant",
			groupName: "squad", groupWeight: 55, prioritizeInclusion: true,
			useGroupScoring: null, excludeRecursion: true, preventRecursion: true,
			delayUntilRecursion: true, recursionLevel: 4, scanDepthOverride: 9,
			caseSensitive: null, matchWholeWords: true, caseFormsKeys: ["дракон"],
			characterFilter: [{ id: null, name: "Alice" }], characterFilterExclude: true,
			matchSources: ["chat_messages", "scenario"],
			stickyWindow: 3, cooldownWindow: 5, minChatMessages: 2,
		});
		expect(draft).toEqual({
			id: "le_1", lorebookId: "lb_1", title: "T", content: "c",
			keys: ["k1"], secondaryKeys: ["s1"], constant: true,
			position: "before_char", depth: 4, logic: "and_all", enabled: true,
			priority: 42, probability: 77, ignoreBudget: true, role: "assistant",
			groupName: "squad", groupWeight: 55, prioritizeInclusion: true,
			useGroupScoring: null, excludeRecursion: true, preventRecursion: true,
			delayUntilRecursion: true, recursionLevel: 4, scanDepthOverride: 9,
			caseSensitive: null, matchWholeWords: true, caseFormsKeys: ["дракон"],
			characterFilter: [{ id: null, name: "Alice" }], characterFilterExclude: true,
			matchSources: ["chat_messages", "scenario"],
			stickyWindow: 3, cooldownWindow: 5, minChatMessages: 2,
		});
		// Tri-state null survives the projection (it is a set value, not unset).
		expect(draft.useGroupScoring).toBeNull();
		expect(draft.caseSensitive).toBeNull();
	});
});

describe("createLoreEntityLookup (CE-B1)", () => {
	function makeStore(): LoreDraftReadStore {
		return {
			getLorebook: async (id) =>
				id === "lb_1"
					? { id: "lb_1", name: "N", description: "", scopeType: "entity", scanDepth: 10, tokenBudget: 1000, recursiveScanning: false, enabled: true }
					: null,
			getEntry: async (id) =>
				id === "le_1"
					? { id: "le_1", lorebookId: "lb_1", title: "T", content: "c", keys: ["k"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, logic: "and_any", enabled: true }
					: null,
		};
	}

	it("returns a draft node for a known id and null for an unknown one", async () => {
		const lookup = createLoreEntityLookup(makeStore());
		expect((await lookup.lorebook("lb_1"))?.id).toBe("lb_1");
		expect(await lookup.lorebook("ghost")).toBeNull();
		expect((await lookup.entry("le_1"))?.title).toBe("T");
		expect(await lookup.entry("ghost")).toBeNull();
	});

	it("projects decoded rows into the draft contract (booleans / string arrays preserved)", async () => {
		const lookup = createLoreEntityLookup(makeStore());
		const e = await lookup.entry("le_1");
		expect(e).toMatchObject({ constant: false, keys: ["k"], logic: "and_any" });
	});
});
