/**
 * CharacterChatsPanel — everything a character's chats screen shows below its
 * header: chat search, the chat list (with its no-chats / no-results states),
 * the branches block for the active chat (RP), inline chat/branch rename, and
 * the chat/branch ⋮ context menus.
 *
 * Extracted from `CharacterChatsSheet` (RAIL_DRILL_IN RD-1) so the phone rail's
 * «character screen» and the tablet bottom sheet share ONE implementation. The
 * host supplies the header chrome (the sheet: avatar, name, «+», close) and the
 * surrounding column layout; this component renders a fragment — the search
 * block, the scrolling list and the two ⋮ `ActionSheet`s — so it slots straight
 * into the host's flex column.
 *
 * Self-contained: owns its UI state (chat search, chat/branch ⋮ context menus,
 * inline chat/branch rename, branches expand). The host passes data (chats for
 * the character, branches for the active chat) + the `useRowActions` deps +
 * navigation callbacks. `useRowActions` is called here (not in the host) so the
 * rename items close over THIS panel's rename setters and activate the inline
 * input inside the panel — the same self-coupling the expanded Rail panel uses.
 *
 * Mode-parameterized for the three RP/coauthor divergences:
 *  - `withBranches`: RP renders the branches block under the active chat; coauthor never.
 *  - `mode`: forwarded to `useRowActions` (gates JSONL chat export in the chat menu).
 *  - `emptyTitleKey`: i18n key for the no-chats empty state (coauthor characters
 *    can have zero chats; RP characters always have ≥1).
 *
 * The ⋮ context menus are `ActionSheet` instances (Base UI Drawers). Rendered
 * inside a host `BottomSheet` they stack as nested drawers (Base UI sets
 * `data-nested-drawer-open` on the host's popup); the panel has no DOM of its
 * own for them (they portal), so placing them here instead of next to the host's
 * column changes nothing in the rendered tree. Branches data is only available
 * for the active chat (it lives in the session snapshot), so the branches block
 * renders exclusively under `ch.id === activeChatId` — if the host lists a
 * non-active character whose chat list does not contain the active chat, no
 * branches block appears (same constraint as the expanded Rail).
 */
