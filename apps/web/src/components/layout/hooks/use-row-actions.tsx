/**
 * Context-menu action builders — shared by the mobile `Rail` (today) and the
 * co-author shells after the fork (`CoauthorSidebar` / `CoauthorRail`, SF-4/5).
 *
 * Each builder returns a ready-to-render `RowActionItem[]` for one context
 * menu (character / chat / branch), parameterized by nav `mode`:
 *  - `buildChatMenuItems` omits the rename action under `coauthor` (the flat-
 *    editor design from `VTF_COAUTHOR_PLAN.md` — co-author chats have no rename
 *    affordance on rows); RP keeps rename.
 *  - `buildBranchMenuItems` exists but is RP-only in practice — co-author has
 *    no branches/swipes, so the co-author fork simply never calls it.
 *
 * The desktop `Sidebar` does NOT consume this hook: it renders its menus as
 * inline JSX (`<div role="menuitem">` sequences), not item arrays, and
 * converting it would be a render rewrite that violates the "RP regression-zero
 * by construction" constraint. The Sidebar stays RP-only after the fork, so it
 * needs no mode parameterization. (See SF-3 Execution log — plan deviation B.)
 *
 * Deps are passed in (controller methods + setters + the i18n `t` function) so
 * the hook is pure over the store layer and testable without a provider. Names
 * and titles are builder PARAMETERS, not lookups — the call site already has
 * the row in hand and passes its id + label.
 */
import type { ReactNode } from "react";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { ChatRemovalMode } from "../../../hooks/use-character-controller.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import { Ic } from "../../shared/icons.js";
import { useT } from "../../../i18n/context.js";

/** One row in a context-menu bottom sheet (or any menu rendered from items). */
export interface RowActionItem {
	readonly icon: ReactNode;
	readonly label: string;
	readonly danger?: boolean;
	readonly action: () => void;
}

/** The character-controller surface this hook calls. Structural — any object
 *  with these methods satisfies it (the real `useCharacterController` return). */
export interface RowActionsCharacter {
	readonly handleExportCharacter: (characterId: string) => Promise<void>;
	readonly handleDuplicateCharacter: (characterId: string) => Promise<void>;
	readonly handleDeleteCharacter: (characterId: string) => Promise<void>;
	readonly handleExportChatJsonl: (chatId: ChatId) => Promise<void>;
	readonly getChatRemovalMode: (chatId: ChatId) => ChatRemovalMode;
	readonly handleRemoveChat: (chatId: ChatId) => Promise<void>;
}

export interface UseRowActionsArgs {
	/** Nav mode — drives which actions are offered (rename omitted under coauthor). */
	readonly mode: "rp" | "coauthor";
	readonly character: RowActionsCharacter;
	readonly setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
	readonly setRenamingChatId: (id: ChatId | null) => void;
	readonly setRenameDraft: (draft: string) => void;
	readonly setRenamingBranch: (b: { chatId: ChatId; branchId: ChatBranchId } | null) => void;
	readonly setBranchRenameDraft: (draft: string) => void;
	/** Opens the chat-import flow from the character menu (RP behavior). */
	readonly setChatImportOpen: (open: boolean) => void;
}

export interface BranchMenuTarget {
	readonly chatId: ChatId;
	readonly branchId: ChatBranchId;
	readonly label: string;
}

export interface UseRowActionsResult {
	readonly buildCharMenuItems: (charId: string, charName: string) => RowActionItem[];
	readonly buildChatMenuItems: (chatId: ChatId, chatTitle: string) => RowActionItem[];
	readonly buildBranchMenuItems: (target: BranchMenuTarget) => RowActionItem[];
}

export function useRowActions({
	mode,
	character,
	setConfirmDestroy,
	setRenamingChatId,
	setRenameDraft,
	setRenamingBranch,
	setBranchRenameDraft,
	setChatImportOpen,
}: UseRowActionsArgs): UseRowActionsResult {
	const { t } = useT();

	const buildCharMenuItems = (charId: string, charName: string): RowActionItem[] => [
		{ icon: <Ic.download />, label: t("sidebar_export"), action: () => character.handleExportCharacter(charId) },
		{ icon: <Ic.copy />, label: t("duplicate"), action: () => character.handleDuplicateCharacter(charId) },
		{ icon: <Ic.import />, label: t("sidebar_import_chat"), action: () => setChatImportOpen(true) },
		{
			icon: <Ic.del />,
			label: t("delete"),
			danger: true,
			action: () => {
				setConfirmDestroy({
					title: t("sidebar_delete_character"),
					body: <>{t("sidebar_are_you_sure")} <b>{charName}</b></>,
					confirmLabel: t("delete"),
					onConfirm: () => character.handleDeleteCharacter(charId),
				});
			},
		},
	];

	const buildChatMenuItems = (chatId: ChatId, chatTitle: string): RowActionItem[] => {
		const items: RowActionItem[] = [];
		// Rename is RP-only — co-author chats have no rename affordance (flat editor).
		if (mode === "rp") {
			items.push({
				icon: <Ic.edit />,
				label: t("sidebar_rename"),
				action: () => {
					setRenamingChatId(chatId);
					setRenameDraft(chatTitle);
				},
			});
		}
		items.push({ icon: <Ic.download />, label: t("sidebar_export_jsonl"), action: () => character.handleExportChatJsonl(chatId) });
		const clearsOnRemove = character.getChatRemovalMode(chatId) === "clear";
		items.push({
			icon: <Ic.del />,
			label: clearsOnRemove ? t("sidebar_clear_chat") : t("delete"),
			danger: true,
			action: () => {
				setConfirmDestroy({
					title: clearsOnRemove ? t("sidebar_clear_chat") : t("sidebar_delete_chat"),
					body: clearsOnRemove
						? <>{t("sidebar_clear_chat_confirm")} <b>{chatTitle}</b></>
						: <>{t("sidebar_are_you_sure")} <b>{chatTitle}</b></>,
					confirmLabel: clearsOnRemove ? t("sidebar_clear_chat") : t("delete"),
					onConfirm: () => character.handleRemoveChat(chatId),
				});
			},
		});
		return items;
	};

	const buildBranchMenuItems = (target: BranchMenuTarget): RowActionItem[] => [
		{
			icon: <Ic.edit />,
			label: t("sidebar_rename"),
			action: () => {
				setRenamingBranch({ chatId: target.chatId, branchId: target.branchId });
				setBranchRenameDraft(target.label);
			},
		},
	];

	return { buildCharMenuItems, buildChatMenuItems, buildBranchMenuItems };
}
