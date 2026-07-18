/**
 * Request-local lore draft engine (CTX-L1, Wave 4).
 *
 * Lore tools are PROPOSAL-ONLY. This engine is the entire mutation surface a
 * co-author turn has over lorebooks/entries: it allocates stable draft IDs and
 * holds the cumulative draft graph in closure state. It has NO access to
 * `LorebookStore` and cannot write to SQLite — Apply (`SessionRuntime.
 * applyCoauthorDraft`, CTX-L2) is the sole persistence boundary, and Cancel
 * (an abandoned turn) simply drops the closure.
 *
 * Design (mirrors the turn-local composable profile state in
 * `coauthor-tools.ts`, applied to a structured graph):
 *  - Every successful mutation returns the COMPLETE cumulative bundle, so
 *    last-proposal aggregation can never discard earlier entries or fields.
 *  - Mutations serialize through one non-poisoning queue: same-step calls
 *    compose deterministically, and a rejected call is discarded without
 *    poisoning the queue or corrupting the last good state.
 *  - Parent references are validated BEFORE the snapshot advances: a
 *    `create_lore_entry` whose `lorebookId` is absent from the draft is
 *    rejected and leaves all prior draft state intact.
 *  - Draft nodes are IMMUTABLY REPLACED (never mutated in place), so a
 *    previously returned snapshot stays byte-stable after a later mutation.
 */
import type {
	CoauthorDraftLorebook,
	CoauthorDraftLoreEntry,
	CoauthorLoreBundle,
} from "@vibe-tavern/api-contracts";
import { LOREBOOK_DEFAULTS } from "@vibe-tavern/domain";

/** Allocates a stable, DB-primary-key-compatible id for a draft node. */
export type LoreDraftIdGen = (prefix: "lorebook" | "lore_entry") => string;

export interface LoreDraftDeps {
	idGen: LoreDraftIdGen;
}

export type LoreDraftScopeType = "global" | "character" | "persona" | "chat";

export interface CreateLorebookInput {
	name: string;
	description?: string;
	scopeType?: LoreDraftScopeType;
	enabled?: boolean;
	/** CE-A1: activation overrides; default to `LOREBOOK_DEFAULTS`. */
	scanDepth?: number;
	tokenBudget?: number;
	recursiveScanning?: boolean;
}

export interface CreateLoreEntryInput {
	/** Parent lorebook draft id; MUST already exist in this draft. */
	lorebookId: string;
	title?: string;
	content?: string;
	keys?: string[];
	secondaryKeys?: string[];
	constant?: boolean;
	/** Injection position (mirrors LoreEntryPosition). Default `before_char`. */
	position?: string;
	depth?: number;
	enabled?: boolean;
}

export interface SetLoreActivationInput {
	entryId: string;
	/** Constant entries activate every turn regardless of key match. */
	constant?: boolean;
	enabled?: boolean;
}

/** Patch input for AI-delegated entry content (CTX-L2b). */
export interface SetLoreEntryContentInput {
	entryId: string;
	content: string;
}

/** Patch input for AI-delegated activation keys (CTX-L2b). */
export interface SetLoreEntryKeysInput {
	entryId: string;
	keys: string[];
	secondaryKeys?: string[];
}

/** Defaults for a newly drafted lorebook (scopeType mirrors lorebook routes). */
const DEFAULT_LOREBOOK_SCOPE: LoreDraftScopeType = "character";

/** Defaults for a newly drafted entry — SillyTavern's common new-entry values. */
const DEFAULT_ENTRY_POSITION = "before_char";
const DEFAULT_ENTRY_DEPTH = 4;

