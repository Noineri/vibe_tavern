/**
 * Characterization tests for the lore-entry reorder logic.
 *
 * These pin the `onReorder` contract (the {id, sortOrder, position?} update
 * array committed to the store) BEFORE refactoring LoreEntryList's DnD from a
 * manual portal to sortable + DragOverlay. The DOM/gesture layer is validated
 * via Playwright; this test guards the pure commit logic that the refactor must
 * preserve verbatim.
 *
 * Data-model invariant under test: `sortOrder` is a GLOBAL flat index. The UI
 * groups by `position` visually, but a reorder renumbers every entry densely
 * (0..N-1) and only the dragged entry may get a new `position` (if it crossed
 * sections).
 */
import { describe, it, expect } from "bun:test";
import {
	buildReorderUpdates,
	getSection,
	entryOrderSignature,
	POSITION_SECTIONS,
	type LoreReorderUpdate,
} from "./lore-entry-reorder.js";
import type { LoreEntryRecord } from "../../../app-client.js";

/** Minimal factory — only id/position matter for reorder logic. */
function entry(id: string, position: string, sortOrder: number): LoreEntryRecord {
	return {
		id,
		lorebookId: "lb_1",
		title: id,
		content: "",
		keys: [],
		secondaryKeys: [],
		logic: "and_any",
		position,
		depth: 4,
		priority: 100,
		stickyWindow: 0,
		cooldownWindow: 0,
		delayWindow: 0,
		enabled: true,
		constant: false,
		probability: 100,
		ignoreBudget: false,
		role: "system",
		groupName: "",
		groupWeight: 1,
		prioritizeInclusion: false,
		useGroupScoring: false,
		excludeRecursion: false,
		preventRecursion: false,
		delayUntilRecursion: false,
		recursionLevel: 0,
		scanDepthOverride: null,
		caseSensitive: false,
		matchWholeWords: false,
		characterFilter: [],
		characterFilterExclude: false,
		matchSources: [],
		sortOrder,
	} as LoreEntryRecord;
}

/** A flat list as the list renders it: sections in POSITION_SECTIONS order. */
function flatList(): LoreEntryRecord[] {
	return [
		entry("a", "before_char", 0),
		entry("b", "before_char", 1),
		entry("c", "after_char", 2),
		entry("d", "after_char", 3),
	];
}

function ids(updates: LoreReorderUpdate[] | null): string[] {
	return (updates ?? []).map((u) => u.id);
}

function sortOrderMap(updates: LoreReorderUpdate[] | null): Record<string, number> {
	const map: Record<string, number> = {};
	for (const u of updates ?? []) map[u.id] = u.sortOrder;
	return map;
}

function positionMap(updates: LoreReorderUpdate[] | null): Record<string, string | undefined> {
	const map: Record<string, string | undefined> = {};
	for (const u of updates ?? []) map[u.id] = u.position;
	return map;
}

describe("buildReorderUpdates — same-section drag", () => {
	it("moves an entry earlier within its section and renumbers everyone densely", () => {
		// Drag "b" onto "a" (both before_char). b should land before a.
		const updates = buildReorderUpdates(flatList(), "b", "a");
		expect(ids(updates)).toEqual(["b", "a", "c", "d"]);
		expect(sortOrderMap(updates)).toEqual({ a: 1, b: 0, c: 2, d: 3 });
	});

	it("moves an entry later within its section and renumbers everyone densely", () => {
		// Drag "a" onto "b" (both before_char). a lands where b was.
		const updates = buildReorderUpdates(flatList(), "a", "b");
		expect(ids(updates)).toEqual(["b", "a", "c", "d"]);
		expect(sortOrderMap(updates)).toEqual({ a: 1, b: 0, c: 2, d: 3 });
	});

	it("does not emit a position change when the section is unchanged", () => {
		const updates = buildReorderUpdates(flatList(), "c", "d");
		// c and d are both after_char — no position field on any update.
		expect(positionMap(updates)).toEqual({ a: undefined, b: undefined, c: undefined, d: undefined });
	});
});

