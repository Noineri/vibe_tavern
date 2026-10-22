import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "./Tooltip.js";
import { BottomSheet } from "./BottomSheet.js";

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
 * sections (header, "Permanent" sub-header, "Temporary" section, response
 * budget + total available rows, the three-segment usage bar). The one part
 * that DIFFERS between RP and co-author is the set of permanent-context rows
 * (RP: system/character/persona/lore/memory/tools; co-author:
 * module/skills/profile/lore/memory), so those are passed in as
 * `permanentItems`.
 *
 * Desktop uses a Radix popover; mobile uses the shared BottomSheet so both
 * viewport shapes expose the same limits without desktop-sized chrome.
 */

/** One line in the "Permanent" (permanent context) section. */
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
	/** Mobile uses a BottomSheet instead of the desktop popover. */
	mobile?: boolean;
	/** Caller-owned test id for the mobile context-ring trigger. */
	triggerTestId?: string;
}

export interface ContextUsage {
	used: number;
	percent: number;
}

export function getContextUsage(permanent: number, history: number, inputTokens: number, availableBudget: number): ContextUsage {
	const used = permanent + history + inputTokens;
	return { used, percent: availableBudget > 0 ? Math.round(used / availableBudget * 100) : 0 };
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
	mobile = false,
	triggerTestId,
}: TokenCounterPopoverProps) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const usage = getContextUsage(permanent, history, inputTokens, availableBudget);

	const triggerText = <>{permanent.toLocaleString()}<span className="text-t4">+</span>{(history + inputTokens).toLocaleString()} / {contextSize > 0 ? contextSize.toLocaleString() : "∞"}</>;
	const content = <TokenCounterContent permanent={permanent} history={history} inputTokens={inputTokens} maxTokens={maxTokens} availableBudget={availableBudget} permanentItems={permanentItems} mobile={mobile} />;
	if (mobile) {
		return <>
			<button
				type="button"
				data-testid={triggerTestId}
				onClick={() => setOpen(true)}
				className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-t3 transition-colors active:bg-s3"
				aria-label={t("context_usage_percent", { n: usage.percent })}
			>
				<ContextRing percent={usage.percent} tokenState={tokenState} />
			</button>
			<BottomSheet
				open={open}
				onClose={() => setOpen(false)}
				title={<div className="flex w-full items-center justify-between gap-3"><span>{t("context_label")}</span><span className="shrink-0 font-normal tabular-nums text-t2">{usage.used.toLocaleString()} / {availableBudget.toLocaleString()} ({usage.percent}%)</span></div>}
			>
				{content}
			</BottomSheet>
		</>;
	}

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<span
					className={cn(
						"cursor-pointer whitespace-nowrap text-[calc(var(--ui-fs)-3px)] tabular-nums transition-colors duration-150 hover:text-t1",
						tokenState === "warn" ? "text-danger-text" : tokenState === "mid" ? "text-warning-text" : "text-t3",
					)}
				>
					{triggerText}
				</span>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="top"
					sideOffset={8}
					align={align}
					className="glass-blur z-[220] w-[240px] rounded-lg border border-border2 bg-glass-bg px-3.5 py-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
				>
					{content}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/**
 * The ONE state -> class mapping for the context fill. The ring takes
 * `stroke`, the mobile model sheet's «N% · used / available» figure takes
 * `text` — a state can never color the two differently.
 */
export const CONTEXT_STATE_CLASSES = {
	ok: { stroke: "stroke-accent", text: "text-accent-t" },
	mid: { stroke: "stroke-warning-text", text: "text-warning-text" },
	warn: { stroke: "stroke-danger-text", text: "text-danger-text" },
} as const satisfies Record<TokenCounterPopoverProps["tokenState"], { stroke: string; text: string }>;

export interface ContextRingProps {
	percent: number;
	/** Colors the fill arc via {@link CONTEXT_STATE_CLASSES}; defaults to `ok` (accent). */
	tokenState?: TokenCounterPopoverProps["tokenState"];
	/** Side of the square drawing in px; the viewBox matches it. Default 28. */
	size?: number;
	/** Circle radius in viewBox units. Default 11. */
	radius?: number;
	strokeWidth?: number;
	/** Track (unfilled ring) stroke class. Default `stroke-border`. */
	trackClassName?: string;
}

/**
 * The context-fill ring — one drawing for every host (the co-author mobile
 * counter, the RP model button's outline). Crisp by construction: the -90°
 * start rotation lives INSIDE the SVG (a CSS rotate class makes phones
 * rasterize the whole element as its own layer — the jagged ring), anti-aliasing
 * is requested explicitly, and an empty ring draws no arc at all (a round cap
 * on a zero-length dash would leave a dot).
 */
