/**
 * ChatBranchesBlock — the branches block under the ACTIVE chat row of the
 * character-chats panel (RP only): the «Timeline branches» header, the flat
 * branch list (label, «N msgs · date», ⋮), and the «Branch» / «Delete» actions.
 *
 * Styled after the desktop compact-sidebar flyout's block
 * (`SidebarFlyout.tsx`): dashed top border, a left rail with a short connector
 * per row, the active branch tinted with an accent connector — sized for touch
 * (rows ≥ 44 px, actions ≥ 44 px, the ⋮ button 36 px). Mockup:
 * `RAIL_DRILL_IN_mockups/rail-drill-in.html`, screen 2.
 *
 * Presentational: the panel owns every piece of state (inline rename draft,
 * the ⋮ sheet target) and passes it down; this block only renders and reports
 * taps. The two actions are the exception — they call the chat controller /
 * confirm dialog directly because they carry no panel state:
 *  - «Branch» → `chat.handleFork(undefined)` (fork from the chat's tail).
 *  - «Delete» → the flyout's confirm; when `canDeleteActiveBranch` forbids it
 *    (active branch is the root, or the only one) the button is muted like the
 *    flyout's and a tap shows the flyout tooltip's text as a toast — touch has
 *    no tooltips.
 */
import type { ChatBranch, ChatBranchId } from "@vibe-tavern/domain";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import { Ic, Icons } from "../../shared/icons.js";
import { InlineRenameInput } from "../../shared/InlineRenameInput.js";
import { useT } from "../../../i18n/context.js";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import { canDeleteActiveBranch, formatShortDate } from "../sidebar-utils.js";

/** The slice of the chat controller the block's two actions call. */
export type BranchActionsController = Pick<ChatControllerActions, "handleFork" | "handleDeleteActiveBranch">;

export interface ChatBranchesBlockProps {
	/** Title of the chat the branches belong to — names the root branch «Main» when equal to its label. */
	chatTitle: string;
	branches: readonly ChatBranch[];
	activeBranchId: ChatBranchId | null;
	/** Branch whose ⋮ sheet is open (its button stays highlighted). */
	menuBranchId: ChatBranchId | null;
	/** Branch being renamed inline, if any — its label becomes an input. */
	renamingBranchId: ChatBranchId | null;
	renameDraft: string;
	onRenameDraftChange: (draft: string) => void;
	onRenameCommit: () => void;
	onRenameCancel: () => void;
	onActivate: (branchId: ChatBranchId) => void;
	onOpenMenu: (branch: ChatBranch) => void;
	/** The fork / delete actions. Absent → the block renders no actions row. */
	chat: BranchActionsController | undefined;
	setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
}

export function ChatBranchesBlock({
	chatTitle, branches, activeBranchId, menuBranchId,
	renamingBranchId, renameDraft, onRenameDraftChange, onRenameCommit, onRenameCancel,
	onActivate, onOpenMenu, chat, setConfirmDestroy,
}: ChatBranchesBlockProps) {
	const { t } = useT();
	const canDelete = canDeleteActiveBranch(branches, activeBranchId);

	// The root branch of a chat usually carries the chat's own title as its
	// label; «Main» says what it is. Any other root label (renamed) shows as is.
	const displayLabel = (b: ChatBranch): string => {
		if (b.parentBranchId === null && b.label === chatTitle) return t("sidebar_main_branch");
		return b.label || t("sidebar_unnamed_branch");
	};

	const actionCls =
		"inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-1.5 text-center text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors duration-150 active:bg-s3 active:text-t1 [&_svg]:h-3 [&_svg]:w-3";

	return (
		<div className="mx-1.5 mb-1.5 mt-0.5 flex flex-col border-t border-dashed border-border2 pt-1.5">
			<div className="px-1.5 pb-1 text-[calc(var(--ui-fs)-4px)] font-medium uppercase tracking-[0.05em] text-t3">
				{t("sidebar_timeline_branches")}
			</div>
			<div className="ml-3 flex flex-col border-l-2 border-border pl-2.5">
				{branches.map((b) => {
					const isActiveBranch = b.id === activeBranchId;
					const isRenaming = renamingBranchId === b.id;
					return (
						<div
							key={b.id}
							className={cn(
								"relative flex min-h-[44px] cursor-pointer items-center gap-1 rounded-md py-1 pl-2 transition-colors active:bg-s3",
								isActiveBranch && "bg-accent-dim",
							)}
							onClick={() => { if (!isRenaming) onActivate(b.id); }}
						>
							<div className={cn("absolute -left-3 top-1/2 h-[2px] w-2.5 -translate-y-1/2", isActiveBranch ? "bg-accent" : "bg-border")} />
							<div className="flex min-w-0 flex-1 flex-col">
								{isRenaming ? (
									<InlineRenameInput
										className="mb-px"
										value={renameDraft}
										autoFocus
										onChange={(e) => onRenameDraftChange(e.target.value)}
										onClick={(e) => e.stopPropagation()}
										onBlur={onRenameCommit}
										onKeyDown={(e) => {
											if (e.key === "Enter") { e.preventDefault(); onRenameCommit(); }
											else if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
										}}
									/>
								) : (
									<span className={cn("min-w-0 truncate text-[calc(var(--ui-fs)-2px)] font-medium", isActiveBranch ? "text-accent-t" : "text-t2")}>
										{displayLabel(b)}
									</span>
								)}
								<span className="min-w-0 truncate text-[calc(var(--ui-fs)-3px)] text-t3">
									{b.messageCount ?? 0} {t("msgs_short")} · {formatShortDate(b.createdAt)}
								</span>
							</div>
							<button
								type="button"
								className={cn(
									"flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-t3 transition-colors hover:text-t1 active:bg-s3",
									menuBranchId === b.id && "bg-s3 text-t1",
								)}
								onClick={(e) => { e.stopPropagation(); onOpenMenu(b); }}
							>
								<Ic.ellipsis />
							</button>
						</div>
					);
				})}
			</div>

			{chat && (
				<div className="mt-1.5 flex gap-1.5 border-t border-border pt-1.5">
					<button type="button" className={actionCls} onClick={() => { void chat.handleFork(undefined); }}>
						<Icons.Branch /> {t("sidebar_fork_short")}
					</button>
					<button
						type="button"
						className={cn(actionCls, !canDelete && "cursor-not-allowed opacity-45")}
						aria-disabled={!canDelete}
						onClick={() => {
							if (!canDelete) { toast.info(t("sidebar_switch_to_non_main")); return; }
							setConfirmDestroy({
								title: t("sidebar_delete_branch"),
								body: t("sidebar_delete_branch_body"),
								confirmLabel: t("sidebar_delete_branch"),
								onConfirm: () => void chat.handleDeleteActiveBranch(),
							});
						}}
					>
						<Icons.Trash /> {t("sidebar_delete_branch_short")}
					</button>
				</div>
			)}
		</div>
	);
}
