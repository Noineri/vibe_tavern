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
 * Looks (RAIL_DRILL_IN RD-2) follow the desktop compact-sidebar flyout
 * (`SidebarFlyout.tsx`), sized for touch: flat chat rows (no card), the active
 * chat tinted with a 3 px accent bar, line 2 «when · N msgs»; the active RP
 * chat's line 2 ends with a branch-count badge that collapses / expands the
 * branches block (open by default — `character-chats-branches.tsx`). Inactive
 * chats keep their «↳ active branch» line. Mockup:
 * `RAIL_DRILL_IN_mockups/rail-drill-in.html`, screen 2.
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
import { formatRelativeTime } from "../sidebar-utils.js";
import { useT } from "../../../i18n/context.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import { useLastNonNull } from "../../../hooks/use-last-non-null.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import { ChatBranchesBlock, type BranchActionsController } from "./character-chats-branches.js";

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
	/**
	 * Chat controller slice behind the branches block's «Branch» / «Delete»
	 * buttons. RP hosts pass it; Co-Author never does (it has no branches), so
	 * the actions row cannot appear there.
	 */
	chat?: BranchActionsController;
	setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
	openChatImport: () => void;
	onSwitchChat: (id: ChatId) => void;
	/** The empty state's «new chat» button. */
	onCreateChat: () => void;
}

export function CharacterChatsPanel({
	chats, activeChatId, branches, activeBranchId,
	withBranches, emptyTitleKey, mode,
	character, chat, setConfirmDestroy, openChatImport,
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
	// The active chat's branches block is OPEN by default; the badge collapses it.
	// Tracks the chats whose block the user collapsed (not the open ones).
	const [collapsedBranchChats, setCollapsedBranchChats] = useState<readonly ChatId[]>([]);
	const toggleBranches = (chatId: ChatId) =>
		setCollapsedBranchChats((cur) => (cur.includes(chatId) ? cur.filter((id) => id !== chatId) : [...cur, chatId]));

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
			<div className="max-h-[55vh] overflow-y-auto pb-3">
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
					filtered.map((ch) => {
						const isActive = ch.id === activeChatId;
						// Branches data lives in the snapshot, so it exists for the active chat only.
						const showBranches = withBranches && isActive && branches.length > 0;
						const branchesOpen = showBranches && !collapsedBranchChats.includes(ch.id);
						return (
							<div key={ch.id}>
								<div
									className={cn(
										"group relative mx-1.5 flex min-h-[48px] cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pl-3 pr-1 transition-[background-color,transform] duration-150 ease-out active:scale-[0.96]",
										isActive ? "bg-accent-dim" : "active:bg-s3",
									)}
									onClick={() => { onSwitchChat(ch.id); }}
								>
									{isActive && <div className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full bg-accent" />}
									<div className="flex min-w-0 flex-1 flex-col">
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
											<span className={cn("min-w-0 truncate text-[calc(var(--ui-fs)-1px)]", isActive ? "font-medium text-accent-t" : "text-t1")}>
												{ch.title}
											</span>
										)}
										{/* Line 2 — the flyout's «when · N msgs», plus the branch badge on the active RP chat */}
										{/* Wraps instead of overflowing: with Russian strings the 260px rail leaves ~190px for «relative time · N msgs [badge]». */}
										<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[calc(var(--ui-fs)-3px)] text-t3">
											<span className="shrink-0 whitespace-nowrap tabular-nums">{formatRelativeTime(ch.updatedAt)}</span>
											<span className="shrink-0 text-t4">·</span>
											<span className="shrink-0 whitespace-nowrap tabular-nums">{ch.messageCount} {t("msgs_short")}</span>
											{showBranches && (
												<button
													type="button"
													className="relative inline-flex shrink-0 cursor-pointer items-center gap-[3px] rounded border border-border2 px-[5px] py-px font-ui tabular-nums text-t3 transition-colors duration-100 before:absolute before:-inset-2 before:content-[''] active:bg-s3 active:text-t1 [&_svg]:h-2.5 [&_svg]:w-2.5"
													aria-label={t("sidebar_chat_branches")}
													aria-expanded={branchesOpen}
													onClick={(e) => { e.stopPropagation(); toggleBranches(ch.id); }}
												>
													<Icons.Stack /> {branches.length}
												</button>
											)}
										</div>
										{/* For inactive chats — show the active-branch label */}
										{!isActive && ch.activeBranchLabel && (
											<span className="mt-0.5 truncate text-[calc(var(--ui-fs)-4px)] text-t4">↳ {ch.activeBranchLabel}</span>
										)}
									</div>

									{/* Chat three-dot menu — enlarged touch target */}
									<button type="button"
										className={cn(
											"flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-t3 transition-colors hover:text-t1 active:bg-s3",
											chatMenuId === ch.id && "text-t1 bg-s3",
										)}
										onClick={(e) => { e.stopPropagation(); setChatMenuId(ch.id); setBranchMenuId(null); }}
									>
										<Ic.ellipsis />
									</button>
								</div>

								{/* Branches — active RP chat only, open by default */}
								{branchesOpen && (
									<ChatBranchesBlock
										chatTitle={ch.title}
										branches={branches}
										activeBranchId={activeBranchId}
										menuBranchId={branchMenuId?.chatId === ch.id ? branchMenuId.branchId : null}
										renamingBranchId={renamingBranch?.chatId === ch.id ? renamingBranch.branchId : null}
										renameDraft={branchRenameDraft}
										onRenameDraftChange={setBranchRenameDraft}
										onRenameCommit={commitBranchRename}
										onRenameCancel={() => setRenamingBranch(null)}
										onActivate={(branchId) => { void activateBranchAction(ch.id, branchId); }}
										onOpenMenu={(b) => { setChatMenuId(null); setBranchMenuId({ chatId: ch.id, branchId: b.id, label: b.label }); }}
										chat={chat}
										setConfirmDestroy={setConfirmDestroy}
									/>
								)}
							</div>
						);
					})
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
