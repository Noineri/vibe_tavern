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
import {
	LOREBOOK_REVIEW_SETTING_FIELDS,
	LORE_ENTRY_REVIEW_SETTING_FIELDS,
	type CoauthorDraftLorebook,
	type CoauthorDraftLoreEntry,
	type CoauthorLoreBundle,
	type LoreReviewSettingChange,
} from "@vibe-tavern/api-contracts";
import type { updateLoreEntrySchema, updateLorebookMetaSchema } from "@vibe-tavern/api-contracts";
import type { z } from "zod";
import { LOREBOOK_DEFAULTS, LORE_LOGIC } from "@vibe-tavern/domain";
import { LORE_TOOL_EXCLUDED_ENTRY_FIELDS } from "./lore-tool-schemas.js";

/** Allocates a stable, DB-primary-key-compatible id for a draft node. */
export type LoreDraftIdGen = (prefix: "lorebook" | "lore_entry") => string;

export interface LoreDraftDeps {
	idGen: LoreDraftIdGen;
}

export type LoreDraftScopeType = "global" | "entity" | "chat";

/**
 * Every book-level settings field the lorebook API contract defines
 * (`updateLorebookMetaSchema`), all optional — the SAME contract the
 * lorebook API validates with (COAUTHOR_LORE_FULL_SETTINGS step 3: no
 * parallel validator set). `scopeType` is re-narrowed per input below.
 */
export type LorebookSettingsPatch = Omit<z.output<typeof updateLorebookMetaSchema>, "scopeType">;

/**
 * Every entry-level settings field the lorebook API contract defines
 * (`updateLoreEntrySchema`) minus the documented content-path / dead-alias
 * exclusions (see `LORE_TOOL_EXCLUDED_ENTRY_FIELDS`). Same contract as the
 * lorebook API — no parallel validator set.
 */
export type LoreEntrySettingsPatch = Omit<
	z.output<typeof updateLoreEntrySchema>,
	keyof typeof LORE_TOOL_EXCLUDED_ENTRY_FIELDS
>;

export interface CreateLorebookInput extends Omit<LorebookSettingsPatch, "name"> {
	name: string;
	scopeType?: LoreDraftScopeType;
}

