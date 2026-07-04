/**
 * Context-menu action builders — shared by the mobile `Rail`, the co-author
 * shells (`CoauthorSidebar` / `CoauthorRail`), and any future consumer.
 *
 * Each builder returns a ready-to-render `RowActionItem[]` for one context
 * menu (character / chat / branch). Rename and delete are offered for every
 * chat regardless of nav mode — these are basic chat-management operations.
 * The only mode-gated items are the SillyTavern-style JSONL chat-portability
 * actions: chat export (in the chat menu) and chat import (in the character
 * menu) are RP-only — the co-author surface intentionally does not surface
 * JSONL chat import/export. `buildBranchMenuItems` is RP-only in practice
 * because co-author has no branches/swipes, so the co-author shells simply
 * never call it.
 *
 * The desktop RP `Sidebar` does NOT consume this hook: it renders its menus as
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
	/** Nav mode — gates only JSONL chat portability (export/import). Rename and delete are universal. */
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

	const buildCharMenuItems = (charId: string, charName: string): RowActionItem[] => {
		const items: RowActionItem[] = [
			{ icon: <Ic.download />, label: t("sidebar_export"), action: () => character.handleExportCharacter(charId) },
			{ icon: <Ic.copy />, label: t("duplicate"), action: () => character.handleDuplicateCharacter(charId) },
		];
		// JSONL chat import is RP-only — the co-author surface does not surface JSONL chat portability.
		if (mode === "rp") {
			items.push({ icon: <Ic.import />, label: t("sidebar_import_chat"), action: () => setChatImportOpen(true) });
		}
		items.push({
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
		});
		return items;
	};

	const buildChatMenuItems = (chatId: ChatId, chatTitle: string): RowActionItem[] => {
		const items: RowActionItem[] = [
			{
				icon: <Ic.edit />,
				label: t("sidebar_rename"),
				action: () => {
					setRenamingChatId(chatId);
					setRenameDraft(chatTitle);
				},
			},
		];
		// JSONL chat export is RP-only — the co-author surface does not surface JSONL chat portability.
		if (mode === "rp") {
			items.push({ icon: <Ic.download />, label: t("sidebar_export_jsonl"), action: () => character.handleExportChatJsonl(chatId) });
		}
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