export class LoreDraftState {
	private readonly lorebooks = new Map<string, CoauthorDraftLorebook>();
	private readonly entries = new Map<string, CoauthorDraftLoreEntry>();
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: LoreDraftDeps) {}

	/**
	 * Serialize a lore mutation onto the turn queue (non-poisoning). Mirrors the
	 * profile queue in `coauthor-tools.ts`: a prior rejection is swallowed so
	 * this call runs regardless, and this call's own outcome never blocks a
	 * later queued call. The state mutation is synchronous and pure; the queue
	 * exists so same-step tool calls (issued without awaiting) compose in call
	 * order rather than racing on the maps.
	 */
	private runQueued<T>(fn: () => T): Promise<T> {
		const result = this.chain.catch(() => undefined).then(fn);
		this.chain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Allocate a draft lorebook and return the full cumulative bundle. */
	createLorebook(input: CreateLorebookInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			if (!input.name.trim()) {
				throw new Error("create_lorebook: name must not be empty");
			}
			const lorebook: CoauthorDraftLorebook = {
				id: this.deps.idGen("lorebook"),
				name: input.name,
				description: input.description ?? "",
				scopeType: input.scopeType ?? DEFAULT_LOREBOOK_SCOPE,
				enabled: input.enabled ?? true,
				scanDepth: input.scanDepth ?? LOREBOOK_DEFAULTS.scanDepth,
				tokenBudget: input.tokenBudget ?? LOREBOOK_DEFAULTS.tokenBudget,
				recursiveScanning: input.recursiveScanning ?? LOREBOOK_DEFAULTS.recursiveScanning,
			};
			this.lorebooks.set(lorebook.id, lorebook);
			return this.snapshot();
		});
	}

	/**
	 * Allocate a draft entry under an existing draft lorebook. Rejects if the
	 * parent `lorebookId` is absent from the draft (missing-parent); the
	 * rejection leaves all prior draft state intact.
	 */
	createLoreEntry(input: CreateLoreEntryInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			if (!this.lorebooks.has(input.lorebookId)) {
				throw new Error(
					`create_lore_entry: parent lorebook '${input.lorebookId}' does not exist in the draft`,
				);
			}
			const entry: CoauthorDraftLoreEntry = {
				id: this.deps.idGen("lore_entry"),
				lorebookId: input.lorebookId,
				title: input.title ?? "",
				content: input.content ?? "",
				keys: input.keys ?? [],
				secondaryKeys: input.secondaryKeys ?? [],
				constant: input.constant ?? false,
				position: input.position ?? DEFAULT_ENTRY_POSITION,
				depth: input.depth ?? DEFAULT_ENTRY_DEPTH,
				enabled: input.enabled ?? true,
			};
			this.entries.set(entry.id, entry);
			return this.snapshot();
		});
	}

	/**
	 * Update activation fields on an existing draft entry (immutable replace, so
	 * earlier snapshots stay stable). Rejects if the entry is absent.
	 */
	setLoreActivation(input: SetLoreActivationInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			const existing = this.entries.get(input.entryId);
			if (!existing) {
				throw new Error(
					`set_lore_activation: entry '${input.entryId}' does not exist in the draft`,
				);
			}
			const next: CoauthorDraftLoreEntry = {
				...existing,
				...(input.constant !== undefined ? { constant: input.constant } : {}),
				...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
			};
			this.entries.set(existing.id, next);
			return this.snapshot();
		});
	}

	/**
	 * Replace the content body of an existing draft entry (immutable replace).
	 * Used by the `ai_write_lore_entry` delegation tool after the AI-assistant
	 * returns generated prose. Rejects if the entry is absent.
	 */
	setLoreEntryContent(input: SetLoreEntryContentInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			const existing = this.entries.get(input.entryId);
			if (!existing) {
				throw new Error(
					`setLoreEntryContent: entry '${input.entryId}' does not exist in the draft`,
				);
			}
			this.entries.set(existing.id, { ...existing, content: input.content });
			return this.snapshot();
		});
	}

	/**
	 * Replace the activation keys of an existing draft entry (immutable replace).
	 * Used by the `ai_generate_lore_keys` delegation tool after the AI-assistant
	 * returns suggested keywords. Rejects if the entry is absent.
	 */
	setLoreEntryKeys(input: SetLoreEntryKeysInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			const existing = this.entries.get(input.entryId);
			if (!existing) {
				throw new Error(
					`setLoreEntryKeys: entry '${input.entryId}' does not exist in the draft`,
				);
			}
			this.entries.set(existing.id, {
				...existing,
				keys: input.keys,
				...(input.secondaryKeys !== undefined ? { secondaryKeys: input.secondaryKeys } : {}),
			});
			return this.snapshot();
		});
	}

	/**
	 * The complete cumulative lore draft (every lorebook + entry, in insertion
	 * order). Returned by every successful mutation AND available for reads.
	 * Nodes are never mutated in place, so any snapshot stays stable.
	 */
	snapshot(): CoauthorLoreBundle {
		return {
			lorebooks: [...this.lorebooks.values()],
			entries: [...this.entries.values()],
		};
	}

	/** True when nothing has been drafted — Cancel/abandon leaves no rows. */
	isEmpty(): boolean {
		return this.lorebooks.size === 0 && this.entries.size === 0;
	}
}

/**
 * Default id generator for draft nodes when no store idGen is injected. Produces
 * DB-primary-key-compatible strings in the same `${prefix}_${seed}` shape as the
 * store's `IncrementingStoreIdGenerator`, so a draft id is a valid unique PK for
 * the CTX-L2 upsert-with-id Apply path (any unique string would do; matching the
 * store convention aids debugging).
 */
export function defaultLoreDraftIdGen(): LoreDraftIdGen {
	return (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