export interface CreateLoreEntryInput extends LoreEntrySettingsPatch {
	/** Parent lorebook draft id; MUST already exist in this draft. */
	lorebookId: string;
	/** CE-B2: parent is a verified persisted lorebook absent from the bundle. */
	parentMode?: "persisted";
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

/**
 * CE-B1: patch for editing a draft lorebook's settings. Every field the
 * contract defines, all optional — only the supplied ones are applied
 * (immutable replace). `id` targets either a turn-drafted lorebook or an
 * imported (persisted) one.
 */
export interface EditLorebookInput extends LorebookSettingsPatch {
	id: string;
	scopeType?: LoreDraftScopeType;
}

/**
 * CE-B1: patch for editing a draft entry's settings. Every contract field
 * (minus content-path), all optional; only the supplied ones are applied.
 * Keys/content are NOT editable here — they stay delegate-only
 * (ai_generate_lore_keys / ai_write_lore_entry). Immutable replace.
 */
export interface EditLoreEntryInput extends LoreEntrySettingsPatch {
	id: string;
}

/** Defaults for a newly drafted lorebook (scopeType mirrors lorebook routes). */
const DEFAULT_LOREBOOK_SCOPE: LoreDraftScopeType = "entity";

/** Defaults for a newly drafted entry — SillyTavern's common new-entry values. */
const DEFAULT_ENTRY_POSITION = "before_char";
const DEFAULT_ENTRY_DEPTH = 4;
/** CE-A2: default activation logic — ST's AND_ANY (at least one key matches). */
const DEFAULT_ENTRY_LOGIC = LORE_LOGIC.andAny;

/**
 * The entry fields the draft node ALWAYS carries (base skeleton shape);
 * settings fields beyond these are copied only when the co-author set them
 * (absent = Apply fills the store's create defaults).
 */
const ENTRY_BASE_KEYS = new Set([
	"lorebookId", "parentMode", "title", "constant", "position", "depth", "logic", "enabled",
]);

/** The lorebook fields the draft node ALWAYS carries (see ENTRY_BASE_KEYS). */
const LOREBOOK_BASE_KEYS = new Set([
	"name", "description", "enabled", "scanDepth", "tokenBudget", "recursiveScanning",
]);

/** Defaults used only to identify non-default settings on newly proposed nodes. */
const NEW_LOREBOOK_SETTING_DEFAULTS: Record<string, unknown> = {
	enabled: true,
	scanDepth: LOREBOOK_DEFAULTS.scanDepth,
	tokenBudget: LOREBOOK_DEFAULTS.tokenBudget,
	tokenBudgetPercent: null,
	tokenBudgetCap: LOREBOOK_DEFAULTS.tokenBudgetCap,
	recursiveScanning: LOREBOOK_DEFAULTS.recursiveScanning,
	useGroupScoring: false,
	caseSensitive: false,
	matchWholeWords: false,
	maxRecursionSteps: 0,
	includeNames: true,
	minActivations: 0,
	minActivationsDepthMax: 0,
	overflowAlert: false,
	characterStrategy: 1,
};

const NEW_ENTRY_SETTING_DEFAULTS: Record<string, unknown> = {
	constant: false,
	position: DEFAULT_ENTRY_POSITION,
	depth: DEFAULT_ENTRY_DEPTH,
	logic: DEFAULT_ENTRY_LOGIC,
	enabled: true,
	priority: 10,
	probability: 100,
	ignoreBudget: false,
	role: "system",
	groupName: "",
	groupWeight: 100,
	prioritizeInclusion: false,
	useGroupScoring: null,
	excludeRecursion: false,
	preventRecursion: false,
	delayUntilRecursion: false,
	recursionLevel: 0,
	scanDepthOverride: null,
	caseSensitive: null,
	matchWholeWords: null,
	caseFormsKeys: [],
	characterFilter: [],
	characterFilterExclude: false,
	matchSources: ["chat_messages"],
	stickyWindow: 0,
	cooldownWindow: 0,
	minChatMessages: 0,
};

function valuesMatch(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The sole change derivation for review metadata. Imported nodes compare against
 * their persisted baseline; new nodes compare against creation defaults.
 */
function valueOrDefault(source: Record<string, unknown> | undefined, field: string, defaults: Record<string, unknown>): unknown {
	return source && Object.hasOwn(source, field) ? source[field] : defaults[field];
}

function deriveSettingChanges(
	node: Record<string, unknown>,
	fields: readonly string[],
	baseline: Record<string, unknown> | undefined,
	defaults: Record<string, unknown>,
): Record<string, LoreReviewSettingChange> | undefined {
	const changes: Record<string, LoreReviewSettingChange> = {};
	for (const field of fields) {
		const oldValue = valueOrDefault(baseline, field, defaults);
		const newValue = valueOrDefault(node, field, defaults);
		if (!valuesMatch(oldValue, newValue)) changes[field] = { oldValue, newValue };
	}
	return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * Copy every DEFINED settings field except the base keys (undefined = not
 * set by the co-author — must not land on the node; null IS a value and is
 * kept, e.g. the tri-state useGroupScoring / scanDepthOverride overrides).
 */
function definedSettings<T extends object>(source: T, skip?: Set<string>): Partial<T> {
	const out: Partial<T> = {};
	for (const [key, value] of Object.entries(source) as Array<[keyof T & string, T[keyof T & string]]>) {
		if (value !== undefined && !skip?.has(key)) out[key] = value;
	}
	return out;
}

export class LoreDraftState {
	private readonly lorebooks = new Map<string, CoauthorDraftLorebook>();
	private readonly entries = new Map<string, CoauthorDraftLoreEntry>();
	/** Persisted values captured at import; the sole baseline for review changes. */
	private readonly lorebookBaselines = new Map<string, CoauthorDraftLorebook>();
	private readonly entryBaselines = new Map<string, CoauthorDraftLoreEntry>();
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
			const { name, scopeType, ...settings } = input;
			const lorebook: CoauthorDraftLorebook = {
				id: this.deps.idGen("lorebook"),
				name,
				description: settings.description ?? "",
				scopeType: scopeType ?? DEFAULT_LOREBOOK_SCOPE,
				enabled: settings.enabled ?? true,
				scanDepth: settings.scanDepth ?? LOREBOOK_DEFAULTS.scanDepth,
				tokenBudget: settings.tokenBudget ?? LOREBOOK_DEFAULTS.tokenBudget,
				recursiveScanning: settings.recursiveScanning ?? LOREBOOK_DEFAULTS.recursiveScanning,
				// Every other settings field rides along only when set (absent =
				// Apply fills the store's create defaults — step 3).
				...definedSettings(settings, LOREBOOK_BASE_KEYS),
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
			const [id, entry] = this.appendEntry(input);
			this.entries.set(id, entry);
			return this.snapshot();
		});
	}

	/**
	 * CE-B1: allocate a new entry skeleton under a lorebook that may be EITHER a
	 * turn-drafted book OR an existing persisted book (the tool layer validates
	 * persisted parents via the entity lookup before calling). Unlike
	 * {@link createLoreEntry} the parent need NOT be present in this draft, so a
	 * co-author can add an entry to a previously-created book across turns.
	 */
	addLoreEntry(input: CreateLoreEntryInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			const [id, entry] = this.appendEntry(input);
			this.entries.set(id, entry);
			return this.snapshot();
		});
	}

	/** Build a fresh draft entry (CE-A2 skeleton) from a create/add input. */
	private appendEntry(input: CreateLoreEntryInput): [string, CoauthorDraftLoreEntry] {
		const { lorebookId, parentMode, ...settings } = input;
		const entry: CoauthorDraftLoreEntry = {
				id: this.deps.idGen("lore_entry"),
				lorebookId,
				title: settings.title ?? "",
				// CE-A2: skeleton — content + keys are delegate-only, start empty.
				content: "",
				keys: [],
				secondaryKeys: [],
				constant: settings.constant ?? false,
				position: settings.position ?? DEFAULT_ENTRY_POSITION,
				depth: settings.depth ?? DEFAULT_ENTRY_DEPTH,
				logic: settings.logic ?? DEFAULT_ENTRY_LOGIC,
				enabled: settings.enabled ?? true,
				...(parentMode !== undefined ? { parentMode } : {}),
				// Every other settings field rides along only when set (absent =
				// Apply fills the store's create defaults — step 3).
				...definedSettings(settings, ENTRY_BASE_KEYS),
		};
		return [entry.id, entry];
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

	// ── CE-B1: edit + import capability ──────────────────────────────────────

	/** True when a node with this id is already in the draft. */
	hasLorebook(id: string): boolean {
		return this.lorebooks.has(id);
	}
	hasEntry(id: string): boolean {
		return this.entries.has(id);
	}

	/**
	 * CE-B1: upsert a lorebook node as an EDIT target (force mode "edit"). Used
	 * by the tool layer to bring a persisted lorebook into the draft before
	 * editing it — the node carries the entity's full current state (loaded via
	 * the injected entity lookup). Re-importing the same id replaces the node
	 * (idempotent). The tool layer validates existence via the lookup first, so
	 * a node reaching here is known to exist in the DB.
	 */
	importLorebook(node: CoauthorDraftLorebook): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			const { settingChanges: _settingChanges, ...baseline } = node;
			this.lorebookBaselines.set(node.id, baseline);
			this.lorebooks.set(node.id, { ...baseline, mode: "edit" });
			return this.snapshot();
		});
	}

	/** CE-B1: upsert an entry node as an EDIT target (force mode "edit"). */
	importEntry(node: CoauthorDraftLoreEntry): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			// A persisted entry's parent is itself persisted and intentionally need
			// not appear as a no-op lorebook node in the proposal bundle.
			const { settingChanges: _settingChanges, ...baseline } = node;
			this.entryBaselines.set(node.id, baseline);
			this.entries.set(node.id, { ...baseline, mode: "edit", parentMode: "persisted" });
			return this.snapshot();
		});
	}

	/**
	 * CE-B1: apply a partial patch to a draft lorebook (immutable replace; only
	 * supplied fields are applied). Preserves the node's `mode` (a create stays
	 * a create, an imported edit stays an edit). Rejects if the lorebook is
	 * absent from the draft.
	 */
	editLorebook(input: EditLorebookInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			const existing = this.lorebooks.get(input.id);
			if (!existing) {
				throw new Error(`edit_lorebook: lorebook '${input.id}' does not exist in the draft`);
			}
			const { id: _id, ...settings } = input;
			this.lorebooks.set(existing.id, { ...existing, ...definedSettings(settings) });
			return this.snapshot();
		});
	}

	/**
	 * CE-B1: apply a partial patch to a draft entry's settings — every
	 * contract settings field (title, activation, timing, groups, recursion,
	 * matching, filters). Keys/content are NOT editable here — they stay
	 * delegate-only (`ai_generate_lore_keys` / `ai_write_lore_entry`).
	 * Immutable replace; preserves `mode`. Rejects if the entry is absent.
	 */
	editLoreEntry(input: EditLoreEntryInput): Promise<CoauthorLoreBundle> {
		return this.runQueued(() => {
			const existing = this.entries.get(input.id);
			if (!existing) {
				throw new Error(`edit_lore_entry: entry '${input.id}' does not exist in the draft`);
			}
			const { id: _id, ...settings } = input;
			this.entries.set(existing.id, { ...existing, ...definedSettings(settings) });
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
			lorebooks: [...this.lorebooks.values()].map((node) => {
				const { settingChanges: _settingChanges, ...lorebook } = node;
				const settingChanges = deriveSettingChanges(
					lorebook,
					LOREBOOK_REVIEW_SETTING_FIELDS,
					this.lorebookBaselines.get(node.id),
					NEW_LOREBOOK_SETTING_DEFAULTS,
				);
				return settingChanges ? { ...lorebook, settingChanges } : lorebook;
			}),
			entries: [...this.entries.values()].map((node) => {
				const { settingChanges: _settingChanges, ...entry } = node;
				const settingChanges = deriveSettingChanges(
					entry,
					LORE_ENTRY_REVIEW_SETTING_FIELDS,
					this.entryBaselines.get(node.id),
					NEW_ENTRY_SETTING_DEFAULTS,
				);
				return settingChanges ? { ...entry, settingChanges } : entry;
			}),
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
