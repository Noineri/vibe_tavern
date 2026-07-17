/**
 * @module api/contract/session-types
 *
 * Response DTO types that flow through the {@link RuntimeApi} contract — the
 * shapes returned by chat / character / import / bootstrap endpoints.
 *
 * Extracted from `session/session-runtime.ts` (the composition root) so that
 * domain layers (`chat/`, `prompt/`) and the contract itself no longer
 * type-import the `SessionRuntime` coordinator class just to name a response
 * shape. The types live with the rest of the contract; the coordinator stays a
 * runtime wiring concern in `session/`.
 *
 * NOTE: `MessageDto`, `CharacterRecord`, `PersonaRecord` still live under
 * `session/` for now — they are DTO/logic modules, not the composition root, so
 * depending on them here does not re-introduce leak #2. Step #3 of the
 * migration moves character/persona into their own domains and updates these
 * import paths.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.2 #2.
 */

import type {
	AssemblePromptResponse,
	CharacterId,
	ChatId,
	ObjectiveState,
	PromptPresetDto,
	PromptTraceRecordDto,
	SceneBackfillErrorEntry,
	SceneBackfillSummary,
	SceneTrackerRecord,
} from "@vibe-tavern/domain";
import type { Chat, ChatBranch, UiSettings } from "@vibe-tavern/db";
import type { MessageDto } from "../../runtime/session/session-runtime-dto.js";
import type { CharacterRecord } from "../../domain/character/character-runtime.js";
import type { PersonaRecord } from "../../domain/persona/persona-runtime.js";
import type { ChatListItem, CoauthorCorrection } from "@vibe-tavern/api-contracts";

// ChatListItem lives in @vibe-tavern/api-contracts (shared with the frontend)
// so drift becomes a compile error. Re-exported here so existing backend
// importers keep resolving without changing their import paths.
export type { ChatListItem };

export interface SessionSnapshot {
	/** Sidebar: ordered list of chats with metadata. Absent when endpoint returns partial data. */
	chats: ChatListItem[];
	/** All known characters (sidebar, build mode). Absent when endpoint returns partial data. */
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null; avatarExt: string | null; updatedAt: string }>;
	/** Active chat metadata (title, settings, greetingIndex, etc). */
	activeChat: Chat;
	/** Currently active branch. */
	activeBranch: ChatBranch;
	/** All branches for the active chat. */
	branches: ChatBranch[];
	/** Messages for the active branch, with variant data. */
	messages: MessageDto[];
	/** Ranged summaries for the active branch. */
	summaries: Array<{
		id: string;
		kind: string;
		summary: string;
	}>;
	/** Latest prompt trace for the active branch (null if no traces). */
	promptTrace: PromptTraceRecordDto | null;
	/** Live context preview — always reflects current chat/character/persona/preset state. Never nulled by trace presence (traces are historical; this is the live view). */
	contextPreview: AssemblePromptResponse | null;
	/** Active character record. */
	character: CharacterRecord;
	/** Active persona record (null if no persona set). */
	persona: PersonaRecord | null;
}

export interface BootstrapState {
	initialChatId: ChatId | null;
	snapshot: SessionSnapshot | null;
	isFirstRun: boolean;
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null; avatarExt: string | null; updatedAt: string }>;
	promptPresets: PromptPresetDto[];
	uiSettings: UiSettings;
	isArmServer: boolean;
}

export interface ImportResult {
	activeChatId: ChatId;
	// Optional under the lean mass-import path (skip O(N²) getSnapshot).
	// Full single-card import always returns a snapshot.
	snapshot?: SessionSnapshot;
	// Set on the lean path so the frontend can resolve the avatar upload
	// without the snapshot. Absent on the full path (use snapshot.character.id).
	characterId?: CharacterId;
	imported: {
		kind: "character" | "lorebook" | "chat";
		name: string;
		fileName: string;
		warningCount: number;
		warnings: string[];
		attachedToCharacterName?: string;
	};
}

// Result of a mass-import batch (POST /api/import/batch). One entry per input
// item; a failed item carries `error` instead of ids. See importJsonBatch in
// session-runtime-import-export.ts.
export interface BatchImportResult {
	results: Array<{
		fileName: string;
		characterId?: CharacterId;
		activeChatId?: ChatId;
		error?: string;
	}>;
}

