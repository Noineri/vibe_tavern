/**
 * CTX-L3 — Lore proposal selection (pure).
 *
 * The structured lore review surface lets the user toggle individual lorebooks
 * and entries proposed in a co-author turn. This module turns a selection into
 * the `CoauthorLoreBundle` that ships in the Apply request, enforcing the
 * parent-dependency invariant: an entry is included ONLY if both it AND its
 * parent lorebook are selected. Dropping a lorebook therefore orphan-proofs its
 * entries automatically — a turn cannot apply an entry whose book was rejected.
 *
 * Pure: no I/O, no React, no store reads. Tested in isolation.
 */
import type { CoauthorLoreBundle } from "@vibe-tavern/api-contracts";

/**
 * Filter a proposed lore bundle by the user's per-item selection. The returned
 * bundle keeps ONLY the selected lorebooks and the selected entries whose
 * parent lorebook is ALSO selected. Lorebook/entry order is preserved (the
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
		(e) => selectedEntryIds.has(e.id) && selectedLorebookIds.has(e.lorebookId),
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
 * Entries whose parent lorebook is NOT in the proposed bundle — a malformed
 * draft that must never ship. The review UI surfaces these distinctly (the Apply
 * path rejects the whole bundle if any orphan remains, but a well-formed draft
 * has none; this is a defensive guard for display only).
 */
export function orphanEntryIds(bundle: CoauthorLoreBundle): Set<string> {
	const bookIds = new Set(bundle.lorebooks.map((lb) => lb.id));
	return new Set(bundle.entries.filter((e) => !bookIds.has(e.lorebookId)).map((e) => e.id));
}
