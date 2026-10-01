import { describe, expect, test } from "bun:test";

import type { LinkBindingRecord, LinkBindingTargetType, LinkTarget } from "./link-targets.js";
import { deriveLinkSections, matchesLinkQuery, orderLinkTargets } from "./link-binding-sections.js";

/** Minimal LinkTarget factory — id, name, updatedAt (avatar fields null). */
function tgt(id: string, name: string, updatedAt: string | null): LinkTarget {
	return { id, name, avatarAssetId: null, updatedAt };
}

function link(targetType: LinkBindingTargetType, targetId: string): LinkBindingRecord {
	return { targetType, targetId };
}

const BOUND = new Set(["bound-old", "bound-newest"]);

describe("orderLinkTargets (LB-2B)", () => {
	test("bound first, then updatedAt desc; null and unparseable last; input not mutated", () => {
		const input = [
			tgt("unbound-new", "U1", "2026-10-01T10:00:00.000Z"),
			tgt("bound-old", "B1", "2026-01-01T00:00:00.000Z"),
			tgt("unbound-older", "U2", "2026-05-01T00:00:00.000Z"),
			tgt("bound-newest", "B2", "2026-10-01T12:00:00.000Z"),
			tgt("unbound-null", "U3", null),
			tgt("unbound-garbage", "U4", "not-a-date"),
		];
		const ordered = orderLinkTargets(input, BOUND);
		expect(ordered.map((t) => t.id)).toEqual([
			// Bound group first, newest within the group.
			"bound-newest",
			"bound-old",
			// Unbound group, updatedAt desc; null + unparseable sort last.
			"unbound-new",
			"unbound-older",
			"unbound-null",
			"unbound-garbage",
		]);
		// The input array is untouched.
		expect(input.map((t) => t.id)).toEqual([
			"unbound-new",
			"bound-old",
			"unbound-older",
			"bound-newest",
			"unbound-null",
			"unbound-garbage",
		]);
	});

	test("name tie-break is base-insensitive, id is the final deterministic tie", () => {
		const input = [
			tgt("zz", "beta", "2026-10-01T00:00:00.000Z"),
			tgt("bb", "BETA", "2026-10-01T00:00:00.000Z"),
			tgt("mm", "alpha", "2026-10-01T00:00:00.000Z"),
			tgt("aa", "alpha", "2026-10-01T00:00:00.000Z"),
		];
		expect(orderLinkTargets(input, new Set()).map((t) => t.id)).toEqual(["aa", "mm", "bb", "zz"]);
	});
});

describe("matchesLinkQuery (LB-2B)", () => {
	test("empty and whitespace-only queries match everything", () => {
		expect(matchesLinkQuery("Anything", "")).toBe(true);
		expect(matchesLinkQuery("Anything", "   ")).toBe(true);
	});

	test("case-insensitive substring; query is trimmed", () => {
		expect(matchesLinkQuery("Anna Karenina", "karen")).toBe(true);
		expect(matchesLinkQuery("Anna Karenina", "  ANNA ")).toBe(true);
		expect(matchesLinkQuery("Anna Karenina", "vronsky")).toBe(false);
	});

	test("Cyrillic matches through toLocaleLowerCase on both sides", () => {
		// Name "\u0410\u043d\u043d\u0430" (Anna), query "\u0430\u043d\u043d" (ann).
		expect(matchesLinkQuery("\u0410\u043d\u043d\u0430", "\u0430\u043d\u043d")).toBe(true);
		// Uppercase query "\u0410\u041d\u041d" matches the same name.
		expect(matchesLinkQuery("\u0410\u043d\u043d\u0430", "\u0410\u041d\u041d")).toBe(true);
		expect(matchesLinkQuery("\u0410\u043d\u043d\u0430", "\u0411\u043e\u0440\u0438\u0441")).toBe(false);
	});
});

