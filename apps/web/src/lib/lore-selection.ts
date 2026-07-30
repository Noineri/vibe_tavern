/**
 * CTX-L3 — Lore proposal selection (pure).
 *
 * The structured lore review surface lets the user toggle individual lorebooks
 * and entries proposed in a co-author turn. This module turns a selection into
 * the `CoauthorLoreBundle` that ships in the Apply request, enforcing the
 * parent-dependency invariant: an entry whose parent is proposed in the same
 * bundle is included ONLY if both it AND its parent lorebook are selected.
 * CE-B2 adds one deliberate exception: `parentMode:"persisted"` means the
 * parent was verified via LoreEntityLookup and lives in the DB, so no parent
 * proposal exists to select. Dropping a proposed lorebook still orphan-proofs
 * its entries; a verified persisted-parent entry is independently selectable.
 *
 * Pure: no I/O, no React, no store reads. Tested in isolation.
 */
import type { CoauthorLoreBundle } from "@vibe-tavern/api-contracts";

/**
 * Filter a proposed lore bundle by the user's per-item selection. The returned
 * bundle keeps ONLY selected lorebooks and selected entries whose proposed
 * parent is ALSO selected — OR whose `parentMode` is `"persisted"` (verified
 * external parent). Lorebook/entry order is preserved (the
 * proposed order is the model's authoring order). An empty selection yields an
 * empty bundle (Apply then omits lore entirely — see the Apply path, which
 * drops an empty-or-absent `loreBundle`).
 */
export function selectLoreBundle(
	bundle: CoauthorLoreBundle,
	selectedLorebookIds: ReadonlySet<string>,
	selectedEntryIds: ReadonlySet<string>,
): CoauthorLoreBundle {
	const lorebooks = bundle.lorebooks.filter((lb) => selectedLorebookIds.has(lb.id));
	const entries = bundle.entries.filter(
		(e) => selectedEntryIds.has(e.id) && (e.parentMode === "persisted" || selectedLorebookIds.has(e.lorebookId)),
	);
	return { lorebooks, entries };
}

/**
 * The id set that means "accept everything" — the default selection when a new
 * lore proposal appears (mirrors CA-11's wholesale-then-narrow default).
 */
export function allLorebookIds(bundle: CoauthorLoreBundle): Set<string> {
	return new Set(bundle.lorebooks.map((lb) => lb.id));
}
export function allEntryIds(bundle: CoauthorLoreBundle): Set<string> {
	return new Set(bundle.entries.map((e) => e.id));
}

/**
 * Entries whose parent lorebook is NOT in the proposed bundle AND was not
 * verified as persisted — a malformed draft that must never ship. CE-B2's
 * `parentMode:"persisted"` entries are intentional external references, not
 * orphans. The Apply path still rejects an unknown DB parent.
 */
export function orphanEntryIds(bundle: CoauthorLoreBundle): Set<string> {
	const bookIds = new Set(bundle.lorebooks.map((lb) => lb.id));
	return new Set(
		bundle.entries
			.filter((e) => e.parentMode !== "persisted" && !bookIds.has(e.lorebookId))
			.map((e) => e.id),
	);
}