describe("buildReorderUpdates — cross-section drag", () => {
	it("moves an entry into another section and retags only the dragged entry's position", () => {
		// Drag "a" (before_char) onto "c" (after_char). a moves to c's slot
		// and a.position becomes after_char. b/c/d keep their positions.
		const updates = buildReorderUpdates(flatList(), "a", "c");
		expect(ids(updates)).toEqual(["b", "c", "a", "d"]);
		expect(sortOrderMap(updates)).toEqual({ a: 2, b: 0, c: 1, d: 3 });
		expect(positionMap(updates)).toEqual({ a: "after_char", b: undefined, c: undefined, d: undefined });
	});

	it("moves an entry into an earlier section and retags only the dragged entry", () => {
		// Drag "d" (after_char) onto "a" (before_char).
		const updates = buildReorderUpdates(flatList(), "d", "a");
		expect(ids(updates)).toEqual(["d", "a", "b", "c"]);
		expect(positionMap(updates)).toEqual({ d: "before_char", a: undefined, b: undefined, c: undefined });
	});
});

describe("buildReorderUpdates — no-op cases", () => {
	it("returns null when over === active", () => {
		expect(buildReorderUpdates(flatList(), "a", "a")).toBeNull();
	});

	it("returns null when ids are missing", () => {
		expect(buildReorderUpdates(flatList(), null, "a")).toBeNull();
		expect(buildReorderUpdates(flatList(), "a", null)).toBeNull();
		expect(buildReorderUpdates(flatList(), undefined, undefined)).toBeNull();
	});

	it("returns null when an id is not in the list", () => {
		expect(buildReorderUpdates(flatList(), "a", "zzz")).toBeNull();
		expect(buildReorderUpdates(flatList(), "zzz", "a")).toBeNull();
	});
});

describe("buildReorderUpdates — dense global sortOrder invariant", () => {
	it("resulting sortOrder values are always a dense 0..N-1 sequence", () => {
		const updates = buildReorderUpdates(flatList(), "d", "a");
		const orders = (updates ?? []).map((u) => u.sortOrder).sort((x, y) => x - y);
		expect(orders).toEqual([0, 1, 2, 3]);
	});

	it("preserves the global-flat-order model: a cross-section drag does not reorder other sections' internals", () => {
		// Drag "a" (before_char, idx 0) onto "c" (after_char, idx 2).
		// b stays first in before_char; c/d stay in after_char and keep their
		// relative order. Only a moved and changed section.
		const updates = buildReorderUpdates(flatList(), "a", "c");
		// Reconstruct the post-drag flat list from the updates.
		const reordered = (updates ?? [])
			.slice()
			.sort((x, y) => x.sortOrder - y.sortOrder)
			.map((u) => u.id);
		expect(reordered).toEqual(["b", "c", "a", "d"]);
		// b is still before_char, a is now after_char, c/d unchanged in section.
		expect(positionMap(updates)).toEqual({ a: "after_char", b: undefined, c: undefined, d: undefined });
	});
});

describe("position helpers (characterization)", () => {
	it("legacy positions are normalized into UI sections", () => {
		expect(getSection("before_prompt").value).toBe("before_char");
		expect(getSection("in_prompt").value).toBe("after_char");
		expect(getSection("in_chat").value).toBe("at_depth");
		expect(getSection("hidden_system").value).toBe("outlet");
	});

	it("unknown/missing position falls back to after_char", () => {
		expect(getSection(undefined).value).toBe("after_char");
		expect(getSection("nonsense").value).toBe("after_char");
	});

	it("entryOrderSignature is section-aware (ignores raw legacy position)", () => {
		const a = [entry("x", "before_prompt", 0)];
		const b = [entry("x", "before_char", 0)];
		// Both normalize to before_char → same signature.
		expect(entryOrderSignature(a)).toBe(entryOrderSignature(b));
	});

	it("POSITION_SECTIONS covers the 8 UI sections", () => {
		expect(POSITION_SECTIONS.map((s) => s.value)).toEqual([
			"before_char",
			"after_char",
			"top_an",
			"bottom_an",
			"before_examples",
			"after_examples",
			"at_depth",
			"outlet",
		]);
	});
});