describe("deriveLinkSections (LB-2B)", () => {
	const T = (id: string, name: string, updatedAt: string) => tgt(id, name, updatedAt);

	test("collapsed: all bound + first visibleLimit unbound, hiddenCount = rest, matchCount = targets.length", () => {
		const result = deriveLinkSections({
			sections: [{ key: "character", targets: [T("a", "A", "2026-10-05"), T("b", "B", "2026-10-04"), T("c", "C", "2026-10-03"), T("d", "D", "2026-10-02"), T("e", "E", "2026-10-01")] }],
			links: [link("character", "a"), link("character", "c")],
			query: "",
			expanded: new Set(),
			visibleLimit: 2,
		});
		expect(result.sections).toHaveLength(1);
		const view = result.sections[0];
		// Bound a, c first (a newer), then the 2 newest unbound (d, e over b? no:
		// unbound are b (10-04), d (10-02), e (10-01) — newest first: b, d, e).
		expect(view.items.map((t) => t.id)).toEqual(["a", "c", "b", "d"]);
		expect(view.hiddenCount).toBe(1);
		expect(view.expanded).toBe(false);
		expect(view.collapsible).toBe(false);
		expect(view.matchCount).toBe(5);
		expect([...view.boundIds]).toEqual(["a", "c"]);
	});

	test("bound items are never hidden, even when they outnumber the limit", () => {
		const result = deriveLinkSections({
			sections: [{ key: "lorebook", targets: [T("b1", "B1", "2026-10-01"), T("b2", "B2", "2026-10-02"), T("b3", "B3", "2026-10-03"), T("u1", "U1", "2026-10-04"), T("u2", "U2", "2026-10-05")] }],
			links: [link("lorebook", "b1"), link("lorebook", "b2"), link("lorebook", "b3")],
			query: "",
			expanded: new Set(),
			visibleLimit: 2,
		});
		const view = result.sections[0];
		// 3 bound (all visible) + 2 unbound (limit 2) — nothing hidden.
		expect(view.items.map((t) => t.id)).toEqual(["b3", "b2", "b1", "u2", "u1"]);
		expect(view.hiddenCount).toBe(0);
	});

	test("expanded: all items, hiddenCount 0, collapsible true when unbound > limit", () => {
		const targets = [T("b1", "B1", "2026-10-01"), T("u1", "U1", "2026-10-02"), T("u2", "U2", "2026-10-03"), T("u3", "U3", "2026-10-04")];
		const links = [link("script", "b1")];
		const result = deriveLinkSections({
			sections: [{ key: "script", targets }],
			links,
			query: "",
			expanded: new Set(["script"]),
			visibleLimit: 2,
		});
		const view = result.sections[0];
		expect(view.items.map((t) => t.id)).toEqual(["b1", "u3", "u2", "u1"]);
		expect(view.hiddenCount).toBe(0);
		expect(view.expanded).toBe(true);
		expect(view.collapsible).toBe(true); // 3 unbound > limit 2

		// Expanded but unbound <= limit → collapsible false (no «show less»).
		const result2 = deriveLinkSections({
			sections: [{ key: "script", targets: targets.slice(0, 3) }],
			links,
			query: "",
			expanded: new Set(["script"]),
			visibleLimit: 2,
		});
		expect(result2.sections[0].collapsible).toBe(false);
	});

	test("query: all matches shown (bound + unbound), hiddenCount 0, expanded ignored, empty-match sections omitted, noResults", () => {
		const result = deriveLinkSections({
			sections: [
				{ key: "character", targets: [T("anna", "Anna", "2026-10-01"), T("boris", "Boris", "2026-10-02")] },
				{ key: "lorebook", targets: [T("lb", "World lore", "2026-10-01")] },
			],
			links: [link("character", "boris")],
			query: "ANN",
			expanded: new Set(), // ignored while searching
			visibleLimit: 1,
		});
		expect(result.sections.map((s) => s.key)).toEqual(["character"]); // lorebook omitted
		const view = result.sections[0];
		expect(view.items.map((t) => t.id)).toEqual(["anna"]); // Boris does not match
		expect(view.matchCount).toBe(1);
		expect(view.hiddenCount).toBe(0);
		expect(view.expanded).toBe(true);
		expect(view.collapsible).toBe(false);
		expect(view.boundIds.has("boris")).toBe(true); // bound set is still the section's links
		expect(result.noResults).toBe(false);
		expect(result.totalTargets).toBe(3);

		const none = deriveLinkSections({
			sections: [{ key: "character", targets: [T("anna", "Anna", "2026-10-01")] }],
			links: [],
			query: "zzz",
			expanded: new Set(),
			visibleLimit: 1,
		});
		expect(none.sections).toHaveLength(0);
		expect(none.noResults).toBe(true);
	});

	test("Cyrillic query matches via both-sides lowercase", () => {
		const result = deriveLinkSections({
			sections: [{ key: "persona", targets: [T("p1", "\u0410\u043d\u043d\u0430", "2026-10-01"), T("p2", "\u041c\u0430\u0440\u0438\u044f", "2026-10-02")] }],
			links: [],
			query: "\u0430\u043d\u043d",
			expanded: new Set(),
			visibleLimit: 1,
		});
		expect(result.sections[0].items.map((t) => t.id)).toEqual(["p1"]);
	});

	test("sections with zero targets are always omitted; input order preserved", () => {
		const result = deriveLinkSections({
			sections: [
				{ key: "character", targets: [] },
				{ key: "lorebook", targets: [T("lb", "L", "2026-10-01")] },
				{ key: "script", targets: [] },
				{ key: "regex", targets: [T("rx", "R", "2026-10-01")] },
			],
			links: [],
			query: "",
			expanded: new Set(),
			visibleLimit: 6,
		});
		expect(result.sections.map((s) => s.key)).toEqual(["lorebook", "regex"]);
	});

	test("showSearch: false at exactly visibleLimit, true above it", () => {
		const base = {
			sections: [{ key: "character" as const, targets: [T("a", "A", "2026-10-01")] }],
			links: [] as LinkBindingRecord[],
			query: "",
			expanded: new Set<LinkBindingTargetType>(),
			visibleLimit: 1,
		};
		expect(deriveLinkSections(base).showSearch).toBe(false);
		const two = {
			...base,
			sections: [{ key: "character" as const, targets: [...base.sections[0].targets, T("b", "B", "2026-10-01")] }],
		};
		expect(deriveLinkSections(two).showSearch).toBe(true);
	});
});
