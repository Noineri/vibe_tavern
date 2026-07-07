import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "./Tooltip.js";
import { getModalPortal } from "./modal-helpers.js";

/**
 * Context-counter / token-breakdown flyout for the chat input toolbar.
 *
 * Purely informational (no value selection) — built on Radix Popover
 * (flyout pattern, overlay-audit step 8), NOT a Select. This is the shared
 * home for the token popover that was previously hand-rolled and duplicated
 * ~1:1 between the RP chat input (`InputArea.tsx`) and the co-author input
 * (`CoauthorInputArea.tsx`), each with its own `tokenPopRef` +
 * use-outside-click listener.
 *
 * The primitive owns the trigger span (the `permanent+dyn / size` counter,
 * color-coded by `tokenState`), the popover chrome, and the shared content
 * sections (header, "Постоянные" sub-header, "Временные" section, response
 * budget + total available rows, the three-segment usage bar). The one part
 * that DIFFERS between RP and co-author is the set of permanent-context rows
 * (RP: system/character/persona/lore/memory/tools; co-author:
 * module/skills/profile/lore/memory), so those are passed in as
 * `permanentItems`.
 *
 * Desktop-only — the mobile shells do not surface the counter. Migrating the
 * mobile shells to BottomSheet would be a separate step (the mobile toolbar
 * deliberately shows a leaner status row).
 */

/** One line in the "Постоянные" (permanent context) section. */
export interface TokenCounterItem {
	/** Already-translated label (e.g. `t("context_system")`). */
	label: ReactNode;
	/** Token count for this bucket. */
	value: number;
}

export interface TokenCounterPopoverProps {
	/** Sum of all permanent buckets — drives the trigger text and the first
	 *  usage-bar segment. Computed by the caller from its own `buckets`. */
	permanent: number;
	/** `buckets.history` — temporary-context history tokens. */
	history: number;
	/** Tokens in the current draft textarea. */
	inputTokens: number;
	/** Provider context budget; `0` means "unlimited" (rendered as `∞`). */
	contextSize: number;
	/** Max output tokens; `-1` means "unlimited" (rendered as `∞`). */
	maxTokens: number;
	/** `Math.max(0, contextSize - maxTokens)` — the denominator of the bar. */
	availableBudget: number;
	/** Derived color state (`>0.95` warn, `>0.75` mid, else ok). */
	tokenState: "ok" | "mid" | "warn";
	/** The permanent-context rows — the only caller-specific part. */
	permanentItems: TokenCounterItem[];
	/** Horizontal alignment relative to the trigger. RP centers the popover
	 *  under the counter; co-author right-aligns it (it sits at the row end).
	 *  Defaults to `"center"`. */
	align?: "center" | "end";
}

export function TokenCounterPopover({
	permanent,
	history,
	inputTokens,
	contextSize,
	maxTokens,
	availableBudget,
	tokenState,
	permanentItems,
	align = "center",
}: TokenCounterPopoverProps) {
	const { t } = useT();
	const [open, setOpen] = useState(false);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<span
					className={cn(
						"cursor-pointer whitespace-nowrap text-[calc(var(--ui-fs)-3px)] tabular-nums transition-colors duration-150 hover:text-t1",
						tokenState === "warn" ? "text-danger-text" : tokenState === "mid" ? "text-warning-text" : "text-t3",
					)}
				>
					{permanent.toLocaleString()}<span className="text-t4">+</span>{(history + inputTokens).toLocaleString()} / {contextSize > 0 ? contextSize.toLocaleString() : "∞"}
				</span>
			</Popover.Trigger>
			<Popover.Portal container={getModalPortal() ?? undefined}>
				<Popover.Content
					side="top"
					sideOffset={8}
					align={align}
					className="glass-blur z-[220] w-[240px] rounded-lg border border-border2 bg-glass-bg px-3.5 py-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
				>
					<div className="mb-1.5 border-b border-border pb-1.5 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("context_breakdown")}</div>
					<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_permanent")}</div>
					{permanentItems.map((item, i) => (
						<div
							key={i}
							className={cn(
								"mb-1 flex justify-between text-xs text-t2",
								i === permanentItems.length - 1 && "mb-1.5",
							)}
						>
							<span>{item.label}</span>
							<span className="tabular-nums text-t1">{item.value.toLocaleString()}</span>
						</div>
					))}

					<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_temporary")}</div>
					<div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_history")}</span><span className="tabular-nums text-t1">{history.toLocaleString()}</span></div>
					<div className="mb-1.5 flex justify-between text-xs text-t2"><span>{t("context_current_input")}</span><span className="tabular-nums text-t1">{inputTokens.toLocaleString()}</span></div>

					<div className="mb-1 flex justify-between border-t border-border pt-1.5 text-xs text-t2"><span>{t("context_response_budget")}</span><span className="tabular-nums text-t1">{maxTokens === -1 ? "∞" : `-${maxTokens.toLocaleString()}`}</span></div>
					<div className="mt-0.5 flex justify-between text-xs font-medium text-t1"><span>{t("context_total_available")}</span><span className="tabular-nums">{maxTokens === -1 ? "∞" : availableBudget.toLocaleString()}</span></div>

					{availableBudget > 0 && (
						<div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-s3">
							<div className="flex h-full">
								<CustomTooltip content={`${t("context_permanent")}: ${permanent.toLocaleString()}`}>
									<div className="bg-accent" style={{ width: `${Math.min(100, permanent / availableBudget * 100)}%` }} />
								</CustomTooltip>
								<CustomTooltip content={`${t("context_history")}: ${history.toLocaleString()}`}>
									<div className="bg-t3" style={{ width: `${Math.min(100, history / availableBudget * 100)}%` }} />
								</CustomTooltip>
								<CustomTooltip content={`${t("context_current_input")}: ${inputTokens.toLocaleString()}`}>
									<div className="bg-accent-t" style={{ width: `${Math.min(100, inputTokens / availableBudget * 100)}%` }} />
								</CustomTooltip>
							</div>
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
