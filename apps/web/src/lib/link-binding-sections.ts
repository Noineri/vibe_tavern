/**
 * link-binding-sections — the ONE pure derivation of what the variant-A
 * link popover shows (LINK_BINDING_PERF_PLAN Wave 2 item 2).
 *
 * Input: per-section targets + the entity's current links + the live query
 * + per-section expanded flags + a visible limit. Output: ordered visible
 * items, per-section bound-id sets, hidden counts, collapse affordances.
 * The desktop popover (LB-2C) and the mobile sheet only RENDER this —
 * neither re-derives order/collapse/search. The lore-entry character filter
 * picker (LB-3B) reuses the ordering helpers instead of re-implementing them.
 *
 * Pure module: no React, no stores, no i18n, no imports from components/ —
 * callers pass the shared MAX_VISIBLE_ITEMS constant as `visibleLimit`.
 */
import type { LinkBindingRecord, LinkBindingTargetType, LinkTarget } from "./link-targets.js";

/** One caller-declared section: its link kind and every candidate target. */
export interface LinkSectionInput {
	/** Section identity — also the `targetType` of its `LinkBindingRecord`s. */
	key: LinkBindingTargetType;
	targets: readonly LinkTarget[];
}

/** A section after derivation — everything the renderer needs to draw it. */
export interface LinkSectionView {
	key: LinkBindingTargetType;
	/** Visible items, already ordered (bound first, then updatedAt desc). */
	items: LinkTarget[];
	/** Ids bound in THIS section — the renderer marks matching items active. */
	boundIds: ReadonlySet<string>;
	/** Items matching the query (== targets.length when no query). */
	matchCount: number;
	/** Unbound items behind a «show N more» chip (0 when expanded/searching). */
	hiddenCount: number;
	/** Effective expanded state (true while searching). */
	expanded: boolean;
	/** Renderer shows «show less» when true (see deriveLinkSections). */
	collapsible: boolean;
}

/** Whole-picker derivation result. */
export interface LinkSectionsResult {
	/** Input section order kept; empty sections (no targets, or no matches
	 *  under a query) omitted. */
	sections: LinkSectionView[];
	/** Sum of targets over ALL input sections (search-field threshold). */
	totalTargets: number;
	/** Whether the search field should be shown: totalTargets > visibleLimit. */
	showSearch: boolean;
	/** Query non-empty and every section had zero matches. */
	noResults: boolean;
}

/** Sort key for `updatedAt`: ms since epoch, unparseable/null → -Infinity
 *  (sorts LAST in the descending order — recent first). */
function updatedAtKey(t: LinkTarget): number {
	if (typeof t.updatedAt !== "string") return Number.NEGATIVE_INFINITY;
	const ms = Date.parse(t.updatedAt);
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Order targets for display: bound first, then unbound. Within each group
 * `updatedAt` DESCENDING (recently edited first; null/unparseable last),
 * then name (`localeCompare`, base sensitivity — case/diacritic-blind),
 * then id (code-unit compare — makes the order total and deterministic).
 * Never mutates the input array.
 */
export function orderLinkTargets(
	targets: readonly LinkTarget[],
	boundIds: ReadonlySet<string>,
): LinkTarget[] {
	return [...targets].sort((a, b) => {
		const aBound = boundIds.has(a.id) ? 0 : 1;
		const bBound = boundIds.has(b.id) ? 0 : 1;
		if (aBound !== bBound) return aBound - bBound;
		const ta = updatedAtKey(a);
		const tb = updatedAtKey(b);
		if (ta !== tb) return tb - ta;
		const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		if (byName !== 0) return byName;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

/**
 * Case-insensitive substring match on `name`, working for Cyrillic: the
 * query is trimmed, then BOTH sides pass through `toLocaleLowerCase()`.
 * Empty (or whitespace-only) query matches everything.
 */
export function matchesLinkQuery(name: string, query: string): boolean {
	const q = query.trim().toLocaleLowerCase();
	if (q === "") return true;
	return name.toLocaleLowerCase().includes(q);
}

/**
 * Derive every section's view state for the current render.
 *
 * No query (after trim):
 * - collapsed section → all bound items + the first `visibleLimit` unbound
 *   items, `hiddenCount` = the remaining unbound (behind «show N more»);
 *   bound items are NEVER hidden, even when they exceed the limit;
 * - expanded section (key in `expanded`) → all items, `hiddenCount` 0;
 *   `collapsible` is true exactly when expanded && no query && unbound
 *   count > visibleLimit (renderer shows «show less»).
 *
 * Non-empty query: every section shows ALL its matching items (bound and
 * unbound, same ordering), `hiddenCount` 0, `expanded` true, `collapsible`
 * false; the `expanded` set is ignored; sections with 0 matches are omitted;
 * `noResults` when all are omitted.
 *
 * Sections with zero targets are always omitted.
 */
export function deriveLinkSections(args: {
	sections: readonly LinkSectionInput[];
	links: readonly LinkBindingRecord[];
	query: string;
	expanded: ReadonlySet<LinkBindingTargetType>;
	visibleLimit: number;
}): LinkSectionsResult {
	const { sections, links, query, expanded, visibleLimit } = args;
	const hasQuery = query.trim() !== "";
	const totalTargets = sections.reduce((sum, s) => sum + s.targets.length, 0);

	const views: LinkSectionView[] = [];
	for (const section of sections) {
		if (section.targets.length === 0) continue;
		const boundIds = new Set(links.filter((l) => l.targetType === section.key).map((l) => l.targetId));
		const ordered = orderLinkTargets(section.targets, boundIds);

		if (hasQuery) {
			const matched = ordered.filter((t) => matchesLinkQuery(t.name, query));
			if (matched.length === 0) continue;
			views.push({
				key: section.key,
				items: matched,
				boundIds,
				matchCount: matched.length,
				hiddenCount: 0,
				expanded: true,
				collapsible: false,
			});
			continue;
		}

		const boundItems = ordered.filter((t) => boundIds.has(t.id));
		const unboundItems = ordered.filter((t) => !boundIds.has(t.id));
		const isExpanded = expanded.has(section.key);
		if (isExpanded) {
			views.push({
				key: section.key,
				items: ordered,
				boundIds,
				matchCount: section.targets.length,
				hiddenCount: 0,
				expanded: true,
				collapsible: unboundItems.length > visibleLimit,
			});
		} else {
			views.push({
				key: section.key,
				items: [...boundItems, ...unboundItems.slice(0, visibleLimit)],
				boundIds,
				matchCount: section.targets.length,
				hiddenCount: Math.max(0, unboundItems.length - visibleLimit),
				expanded: false,
				collapsible: false,
			});
		}
	}

	return {
		sections: views,
		totalTargets,
		showSearch: totalTargets > visibleLimit,
		noResults: hasQuery && views.length === 0,
	};
}