import { useState } from "react";
import type { ChatBranch, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { Ic, Icons } from "../../shared/icons.js";
import { InlineRenameInput } from "../../shared/InlineRenameInput.js";
import { SearchInput } from "../../shared/SearchInput.js";
import { ActionSheet, type ActionSheetItem } from "../../shared/ActionSheet.js";
import { activateBranchAction, renameBranchAction } from "../../../stores/api-actions/chat-actions.js";
import { useRowActions } from "../hooks/use-row-actions.js";
import { useT } from "../../../i18n/context.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import { useLastNonNull } from "../../../hooks/use-last-non-null.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";

export interface CharacterChatsPanelProps {
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
	onSwitchChat: (id: ChatId) => void;
	/** The empty state's «new chat» button. */
	onCreateChat: () => void;
}

export function CharacterChatsPanel({
	chats, activeChatId, branches, activeBranchId,
	withBranches, emptyTitleKey, mode,
	character, setConfirmDestroy, openChatImport,
	onSwitchChat, onCreateChat,
}: CharacterChatsPanelProps) {
	const { t, tDynamic } = useT();

	// ── UI state ──
	const [chatQuery, setChatQuery] = useState("");
	const [chatMenuId, setChatMenuId] = useState<ChatId | null>(null);
	const [branchMenuId, setBranchMenuId] = useState<{ chatId: ChatId; branchId: ChatBranchId; label: string } | null>(null);
	// Freeze the menu ids so the closing nested ActionSheet keeps rendering its
	// last content during the Base UI exit transition (menuId → null on close).
	const frozenChatMenuId = useLastNonNull(chatMenuId);
	const frozenBranchMenuId = useLastNonNull(branchMenuId);
	const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renamingBranch, setRenamingBranch] = useState<{ chatId: ChatId; branchId: ChatBranchId } | null>(null);
	const [branchRenameDraft, setBranchRenameDraft] = useState("");
	const [branchesOpen, setBranchesOpen] = useState<ChatId | null>(null);

	// useRowActions is called HERE so the rename menu items close over this
	// panel's rename setters and drive the inline inputs below.
	const rowActions = useRowActions({
		mode,
		character,
		setConfirmDestroy,
		setRenamingChatId,
		setRenameDraft,
		setRenamingBranch,
		setBranchRenameDraft,
		openChatImport,
	});

	const q = chatQuery.trim().toLowerCase();
	const filtered = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;

	const commitRename = () => {
		const next = renameDraft.trim();
		if (next && renamingChatId) void character.handleRenameChat(renamingChatId, next);
		setRenamingChatId(null);
	};
	const commitBranchRename = () => {
		const next = branchRenameDraft.trim();
		if (next && renamingBranch) void renameBranchAction(renamingBranch.chatId, renamingBranch.branchId, next);
		setRenamingBranch(null);
	};

	// useRowActions returns readonly RowActionItem[]; ActionSheet wants mutable
	// ActionSheetItem[] (with optional `trailing`). The shapes overlap on
	// {icon,label,danger,action}; destructure into a fresh object to drop the
	// readonly modifiers without a cast.
	const chatMenuItems = (chatId: ChatId, title: string): ActionSheetItem[] =>
		rowActions.buildChatMenuItems(chatId, title).map(({ icon, label, danger, action }) => ({ icon, label, danger, action }));
	const branchMenuItems = (target: { chatId: ChatId; branchId: ChatBranchId; label: string }): ActionSheetItem[] =>
		rowActions.buildBranchMenuItems(target).map(({ icon, label, danger, action }) => ({ icon, label, danger, action }));

	return (
		<>
			{/* ── Search ── */}
			<div className="shrink-0 px-3 pb-2">
				<SearchInput
					value={chatQuery}
					onChange={(e) => setChatQuery(e.target.value)}
					placeholder={t("chat_search_placeholder")}
					trailing={
						chatQuery ? (
							<button type="button" className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-t1" aria-label={t("chat_search_clear")} onClick={() => setChatQuery("")}>
								<Ic.close />
							</button>
						) : undefined
					}
				/>
			</div>

			{/* ── Chat list ── */}
			<div className="max-h-[55vh] overflow-y-auto px-2 pb-3">
				{chats.length === 0 ? (
					<div className="empty-state" style={{ minHeight: 160, padding: "32px 16px" }}>
						<div className="empty-icon" style={{ width: 40, height: 40 }}><Icons.Chat className="h-5 w-5" /></div>
						<div className="empty-title">{tDynamic(emptyTitleKey)}</div>
						<button type="button" className="empty-cta" onClick={onCreateChat}>{t("new_chat")}</button>
					</div>
				) : filtered.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
						<Icons.Search className="h-5 w-5 text-t4" />
						<div className="text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">{t("chat_search_no_results", { query: chatQuery })}</div>
						<button type="button" className="text-[calc(var(--ui-fs)-2px)] text-accent-t transition-colors hover:underline" onClick={() => setChatQuery("")}>{t("chat_search_clear")}</button>
					</div>
				) : (
					filtered.map((ch) => (
						<div
							key={ch.id}
							className={cn(
								"group relative flex min-h-[48px] cursor-pointer flex-col rounded-lg px-3 py-2 transition-[background-color,transform] duration-150 ease-out active:scale-[0.96]",
								ch.id === activeChatId ? "bg-accent-dim border border-accent/30" : "bg-s2/30 active:bg-s3",
							)}
							onClick={() => { onSwitchChat(ch.id); }}
						>
							{renamingChatId === ch.id ? (
								<InlineRenameInput
									className="mb-px"
									value={renameDraft}
									autoFocus
									onChange={(e) => setRenameDraft(e.target.value)}
									onClick={(e) => e.stopPropagation()}
									onBlur={commitRename}
									onKeyDown={(e) => {
										if (e.key === "Enter") { e.preventDefault(); commitRename(); }
										else if (e.key === "Escape") { e.preventDefault(); setRenamingChatId(null); }
									}}
								/>
							) : (
								<span className={cn("min-w-0 truncate pr-12 text-[calc(var(--ui-fs)-2px)]", ch.id === activeChatId ? "text-accent-t font-medium" : "text-t2")}>
									{ch.title}
								</span>
							)}
							<span className="min-w-0 truncate pr-12 text-[calc(var(--ui-fs)-4px)] text-t3">
								{ch.subtitle}
							</span>

							{/* Chat three-dot menu — enlarged touch target */}
							<button type="button"
								className={cn(
									"absolute right-1 top-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-t3 transition-colors hover:text-t1 active:bg-s3",
									chatMenuId === ch.id && "text-t1 bg-s3",
								)}
								onClick={(e) => { e.stopPropagation(); setChatMenuId(ch.id); setBranchMenuId(null); }}
							>
								<Ic.ellipsis />
							</button>

							{/* Branches — active chat only (data lives in the snapshot) */}
							{withBranches && ch.id === activeChatId && branches.length > 0 && (
								<>
									<button type="button"
										className="mt-1 flex min-h-[44px] items-center gap-1.5 rounded-md px-1 text-[calc(var(--ui-fs)-3px)] text-t4 active:bg-s3 active:text-t2 transition-colors"
										onClick={(e) => { e.stopPropagation(); setBranchesOpen(branchesOpen === ch.id ? null : ch.id); }}
									>
										<Ic.branch /> {t("branch_count", { count: branches.length })}
									</button>
									{branchesOpen === ch.id && (
										<div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-border/30 pl-2">
											{branches.map((b) => {
												const isRenamingThisBranch = renamingBranch?.branchId === b.id && renamingBranch?.chatId === ch.id;
												return (
													<div
														key={b.id}
														className={cn(
															"flex cursor-pointer items-center gap-1.5 rounded-md px-2 min-h-[44px] text-[calc(var(--ui-fs)-2px)] transition-colors active:bg-s3",
															b.id === activeBranchId ? "text-accent-t font-medium bg-accent-dim/50" : "text-t3",
														)}
														onClick={(e) => { if (!isRenamingThisBranch) { e.stopPropagation(); void activateBranchAction(ch.id, b.id); } }}
													>
														<span className={cn("inline-block h-2 w-2 rounded-full shrink-0", b.id === activeBranchId ? "bg-accent" : "bg-border2")} />
														{isRenamingThisBranch ? (
															<InlineRenameInput
																className="mb-px"
																value={branchRenameDraft}
																autoFocus
																onChange={(e) => setBranchRenameDraft(e.target.value)}
																onClick={(e) => e.stopPropagation()}
																onBlur={commitBranchRename}
																onKeyDown={(e) => {
																	if (e.key === "Enter") { e.preventDefault(); commitBranchRename(); }
																	else if (e.key === "Escape") { e.preventDefault(); setRenamingBranch(null); }
																}}
															/>
														) : (
															<span className="truncate">{b.label || t("sidebar_unnamed_branch")}</span>
														)}
														<button type="button" className={cn("ml-auto shrink-0 cursor-pointer items-center justify-center rounded p-1 text-t3 transition-all active:bg-s3 active:text-t1", branchMenuId?.branchId === b.id && "text-t1 bg-s3")} onClick={(e) => { e.stopPropagation(); setChatMenuId(null); setBranchMenuId({ chatId: ch.id, branchId: b.id, label: b.label }); }}>
															<Ic.ellipsis />
														</button>
													</div>
												);
											})}
										</div>
									)}
								</>
							)}
							{/* For inactive chats — show the active-branch label */}
							{ch.id !== activeChatId && ch.activeBranchLabel && (
								<span className="mt-0.5 truncate text-[calc(var(--ui-fs)-4px)] text-t4">↳ {ch.activeBranchLabel}</span>
							)}
						</div>
					))
				)}
			</div>

			{/* ═══ Context-menu bottom sheets (nested drawers — Base UI stacks them) ═══ */}
			<ActionSheet
				open={chatMenuId !== null}
				title={frozenChatMenuId ? (chats.find((c) => c.id === frozenChatMenuId)?.title ?? "") : ""}
				items={frozenChatMenuId ? chatMenuItems(frozenChatMenuId, chats.find((c) => c.id === frozenChatMenuId)?.title ?? "") : []}
				onClose={() => setChatMenuId(null)}
			/>
			<ActionSheet
				open={branchMenuId !== null}
				title={frozenBranchMenuId ? (frozenBranchMenuId.label || t("sidebar_unnamed_branch")) : ""}
				items={frozenBranchMenuId ? branchMenuItems(frozenBranchMenuId) : []}
				onClose={() => setBranchMenuId(null)}
			/>
		</>
	);
}