// ─── Per-endpoint response builders (Wave B1) ────────────────────────
//
// Narrowed response shapes — one per mutation family. Each is a strict
// subset of {@link SessionSnapshot}: fields a mutation does not touch are
// simply OMITTED (not sent null), so the frontend's `ingestSnapshot`
// (absent → preserve) updates only the regions that actually changed.
//
// Field membership follows the field-ownership table in
// `CHAT_FRONTEND_REFACTOR_PLAN.md` (Wave B1). Required fields are always
// returned by every mutation in the family; optional (`?`) fields are
// returned only by the mutations in the family that touch them.
//
// `contextPreview` inclusion is driven solely by the "did conversation text
// change" rule — it is never coupled to prompt-trace presence. Both the
// builders and `getSnapshot` compute the preview via `assembleContextPreview`
// directly (the Phase-3.1 "trace shadows preview" coupling was removed).
//
// Every field type is indexed off `SessionSnapshot[...]` so these contracts
// track the canonical shape without drift.

/** Message-path mutations: send, regenerate, edit, delete, create-variant. */
export interface MessageResponse {
	messages: SessionSnapshot["messages"];
	contextPreview: SessionSnapshot["contextPreview"];
	/** send / delete-message move summary markers; edit / create-variant do not. */
	summaries?: SessionSnapshot["summaries"];
	/**
	 * Latest single prompt trace for the active branch. The full history is
	 * NOT shipped (lazy-loaded separately — see TRACE_LAZY_LOADING_PLAN).
	 * Including just the latest keeps the post-generation trace badge fresh
	 * without paying the full-history payload cost. Absent on responses only
	 * when no trace exists for the branch (then `null`).
	 */
	promptTrace: SessionSnapshot["promptTrace"];
}

/** Variant-path mutations: select-variant, delete-variant, set-greeting. */
export interface VariantResponse {
	messages: SessionSnapshot["messages"];
	contextPreview: SessionSnapshot["contextPreview"];
	/** set-greeting writes the chat row (greetingIndex); variant ops do not. */
	activeChat?: SessionSnapshot["activeChat"];
}

/** Branch-mutating ops: fork, activate, delete-branch (conversation text moves). */
export interface BranchResponse {
	messages: SessionSnapshot["messages"];
	activeBranch: SessionSnapshot["activeBranch"];
	branches: SessionSnapshot["branches"];
	summaries: SessionSnapshot["summaries"];
	contextPreview: SessionSnapshot["contextPreview"];
	/**
	 * Sidebar chat list. fork / activate change WHICH branch is active for the
	 * chat, and {@link ChatListItem.messageCount} is the active branch's message
	 * count — so the sidebar number must refresh on every branch switch.
	 * Without this, the chat item keeps showing the previous branch's count.
	 */
	chats: SessionSnapshot["chats"];
}

/** Branch-metadata-only op: rename-branch (no text change → no contextPreview). */
export interface BranchMetaResponse {
	branches: SessionSnapshot["branches"];
}

/** Chat-list-only op: rename-chat (sidebar label changes, nothing else). */
export interface ChatListResponse {
	chats: SessionSnapshot["chats"];
}

/** Chat switch / clone — full reload of the active chat's view state. */
export interface ChatSwitchResponse {
	messages: SessionSnapshot["messages"];
	activeChat: SessionSnapshot["activeChat"];
	activeBranch: SessionSnapshot["activeBranch"];
	branches: SessionSnapshot["branches"];
	summaries: SessionSnapshot["summaries"];
	contextPreview: SessionSnapshot["contextPreview"];
	character: SessionSnapshot["character"];
	/** switch sends the chat's persona; clone omits it (inherits from source). */
	persona?: SessionSnapshot["persona"];
	/** clone adds a row to the sidebar; switch does not move the list. */
	chats?: SessionSnapshot["chats"];
}

/** Chat create / clear — new chat appears in the sidebar, fresh view state. */
export interface ChatCreateResponse {
	chats: SessionSnapshot["chats"];
	messages: SessionSnapshot["messages"];
	activeChat: SessionSnapshot["activeChat"];
	activeBranch: SessionSnapshot["activeBranch"];
	branches: SessionSnapshot["branches"];
	summaries: SessionSnapshot["summaries"];
	contextPreview: SessionSnapshot["contextPreview"];
	character: SessionSnapshot["character"];
}

/** Config-patch ops: set-persona, set-preset, character-patch, memory-settings. */
export interface ConfigPatchResponse {
	contextPreview: SessionSnapshot["contextPreview"];
	/** set-persona. */
	persona?: SessionSnapshot["persona"];
	/** character-patch. */
	character?: SessionSnapshot["character"];
	/** memory-settings writes the chat row. */
	activeChat?: SessionSnapshot["activeChat"];
}

/** Immutable assistant response whose background insight work is being joined. */
export interface InsightsCompletionTarget {
	chatId: string;
	branchId: string;
	messageId: string;
	/** Optional immutable variant id (SCN-9). Present when the caller is
	 *  Scene-aware: the join targets the exact variant's Scene job, ownership is
	 *  revalidated against the variant after the wait, and the scoped message
	 *  patch is returned. Absent for Objective-only refresh. */
	variantId?: string;
}

