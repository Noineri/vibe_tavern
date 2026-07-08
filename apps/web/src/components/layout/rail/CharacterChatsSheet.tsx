/**
 * CharacterChatsSheet — the tablet bottom sheet that lists a character's chats
 * (+ branches for the active chat in RP mode), launched from the collapsed
 * Rail's avatar tap. The mobile-native counterpart to the desktop Sidebar's
 * `SidebarFlyout`, but as a `BottomSheet` (tablet flow — the 56px rail is
 * tablet-only; on phones the rail is hidden by default and toggled from the
 * TopBar) and with a branches block the flyout does not (yet) have.
 *
 * Self-contained: owns its UI state (chat search, chat/branch ⋮ context menus,
 * inline chat/branch rename, branches expand). The host passes data (chats for
 * the character, branches for the active chat) + the `useRowActions` deps +
 * navigation callbacks. `useRowActions` is called here (not in the host) so the
 * rename items close over THIS sheet's rename setters and activate the inline
 * input inside the sheet — the same self-coupling the expanded Rail panel uses.
 *
 * Mode-parameterized for the three RP/coauthor divergences:
 *  - `withBranches`: RP renders the branches block under the active chat; coauthor never.
 *  - `mode`: forwarded to `useRowActions` (gates JSONL chat export in the chat menu).
 *  - `emptyTitleKey`: i18n key for the no-chats empty state (coauthor characters
 *    can have zero chats; RP characters always have ≥1).
 *
 * Built on the shared `BottomSheet` (Base UI Drawer). The ⋮ context menus are
 * `ActionSheet` instances rendered as nested drawers — Base UI handles the
 * stacking (`data-nested-drawer-open` on this sheet's popup). Branches data is
 * only available for the active chat (it lives in the session snapshot), so the
 * branches block renders exclusively under `ch.id === activeChatId` — if the
 * sheet is open on a non-active character whose chat list does not contain the
 * active chat, no branches block appears (same constraint as the expanded Rail).
 */
import { useState } from "react";
import type { ChatBranch, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { Ic, Icons } from "../../shared/icons.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { ActionSheet, type ActionSheetItem } from "../../shared/ActionSheet.js";
import { initials } from "../app-shell-helpers.js";
import { activateBranchAction, renameBranchAction } from "../../../stores/api-actions/chat-actions.js";
import { useRowActions } from "../hooks/use-row-actions.js";
import { useT } from "../../../i18n/context.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";

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
	setChatImportOpen: (open: boolean) => void;
	onClose: () => void;
	onSwitchChat: (id: ChatId) => void;
	onCreateChat: () => void;
}

export function CharacterChatsSheet({
	characterId, characterName, characterAvatarSrc,
	chats, activeChatId, branches, activeBranchId,
	withBranches, emptyTitleKey, mode,
	character, setConfirmDestroy, setChatImportOpen,
	onClose, onSwitchChat, onCreateChat,
}: CharacterChatsSheetProps) {
	const { t } = useT();

	// ── UI state ──
	const [chatQuery, setChatQuery] = useState("");
	const [chatMenuId, setChatMenuId] = useState<ChatId | null>(null);
	const [branchMenuId, setBranchMenuId] = useState<{ chatId: ChatId; branchId: ChatBranchId; label: string } | null>(null);
	const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renamingBranch, setRenamingBranch] = useState<{ chatId: ChatId; branchId: ChatBranchId } | null>(null);
	const [branchRenameDraft, setBranchRenameDraft] = useState("");
	const [branchesOpen, setBranchesOpen] = useState<ChatId | null>(null);

	// useRowActions is called HERE so the rename menu items close over this
	// sheet's rename setters and drive the inline inputs below.
	const rowActions = useRowActions({
		mode,
		character,
		setConfirmDestroy,
		setRenamingChatId,
		setRenameDraft,
		setRenamingBranch,
		setBranchRenameDraft,
		setChatImportOpen,
	});

	if (!characterId) return null;

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

				{/* ── Search ── */}
				<div className="shrink-0 px-3 pb-2">
					<div className="flex items-center gap-2 rounded-lg border border-border bg-s2 px-2 py-1 transition-colors focus-within:border-accent/60">
						<Icons.Search className="h-3.5 w-3.5 shrink-0 text-t3" />
						<input
							type="text"
							value={chatQuery}
							onChange={(e) => setChatQuery(e.target.value)}
							placeholder={t("chat_search_placeholder")}
							className="min-w-0 flex-1 bg-transparent font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none placeholder:text-t4"
						/>
						{chatQuery && (
							<button type="button" className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-t1" aria-label={t("chat_search_clear")} onClick={() => setChatQuery("")}>
								<Ic.close />
							</button>
						)}
					</div>
				</div>

				{/* ── Chat list ── */}
				<div className="max-h-[55vh] overflow-y-auto px-2 pb-3">
					{chats.length === 0 ? (
						<div className="empty-state" style={{ minHeight: 160, padding: "32px 16px" }}>
							<div className="empty-icon" style={{ width: 40, height: 40 }}><Icons.Chat className="h-5 w-5" /></div>
							<div className="empty-title">{t(emptyTitleKey)}</div>
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
									<input
										className="mb-px w-full rounded border border-accent bg-bg px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none"
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
											<Ic.branch /> {branches.length} {t("branches")}
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
																<input
																	className="mb-px w-full rounded border border-accent bg-bg px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none"
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
			</div>

			{/* ═══ Context-menu bottom sheets (nested drawers — Base UI stacks them) ═══ */}
			{chatMenuId && (
				<ActionSheet
					open={true}
					title={chats.find((c) => c.id === chatMenuId)?.title ?? ""}
					items={chatMenuItems(chatMenuId, chats.find((c) => c.id === chatMenuId)?.title ?? "")}
					onClose={() => setChatMenuId(null)}
				/>
			)}
			{branchMenuId && (
				<ActionSheet
					open={true}
					title={branchMenuId.label || t("sidebar_unnamed_branch")}
					items={branchMenuItems(branchMenuId)}
					onClose={() => setBranchMenuId(null)}
				/>
			)}
		</BottomSheet>
	);
}
