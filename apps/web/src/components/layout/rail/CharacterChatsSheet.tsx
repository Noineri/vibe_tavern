/**
 * CharacterChatsSheet — the tablet bottom sheet that lists a character's chats
 * (+ branches for the active chat in RP mode), launched from the collapsed
 * Rail's avatar tap. The mobile-native counterpart to the desktop Sidebar's
 * `SidebarFlyout`, but as a `BottomSheet` (tablet flow — the 56px rail is
 * tablet-only; on phones the rail is hidden by default and toggled from the
 * TopBar) and with a branches block the flyout does not (yet) have.
 *
 * A thin shell: it owns the `BottomSheet` and its header (avatar, name, «+»
 * new chat, close) and renders `CharacterChatsPanel` for everything below the
 * header (search, chat list, branches, rename, ⋮ menus). The panel is the one
 * implementation of that screen — the phone rail renders the same component —
 * so the host contract is unchanged: it passes data (chats for the character,
 * branches for the active chat) + the `useRowActions` deps + navigation
 * callbacks, and the mode parameters are forwarded to the panel:
 *  - `withBranches`: RP renders the branches block under the active chat; coauthor never.
 *  - `mode`: forwarded to `useRowActions` (gates JSONL chat export in the chat menu).
 *  - `emptyTitleKey`: i18n key for the no-chats empty state.
 *
 * The panel's ⋮ context menus are `ActionSheet` instances rendered as nested
 * drawers — Base UI handles the stacking (`data-nested-drawer-open` on this
 * sheet's popup).
 */
import type { ChatBranch, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { Ic } from "../../shared/icons.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { initials } from "../app-shell-helpers.js";
import { useT } from "../../../i18n/context.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import { CharacterChatsPanel } from "./character-chats-panel.js";

export interface CharacterChatsSheetProps {
	/** null = closed (the sheet renders nothing). */
	characterId: string | null;
	characterName: string;
	characterAvatarSrc: string | null;
	/** Mode-filtered chat list for this character. */
	chats: readonly ChatListItem[];
	activeChatId: ChatId | null;
	/** Branches for the active chat (RP). Empty for coauthor / non-active character. */
	branches: readonly ChatBranch[];
	activeBranchId: ChatBranchId | null;
	/** RP renders the branches block; coauthor never. */
	withBranches: boolean;
	/** i18n key for the no-chats empty state. */
	emptyTitleKey: string;
	/** Nav mode — forwarded to useRowActions (gates JSONL chat export). */
	mode: "rp" | "coauthor";
	/** Character controller (rename + the useRowActions surface). */
	character: CharacterControllerActions;
	setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
	openChatImport: () => void;
	onClose: () => void;
	onSwitchChat: (id: ChatId) => void;
	onCreateChat: () => void;
}

export function CharacterChatsSheet({
	characterId, characterName, characterAvatarSrc,
	chats, activeChatId, branches, activeBranchId,
	withBranches, emptyTitleKey, mode,
	character, setConfirmDestroy, openChatImport,
	onClose, onSwitchChat, onCreateChat,
}: CharacterChatsSheetProps) {
	const { t } = useT();

	if (!characterId) return null;

	return (
		<BottomSheet open={true} onClose={onClose}>
			<div className="flex max-h-[72vh] flex-col">
				{/* ── Header: avatar + name + new-chat + close ── */}
				<div className="flex items-center gap-2.5 px-4 pb-2 pt-1">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-s3 text-t2">
						{characterAvatarSrc
							? <img src={characterAvatarSrc} alt={characterName} className="h-full w-full object-cover" />
							: <span className="font-ui text-sm">{initials(characterName)}</span>}
					</div>
					<span className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)+0px)] font-semibold text-t1">{characterName}</span>
					<button type="button" className="iBtn size-8 shrink-0" aria-label={t("new_chat")} onClick={onCreateChat}><Ic.plus /></button>
					<button type="button" className="iBtn size-8 shrink-0" aria-label={t("close")} onClick={onClose}><Ic.close /></button>
				</div>

				{/* ── Everything below the header: search, chats, branches, ⋮ menus ── */}
				<CharacterChatsPanel
					chats={chats}
					activeChatId={activeChatId}
					branches={branches}
					activeBranchId={activeBranchId}
					withBranches={withBranches}
					emptyTitleKey={emptyTitleKey}
					mode={mode}
					character={character}
					setConfirmDestroy={setConfirmDestroy}
					openChatImport={openChatImport}
					onSwitchChat={onSwitchChat}
					onCreateChat={onCreateChat}
				/>
			</div>
		</BottomSheet>
	);
}
