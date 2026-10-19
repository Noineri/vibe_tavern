import { Icons } from "../icons.js";
import { cn } from "../../../lib/cn.js";
import type { TFunc } from "../../../i18n/context.js";

/**
 * Chat-target footer for `AgentProfileModal` (SIDECHAT_PLAN SC-0k) —
 * extracted from the modal when the SC-0k change took it past the 800-line
 * new-file cap (extraction, never squeezing).
 *
 * One primary action: «Использовать здесь» keeps the Save button's primary
 * classes (state = the success fill + check, like the script button).
 * «Использовать по умолчанию» is the secondary action: the Cancel button's
 * classes, ordered first (the edit footer's Cancel → Save order); its state
 * is the check + the default label, disabled, still secondary (no fill). No
 * new strings — the four SC-0g keys are reused.
 */
export interface AgentChatProfileFooterProps {
	hasSelection: boolean;
	isSelectedHere: boolean;
	isSelectedDefault: boolean;
	t: TFunc;
	onAssignHere: () => void;
	onAssignDefault: () => void;
}

export function AgentChatProfileFooter({
	hasSelection,
	isSelectedHere,
	isSelectedDefault,
	t,
	onAssignHere,
	onAssignDefault,
}: AgentChatProfileFooterProps) {
	return (
		<>
			<button
				type="button"
				data-testid="copilot-profile-assign-default-btn"
				disabled={!hasSelection || isSelectedDefault}
				className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent px-4 py-1.5 font-ui text-[0.8rem] text-t2 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
				onClick={() => { void onAssignDefault(); }}
			>
				{isSelectedDefault && <Icons.Check className="h-3.5 w-3.5" />}
				{isSelectedDefault ? t("copilot_profile_default") : t("copilot_profile_use_by_default")}
			</button>
			<button
				type="button"
				data-testid="copilot-profile-assign-here-btn"
				disabled={!hasSelection || isSelectedHere}
				className={cn(
					"flex items-center gap-1.5 rounded-md px-4 py-1.5 font-ui text-[0.8rem] font-semibold transition-all",
					isSelectedHere
						? "cursor-default bg-success text-on-accent"
						: "cursor-pointer bg-accent text-on-accent hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-accent",
				)}
				onClick={() => { void onAssignHere(); }}
			>
				{isSelectedHere && <Icons.Check className="h-3.5 w-3.5" />}
				{isSelectedHere ? t("copilot_profile_active_here") : t("copilot_profile_use_here")}
			</button>
		</>
	);
}
