/**
 * CTX-L3 — lore-selection (pure).
 *
 * Pins the parent-dependency invariant: an entry is included ONLY if both it
 * AND its parent lorebook are selected, so a turn can never apply an entry
 * whose book was rejected.
 */
import { describe, it, expect } from "bun:test";
import type { CoauthorLoreBundle } from "@vibe-tavern/api-contracts";
import {
	selectLoreBundle,
	allLorebookIds,
	allEntryIds,
	orphanEntryIds,
} from "./lore-selection.js";

function bundle(): CoauthorLoreBundle {
	return {
		lorebooks: [
			{ id: "lb1", name: "World Lore", description: "", scopeType: "global", enabled: true },
			{ id: "lb2", name: "Char Lore", description: "", scopeType: "character", enabled: true },
		],
		entries: [
			{ id: "e1", lorebookId: "lb1", title: "A", content: "c", keys: ["k"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
			{ id: "e2", lorebookId: "lb1", title: "B", content: "c", keys: ["k"], secondaryKeys: [], constant: true, position: "before_char", depth: 4, enabled: true },
			{ id: "e3", lorebookId: "lb2", title: "C", content: "c", keys: ["k"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
		],
	};
}

describe("selectLoreBundle — parent-dependency enforcement (CTX-L3)", () => {
	it("all-selected returns the full bundle", () => {
		const out = selectLoreBundle(bundle(), allLorebookIds(bundle()), allEntryIds(bundle()));
		expect(out.lorebooks).toHaveLength(2);
		expect(out.entries).toHaveLength(3);
	});

	it("rejecting a lorebook drops its entries even if they are individually selected (no orphan entries ship)", () => {
		const b = bundle();
		const out = selectLoreBundle(b, new Set(["lb1"]), allEntryIds(b));
		expect(out.lorebooks.map((lb) => lb.id)).toEqual(["lb1"]);
		// e3 (lb2) is dropped — its parent was rejected, even though e3 was selected.
		expect(out.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
	});

	it("rejecting an entry keeps its lorebook and siblings", () => {
		const b = bundle();
		const out = selectLoreBundle(b, allLorebookIds(b), new Set(["e1", "e3"]));
		expect(out.lorebooks).toHaveLength(2);
		expect(out.entries.map((e) => e.id)).toEqual(["e1", "e3"]);
	});

	it("empty selection yields an empty bundle (Apply then omits lore)", () => {
		const out = selectLoreBundle(bundle(), new Set(), new Set());
		expect(out.lorebooks).toEqual([]);
		expect(out.entries).toEqual([]);
	});

	it("entry whose parent is not in the bundle and was NOT verified as persisted is dropped", () => {
		const b: CoauthorLoreBundle = {
			lorebooks: [],
			entries: [{ id: "e9", lorebookId: "ghost", title: "X", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true }],
		};
		// No parentMode marker: this is a real malformed orphan, not an intentional
		// reference to a DB-existing lorebook.
		const out = selectLoreBundle(b, new Set(), new Set(["e9"]));
		expect(out.entries).toEqual([]);
	});

	it("CE-B2: selected entry with parentMode:persisted survives without a proposed parent", () => {
		const b: CoauthorLoreBundle = {
			lorebooks: [],
			entries: [{ id: "ePersisted", lorebookId: "lb_existing", title: "Edit", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true, mode: "edit", parentMode: "persisted" }],
		};
		const out = selectLoreBundle(b, new Set(), new Set(["ePersisted"]));
		expect(out.entries.map((e) => e.id)).toEqual(["ePersisted"]);
	});

	it("CE-B2: rejecting a persisted-parent edit drops it from Apply", () => {
		const b: CoauthorLoreBundle = {
			lorebooks: [],
			entries: [{ id: "ePersisted", lorebookId: "lb_existing", title: "Edit", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true, mode: "edit", parentMode: "persisted" }],
		};
		const out = selectLoreBundle(b, new Set(), new Set());
		expect(out).toEqual({ lorebooks: [], entries: [] });
	});

	it("order is preserved (the model's authoring order)", () => {
		const out = selectLoreBundle(bundle(), allLorebookIds(bundle()), allEntryIds(bundle()));
		expect(out.lorebooks.map((lb) => lb.id)).toEqual(["lb1", "lb2"]);
		expect(out.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
	});
});

describe("allLorebookIds / allEntryIds / orphanEntryIds (CTX-L3)", () => {
	it("all* return every id; orphanEntryIds is empty for a well-formed bundle", () => {
		const b = bundle();
		expect(allLorebookIds(b)).toEqual(new Set(["lb1", "lb2"]));
		expect(allEntryIds(b)).toEqual(new Set(["e1", "e2", "e3"]));
		expect(orphanEntryIds(b)).toEqual(new Set());
	});

	it("orphanEntryIds flags an absent unverified parent but excludes a verified persisted parent", () => {
		const b: CoauthorLoreBundle = {
			lorebooks: [{ id: "lb1", name: "L", description: "", scopeType: "global", enabled: true }],
			entries: [
				{ id: "e1", lorebookId: "lb1", title: "A", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
				{ id: "e9", lorebookId: "ghost", title: "X", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true },
				{ id: "ePersisted", lorebookId: "lb_existing", title: "Edit", content: "c", keys: [], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true, parentMode: "persisted" },
			],
		};
		expect(orphanEntryIds(b)).toEqual(new Set(["e9"]));
	});
});
