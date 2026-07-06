/**
 * Pure reorder logic for the lore-entry drag list.
 *
 * Extracted from LoreEntryList so the `onReorder` contract — the array of
 * {id, sortOrder, position?} updates committed to the store — is unit-testable
 * independently of the DOM/DnD gesture (which is validated via Playwright).
 *
 * Data model (verified at the store layer — `lorebook-store.reorderEntries`
 * sets `sortOrder` per entry with no per-section logic): `sortOrder` is a
 * GLOBAL flat index within a lorebook. The UI groups entries visually by their
 * `position` field, but the order is one flat sequence. A drag produces a new
 * global `sortOrder` for every entry (dense 0..N-1) and, only for the dragged
 * entry, an updated `position` if it crossed visual sections.
 */

import type { LoreEntryRecord } from "../../../app-client.js";

// ── Position config ──────────────────────────────────────────────────────

/**
 * The canonical lorebook entry positions, in the order the drag list groups
 * them visually. Each value is also the suffix of an i18n key `pos_<value>`
 * (and `pos_<value>_hint`) defined in locales/{en,ru}.json — do NOT hardcode
 * display labels here; always render via `t("pos_" + value)` so there is a
 * single source of truth for translations.
 */
export const POSITION_SECTIONS: readonly string[] = [
	"before_char",
	"after_char",
	"top_an",
	"bottom_an",
	"before_examples",
	"after_examples",
	"at_depth",
	"outlet",
];

export const FALLBACK_SECTION: string = POSITION_SECTIONS[1]; // after_char

export function normalizeUiPosition(position: string | undefined): string {
	switch (position) {
		// Legacy canonical prompt-layer positions from the old importer.
		// Do not expose these as lorebook UI sections.
		case "before_prompt":
			return "before_char";
		case "in_prompt":
			return "after_char";
		case "in_chat":
			return "at_depth";
		case "hidden_system":
			return "outlet";
		default:
			return position ?? FALLBACK_SECTION;
	}
}

export function getSection(position: string | undefined): string {
	const normalized = normalizeUiPosition(position);
	return POSITION_SECTIONS.includes(normalized) ? normalized : FALLBACK_SECTION;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Move the item at `from` to `to`, shifting the intervening items. Pure. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
	const next = items.slice();
	const [item] = next.splice(from, 1);
	if (!item) return items;
	next.splice(to, 0, item);
	return next;
}

export function entryOrderSignature(items: LoreEntryRecord[]): string {
	return items.map((entry) => `${entry.id}:${getSection(entry.position)}`).join("|");
}

// ── The reorder contract ─────────────────────────────────────────────────

export interface LoreReorderUpdate {
	id: string;
	sortOrder: number;
	position?: string;
}

/**
 * Compute the `onReorder` updates that result from dragging `activeId` and
 * dropping it onto `overId`, given the current flat (section-grouped, in
 * POSITION_SECTIONS order) entry list.
 *
 * Returns `null` when the drop is a no-op (over === active, or either id is
 * absent/unfound) — callers should skip the store write in that case.
 *
 * Semantics (matches the pre-refactor handleDragEnd exactly):
 *   - The dragged entry moves to the dragged-to position in the flat list.
 *   - Every entry is renumbered with a dense global `sortOrder` (0..N-1).
 *   - Only the dragged entry may receive a new `position`, and only if its
 *     section differs from the section of the entry it was dropped onto.
 */
export function buildReorderUpdates(
	flatEntries: LoreEntryRecord[],
	activeId: string | null | undefined,
	overId: string | null | undefined,
): LoreReorderUpdate[] | null {
	if (!activeId || !overId) return null;

	const activeIdx = flatEntries.findIndex((e) => e.id === activeId);
	const overIdx = flatEntries.findIndex((e) => e.id === overId);
	if (activeIdx === -1 || overIdx === -1 || activeIdx === overIdx) return null;

	const activeEntry = flatEntries[activeIdx];
	const overEntry = flatEntries[overIdx];
	const activeNewPosition = getSection(overEntry.position);
	const positionChanged = getSection(activeEntry.position) !== activeNewPosition;

	const reordered = moveItem(flatEntries, activeIdx, overIdx);
	return reordered.map((entry, i) => ({
		id: entry.id,
		sortOrder: i,
		...(entry.id === activeId && positionChanged ? { position: activeNewPosition } : {}),
	}));
}

/** Flatten grouped entries into the single flat order the list renders. */
export function flattenBySection(grouped: Map<string, LoreEntryRecord[]>): LoreEntryRecord[] {
	return POSITION_SECTIONS.flatMap((sec) => grouped.get(sec) ?? []);
}
