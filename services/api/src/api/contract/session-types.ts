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
	PromptPresetDto,
	PromptTraceRecordDto,
} from "@vibe-tavern/domain";
import type { Chat, ChatBranch, UiSettings } from "@vibe-tavern/db";
import type { MessageDto } from "../../runtime/session/session-runtime-dto.js";
import type { CharacterRecord } from "../../domain/character/character-runtime.js";
import type { PersonaRecord } from "../../domain/persona/persona-runtime.js";

export interface ChatListItem {
	id: ChatId;
	title: string;
	characterId: CharacterId;
	characterName: string;
	subtitle: string;
	activeBranchLabel: string;
	messageCount: number;
	updatedAt: string;
}

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
	/** Last N prompt traces for the active branch. */
	promptTraceHistory: PromptTraceRecordDto[];
	/** Live context preview (null when traces exist — known bug, see Phase 3.1). */
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
	snapshot: SessionSnapshot;
	imported: {
		kind: "character" | "lorebook" | "chat";
		name: string;
		fileName: string;
		warningCount: number;
		warnings: string[];
		attachedToCharacterName?: string;
	};
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
// change" rule — it is NOT coupled to prompt-trace presence (that coupling
// was the Phase-3.1 "trace shadows preview" bug, and is intentionally left
// behind). Builders compute the preview via `assembleContextPreview` directly.
//
// Every field type is indexed off `SessionSnapshot[...]` so these contracts
// track the canonical shape without drift.

/** Message-path mutations: send, regenerate, edit, delete, create-variant. */
export interface MessageResponse {
	messages: SessionSnapshot["messages"];
	contextPreview: SessionSnapshot["contextPreview"];
	/** send / delete-message move summary markers; edit / create-variant do not. */
	summaries?: SessionSnapshot["summaries"];
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

/** Summary CRUD: create / update / delete ranged summary. */
export interface SummaryResponse {
	summaries: SessionSnapshot["summaries"];
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
