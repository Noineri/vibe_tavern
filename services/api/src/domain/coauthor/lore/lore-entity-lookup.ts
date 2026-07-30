/**
 * CE-B1 — lore entity lookup: the IO seam that lets the co-author EDIT
 * previously-created (persisted) lore entities, not just ones drafted in the
 * current turn.
 *
 * The turn-local {@link LoreDraftState} is DB-free (proposal-only); the edit
 * tools need a persisted entity's CURRENT state to import into the draft before
 * patching it (so Apply's upsert UPDATEs the real row instead of INSERTing a
 * duplicate). This module is that read seam: it projects decoded store rows
 * into the co-author draft contract and exposes a `LoreEntityLookup` over a
 * `LorebookStore`. The runtime constructs one and injects it into
 * `buildCoauthorTools`, mirroring the `loreDelegate` injection.
 *
 * The mappers are pure and structural (they read only the draft-relevant
 * fields off a decoded row), so they are unit-testable without a DB.
 */
import type { CoauthorDraftLoreEntry, CoauthorDraftLorebook } from "@vibe-tavern/api-contracts";
import type { LoreEntityLookup } from "../../chat/coauthor-tools.js";

/**
 * Structural view of a decoded lorebook row — the subset of
 * `LorebookStore.Lorebook` the draft contract carries. The store's decoded
 * `Lorebook` is a superset, so it satisfies this view structurally (no import
 * of the non-exported store interface needed).
 */
interface StoredLorebookView {
	id: string;
	name: string;
	description: string;
	scopeType: string;
	scanDepth: number;
	tokenBudget: number;
	recursiveScanning: boolean;
	enabled: boolean;
}

/** Structural view of a decoded lore entry row — the draft-relevant subset. */
interface StoredEntryView {
	id: string;
	lorebookId: string;
	title: string;
	content: string;
	keys: string[];
	secondaryKeys: string[];
	constant: boolean;
	position: string;
	depth: number;
	logic: string;
	enabled: boolean;
}

/**
 * Structural read-store subset the lookup reads. `LorebookStore` satisfies this
 * (its decoded `Lorebook`/`LoreEntry` returns are supersets of the views), so
 * the runtime passes the real store while tests pass a plain mock — no cast.
 */
export interface LoreDraftReadStore {
	getLorebook(id: string): Promise<StoredLorebookView | null>;
	getEntry(id: string): Promise<StoredEntryView | null>;
}

/**
 * Project a decoded lorebook row into the co-author draft contract. The draft
 * node carries no `mode` (the import path in `LoreDraftState.importLorebook`
 * stamps `mode:"edit"`); `scopeType` is narrowed from the stored string to the
 * draft enum (the DB only ever stores valid scope values per the app's
 * invariants, so the cast is sound).
 */
export function lorebookToDraft(lb: StoredLorebookView): CoauthorDraftLorebook {
	return {
		id: lb.id,
		name: lb.name,
		description: lb.description,
		scopeType: lb.scopeType as CoauthorDraftLorebook["scopeType"],
		enabled: lb.enabled,
		scanDepth: lb.scanDepth,
		tokenBudget: lb.tokenBudget,
		recursiveScanning: lb.recursiveScanning,
	};
}

/** Project a decoded lore entry row into the co-author draft contract. */
export function entryToDraft(e: StoredEntryView): CoauthorDraftLoreEntry {
	return {
		id: e.id,
		lorebookId: e.lorebookId,
		title: e.title,
		content: e.content,
		keys: e.keys,
		secondaryKeys: e.secondaryKeys,
		constant: e.constant,
		position: e.position,
		depth: e.depth,
		logic: e.logic,
		enabled: e.enabled,
	};
}

/**
 * Build a {@link LoreEntityLookup} over a `LorebookStore`. Returns null for an
 * unknown id (the edit tools throw a clear "does not exist" error on null).
 */
export function createLoreEntityLookup(store: LoreDraftReadStore): LoreEntityLookup {
	return {
		lorebook: async (id) => {
			const lb = await store.getLorebook(id);
			return lb ? lorebookToDraft(lb) : null;
		},
		entry: async (id) => {
			const e = await store.getEntry(id);
			return e ? entryToDraft(e) : null;
		},
	};
}