export function ContextRing({ percent, tokenState = "ok", size = 28, radius = 11, strokeWidth = 3, trackClassName = "stroke-border" }: ContextRingProps) {
	const center = size / 2;
	const circumference = 2 * Math.PI * radius;
	const fill = Math.min(100, Math.max(0, percent)) / 100;
	const rotation = `rotate(-90 ${center} ${center})`;

	return (
		<svg aria-hidden="true" data-token-state={tokenState} width={size} height={size} viewBox={`0 0 ${size} ${size}`} shapeRendering="geometricPrecision">
			<circle className={trackClassName} cx={center} cy={center} fill="none" r={radius} strokeWidth={strokeWidth} transform={rotation} />
			{fill > 0 && (
				<circle className={CONTEXT_STATE_CLASSES[tokenState].stroke} cx={center} cy={center} fill="none" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fill)} strokeLinecap="round" strokeWidth={strokeWidth} transform={rotation} />
			)}
		</svg>
	);
}

function TokenCounterContent({
	permanent,
	history,
	inputTokens,
	maxTokens,
	availableBudget,
	permanentItems,
	mobile,
}: Pick<TokenCounterPopoverProps, "permanent" | "history" | "inputTokens" | "maxTokens" | "availableBudget" | "permanentItems" | "mobile">) {
	const { t } = useT();
	const usageBar = availableBudget > 0 && <ContextUsageBar permanent={permanent} history={history} inputTokens={inputTokens} availableBudget={availableBudget} mobile={mobile} />;

	return <div className={mobile ? "px-4 py-3" : undefined}>
		{mobile ? <div className="mb-3">{usageBar}</div> : <div className="mb-1.5 border-b border-border pb-1.5 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("context_breakdown")}</div>}
		<ContextBreakdownRows history={history} inputTokens={inputTokens} maxTokens={maxTokens} availableBudget={availableBudget} permanentItems={permanentItems} />
		{!mobile && usageBar}
	</div>;
}

/**
 * The breakdown body — permanent rows, temporary rows, response budget, total
 * available. The ONE rendering of these rows: the desktop popover, the ring's
 * mobile sheet (TokenCounterContent) and the mobile model sheet all mount it,
 * so a row added here shows up on every surface.
 */
export function ContextBreakdownRows({
	history,
	inputTokens,
	maxTokens,
	availableBudget,
	permanentItems,
}: Pick<TokenCounterPopoverProps, "history" | "inputTokens" | "maxTokens" | "availableBudget" | "permanentItems">) {
	const { t } = useT();

	return <>
		<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_permanent")}</div>
		{permanentItems.map((item, i) => <div key={i} className={cn("mb-1 flex justify-between text-xs text-t2", i === permanentItems.length - 1 && "mb-1.5")}><span>{item.label}</span><span className="tabular-nums text-t1">{item.value.toLocaleString()}</span></div>)}
		<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-t4">{t("context_temporary")}</div>
		<div className="mb-1 flex justify-between text-xs text-t2"><span>{t("context_history")}</span><span className="tabular-nums text-t1">{history.toLocaleString()}</span></div>
		<div className="mb-1.5 flex justify-between text-xs text-t2"><span>{t("context_current_input")}</span><span className="tabular-nums text-t1">{inputTokens.toLocaleString()}</span></div>
		<div className="mb-1 flex justify-between border-t border-border pt-1.5 text-xs text-t2"><span>{t("context_response_budget")}</span><span className="tabular-nums text-t1">{maxTokens === -1 ? "∞" : `-${maxTokens.toLocaleString()}`}</span></div>
		<div className="mt-0.5 flex justify-between text-xs font-medium text-t1"><span>{t("context_total_available")}</span><span className="tabular-nums">{maxTokens === -1 ? "∞" : availableBudget.toLocaleString()}</span></div>
	</>;
}

export function ContextUsageBar({ permanent, history, inputTokens, availableBudget, mobile }: Pick<TokenCounterPopoverProps, "permanent" | "history" | "inputTokens" | "availableBudget" | "mobile">) {
	const { t } = useT();
	return <div className={mobile ? "h-1.5 w-full overflow-hidden rounded-full bg-s3" : "mt-2 h-1.5 w-full overflow-hidden rounded-full bg-s3"}><div className="flex h-full"><CustomTooltip content={`${t("context_permanent")}: ${permanent.toLocaleString()}`}><div className="bg-accent" style={{ width: `${Math.min(100, permanent / availableBudget * 100)}%` }} /></CustomTooltip><CustomTooltip content={`${t("context_history")}: ${history.toLocaleString()}`}><div className="bg-t3" style={{ width: `${Math.min(100, history / availableBudget * 100)}%` }} /></CustomTooltip><CustomTooltip content={`${t("context_current_input")}: ${inputTokens.toLocaleString()}`}><div className="bg-accent-t" style={{ width: `${Math.min(100, inputTokens / availableBudget * 100)}%` }} /></CustomTooltip></div></div>;
}