/** Target-scoped insight delivery; never expands into a whole session snapshot. */
export interface InsightsCompletionPatchResponse {
	target: InsightsCompletionTarget;
	patch: {
		objectiveState?: ObjectiveState;
		/** The target message DTO carrying the variant whose Scene record settled
		 *  (the per-variant `sceneTracker` reflects the committed/cleared record).
		 *  Returned only when the refresh target carries a `variantId` (SCN-9). */
		message?: MessageDto;
	};
}

/** Manual Scene mutation response (SCN-9): the target message DTO reflecting
 *  the committed/cleared record. generate/update/edit/delete all return this —
 *  the frontend applies the scoped message patch, never a whole snapshot. */
export interface SceneTargetResponse {
	target: InsightsCompletionTarget;
	message: MessageDto;
}

/** Server-authoritative Scene status (SCN-9): drives reload/multi-tab hydration
 *  and edit preflight. `generating` reflects the target coordinator; `record` is
 *  the variant's current canonical record (null when absent). */
export interface SceneStatusResponse {
	target: InsightsCompletionTarget;
	generating: boolean;
	record: SceneTrackerRecord | null;
}

/** Non-persisting Scene preview (SCN-11): the scene state a DRAFT config would
 *  produce for the target variant, generated but NOT committed (no record is
 *  written). Drives the config editor's cancellable trial-run preview so a
 *  schema/prompt/model change can be validated before saving. */
export interface ScenePreviewResponse {
	target: InsightsCompletionTarget;
	/** The generated scene state — transient (never persisted to the variant record). */
	sceneState: Record<string, unknown>;
}

/** Server-authoritative Scene history-backfill run status (SCN-14). Drives the
 *  client's progress polling, Cancel, retry/resume, and partial-success summary.
 *  `processed` is the durable cursor (next manifest index to process); `current`
 *  is the item being generated RIGHT NOW (in-memory only — null on reload before
 *  the run reattaches). The run row is JOB state only; Scene data still lives on
 *  message_variants.scene_tracker_json. The error/summary shapes are shared from
 *  `@vibe-tavern/domain` so the service + contract + client never drift. */
export interface SceneBackfillStatusResponse {
	runId: string;
	chatId: string;
	/** 'fill-missing' | 'rebuild'. */
	mode: string;
	/** 'pending' | 'running' | 'completed' | 'cancelled' | 'failed'. */
	status: string;
	total: number;
	processed: number;
	current: { messageId: string; variantId: string } | null;
	errors: SceneBackfillErrorEntry[];
	summary: SceneBackfillSummary | null;
	cancelRequested: boolean;
}

/**
 * Co-Author Apply response (CA-7). Extends {@link ConfigPatchResponse} (the
 * character field is the updated card) with `corrections` — backend-applied
 * data-loss guards surfaced to the user as a toast rather than silently masked
 * (see plan R3). Currently fires only when an empty `name` was restored from
 * the existing character; section/greeting emptiness is intentional-or-loss and
 * is handled upstream (tool guard CA-17) or on the diff (CA-10), not here.
 */
export interface CoauthorApplyResponse extends ConfigPatchResponse {
	corrections: CoauthorCorrection[];
	/**
	 * CTX-L2 (Wave 4): ids of lorebooks/entries written by the lore-bundle Apply
	 * branch. Empty arrays when no lore bundle was applied. The frontend uses
	 * these to confirm what was persisted (and to refresh its lore surfaces).
	 */
	lore?: { lorebookIds: string[]; entryIds: string[] };
}

/** Summary CRUD: create / update / delete ranged summary. */
export interface SummaryResponse {
	summaries: SessionSnapshot["summaries"];
}

/**
 * A character version (VTF Phase 3 folder-snapshot branching). Meta only on the
 * wire — content lives in files. `isActive` is true for exactly one version per
 * character; the active version's content is swapped into the character folder
 * root and read by getById. See plans/VIBE_TAVERN_FORMAT.md (Phase 3).
 */
export interface CharacterVersionResponse {
	id: string;
	characterId: string;
	title: string;
	isActive: boolean;
	createdAt: string;
}

/** Union of all per-endpoint builder responses (used to type route returns in B1.2+). */
export type SessionPartialResponse =
	| MessageResponse
	| VariantResponse
	| BranchResponse
	| BranchMetaResponse
	| ChatListResponse
	| ChatSwitchResponse
	| ChatCreateResponse
	| ConfigPatchResponse
	| SummaryResponse;
