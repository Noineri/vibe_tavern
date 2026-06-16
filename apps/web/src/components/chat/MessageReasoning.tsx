import { useState } from "react";
import { registerMessageSlot, type MessageSlotContext } from "../../lib/message-slot-registry.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import { Markdown } from "../../lib/markdown.js";

export interface MessageReasoningSlotExtra {
  reasoning: string | null | undefined;
  reasoningDurationMs?: number | null;
  redacted?: boolean;
}

interface MessageReasoningProps {
  /** The reasoning text content (may be empty for redacted reasoning). */
  reasoning: string | null | undefined;
  /** Duration of the reasoning phase in milliseconds. */
  reasoningDurationMs?: number | null;
  /** If true, the model used reasoning but the content was redacted. */
  redacted?: boolean;
  /**
   * Expand the block on first render instead of defaulting to collapsed.
   * Used by the dev ThemeTuner to show reasoning styling without an extra click.
   */
  defaultOpen?: boolean;
}

/**
 * Collapsible block that displays model reasoning (chain-of-thought)
 * above the main message content.
 *
 * Collapsed by default. Shows brain icon + "Reasoning" + duration badge.
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
      />
    );
  },
});

export function MessageReasoning({ reasoning, reasoningDurationMs, redacted, defaultOpen = false }: MessageReasoningProps) {
  const { t } = useT();
  const [open, setOpen] = useState(defaultOpen);

  const hasContent = reasoning && reasoning.trim().length > 0;
  const hasDuration = reasoningDurationMs != null && reasoningDurationMs > 0;
  const durationLabel = hasDuration ? `(${(reasoningDurationMs! / 1000).toFixed(1)}s)` : "";

  // No reasoning at all — don't render
  if (!hasContent && !redacted && !hasDuration) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-md border border-border bg-surface">
      <button type="button"
        className="flex w-full cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 font-ui text-[11px] font-medium uppercase tracking-[0.05em] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
        onClick={() => setOpen(!open)}
      >
        <Icons.brain />
        <span>{t("reasoning")}</span>
        {durationLabel && <span className="normal-case tracking-normal">{durationLabel}</span>}
        <span className="ml-auto">{open ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}</span>
      </button>
      {open && (
        <div translate="yes" className="border-t border-border px-3 py-2.5 font-body text-[calc(var(--mfs)-2px)] leading-[1.6] text-msg-t2">
          {hasContent ? <Markdown text={reasoning} /> : t("reasoning_redacted")}
        </div>
      )}
    </div>
  );
}
