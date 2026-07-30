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
	it("lorebookToDraft projects the draft-relevant fields and stamps no mode", () => {
		const draft = lorebookToDraft({
			id: "lb_1", name: "N", description: "d", scopeType: "character",
			scanDepth: 7, tokenBudget: 500, recursiveScanning: true, enabled: false,
		});
		expect(draft).toEqual({
			id: "lb_1", name: "N", description: "d", scopeType: "character",
			scanDepth: 7, tokenBudget: 500, recursiveScanning: true, enabled: false,
		});
		// No mode here — LoreDraftState.importLorebook stamps mode:"edit".
		expect(draft.mode).toBeUndefined();
	});

	it("entryToDraft projects the draft-relevant fields (decoded domain types)", () => {
		const draft = entryToDraft({
			id: "le_1", lorebookId: "lb_1", title: "T", content: "c",
			keys: ["k1"], secondaryKeys: ["s1"], constant: true,
			position: "before_char", depth: 4, logic: "and_all", enabled: true,
		});
		expect(draft).toEqual({
			id: "le_1", lorebookId: "lb_1", title: "T", content: "c",
			keys: ["k1"], secondaryKeys: ["s1"], constant: true,
			position: "before_char", depth: 4, logic: "and_all", enabled: true,
		});
	});
});

describe("createLoreEntityLookup (CE-B1)", () => {
	function makeStore(): LoreDraftReadStore {
		return {
			getLorebook: async (id) =>
				id === "lb_1"
					? { id: "lb_1", name: "N", description: "", scopeType: "character", scanDepth: 10, tokenBudget: 1000, recursiveScanning: false, enabled: true }
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
