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
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null }>;
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
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null }>;
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
