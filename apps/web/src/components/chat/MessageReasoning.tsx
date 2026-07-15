import { useState } from "react";
import { registerMessageSlot, type MessageSlotContext } from "../../lib/message-slot-registry.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import { Markdown } from "../../lib/markdown.js";

/**
 * Visual preset for {@link MessageReasoning}. Controls the header chrome and
 * body typography so the two surfaces that render reasoning — the RP chat
 * ("rich") and the Co-Author chat ("minimal") — share ONE component while
 * keeping their distinct look. Add a third entry here if a new surface needs
 * its own preset; call sites only flip the `variant` prop.
 *
 * - `"rich"` — brain icon, UPPERCASE label, duration badge, caret, Markdown
 *   body in the reading font. Used by the RP message slot.
 * - `"minimal"` — plain label, no icon/duration/caret, monospace `<pre>` body.
 *   Used by the Co-Author chat (reasoning there is "what the model thought"
 *   while drafting edit instructions, so a code-like mono block fits better
 *   than prose styling).
 */
export type ReasoningVariant = "rich" | "minimal";

interface VariantStyle {
	/** Outer container (border + background + any margin). */
	container: string;
	/** Header button classes. */
	header: string;
	/** Show the brain icon. */
	showIcon: boolean;
	/** Show the duration badge (only meaningful when a duration is present). */
	showDuration: boolean;
	/** Show the expand/collapse caret on the trailing edge. */
	showCaret: boolean;
	/** Body wrapper classes. */
	body: string;
	/** How to render the body text. */
	bodyAs: "markdown" | "mono";
}

const VARIANT_STYLES: Record<ReasoningVariant, VariantStyle> = {
	rich: {
		container: "mb-2 overflow-hidden rounded-md border border-border bg-surface",
		header: "flex w-full cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 font-ui text-[11px] font-medium uppercase tracking-[0.05em] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2",
		showIcon: true,
		showDuration: true,
		showCaret: true,
		body: "border-t border-border px-3 py-2.5 font-body text-[calc(var(--mfs)-2px)] leading-[1.6] text-msg-t2",
		bodyAs: "markdown",
	},
	minimal: {
		container: "overflow-hidden rounded border border-border",
		header: "flex w-full cursor-pointer select-none items-center px-3 py-1.5 font-ui text-[11px] font-medium text-t3 transition-colors hover:text-t2",
		showIcon: false,
		showDuration: false,
		showCaret: false,
		body: "border-t border-border px-3 py-2 font-mono text-[11px] text-t3 whitespace-pre-wrap",
		bodyAs: "mono",
	},
};

export interface MessageReasoningSlotExtra {
	reasoning: string | null | undefined;
	reasoningDurationMs?: number | null;
	redacted?: boolean;
	/** Which visual preset to render. Defaults to `"rich"`. */
	variant?: ReasoningVariant;
}

interface MessageReasoningProps {
	/** The reasoning text content (may be empty for redacted reasoning). */
	reasoning: string | null | undefined;
	/** Duration of the reasoning phase in milliseconds. */
	reasoningDurationMs?: number | null;
	/** If true, the model used reasoning but the content was redacted. */
	redacted?: boolean;
	/**
	 * Visual preset — see {@link ReasoningVariant}. Defaults to `"rich"`.
	 */
	variant?: ReasoningVariant;
	/**
	 * Expand the block on first render instead of defaulting to collapsed.
	 * Used by the dev ThemeTuner to show reasoning styling without an extra click.
	 */
	defaultOpen?: boolean;
}

/**
 * Collapsible block that displays model reasoning (chain-of-thought)
 * above the main message content. Collapsed by default.
 *
 * Two visual presets via the `variant` prop — see {@link ReasoningVariant}.
 * For redacted reasoning: shows placeholder text instead of reasoning content.
 */
function getReasoningSlotExtra(ctx: MessageSlotContext): MessageReasoningSlotExtra | null {
	const value = ctx.extras.reasoning;
	if (!value || typeof value !== "object") return null;
	return value as MessageReasoningSlotExtra;
}

registerMessageSlot({
	id: "core-message-reasoning",
	slot: "after_reasoning",
	order: 0,
	roles: ["assistant"],
	visible: (ctx) => {
		const data = getReasoningSlotExtra(ctx);
		if (!data) return false;
		return Boolean(data.redacted || data.reasoning?.trim() || data.reasoningDurationMs);
	},
	render: (ctx) => {
		const data = getReasoningSlotExtra(ctx);
		if (!data) return null;
		return (
			<MessageReasoning
				reasoning={data.reasoning}
				reasoningDurationMs={data.reasoningDurationMs}
				redacted={data.redacted}
				variant={data.variant}
			/>
		);
	},
});

export function MessageReasoning({
	reasoning,
	reasoningDurationMs,
	redacted,
	variant = "rich",
	defaultOpen = false,
}: MessageReasoningProps) {
	const { t } = useT();
	const [open, setOpen] = useState(defaultOpen);
	const s = VARIANT_STYLES[variant];

	const hasContent = reasoning && reasoning.trim().length > 0;
	const hasDuration = reasoningDurationMs != null && reasoningDurationMs > 0;
	const durationLabel = hasDuration ? `(${(reasoningDurationMs! / 1000).toFixed(1)}s)` : "";

	// No reasoning at all — don't render
	if (!hasContent && !redacted && !hasDuration) return null;

	return (
		<div className={s.container}>
			<button type="button" className={s.header} onClick={() => setOpen(!open)}>
				{s.showIcon && <Icons.brain />}
				<span>{t("reasoning")}</span>
				{s.showDuration && durationLabel && (
					<span className="normal-case tracking-normal">{durationLabel}</span>
				)}
				{s.showCaret && (
					<span className="ml-auto">{open ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}</span>
				)}
			</button>
			{open && (
				s.bodyAs === "markdown" ? (
					<div translate="yes" className={s.body}>
						{hasContent ? <Markdown text={reasoning} /> : t("reasoning_redacted")}
					</div>
				) : (
					<pre translate="yes" className={s.body}>
						{hasContent ? reasoning : t("reasoning_redacted")}
					</pre>
				)
			)}
		</div>
	);
}
