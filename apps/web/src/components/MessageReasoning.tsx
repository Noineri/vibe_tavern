import { useState } from "react";
import { Icons } from "./shared/icons.js";
import { useT } from "../i18n/context.js";

interface MessageReasoningProps {
  /** The reasoning text content (may be empty for redacted reasoning). */
  reasoning: string | null | undefined;
  /** Duration of the reasoning phase in milliseconds. */
  reasoningDurationMs?: number | null;
  /** If true, the model used reasoning but the content was redacted. */
  redacted?: boolean;
}

/**
 * Collapsible block that displays model reasoning (chain-of-thought)
 * above the main message content.
 *
 * Collapsed by default. Shows brain icon + "Reasoning" + duration badge.
 * For redacted reasoning: shows placeholder text instead of reasoning content.
 */
export function MessageReasoning({ reasoning, reasoningDurationMs, redacted }: MessageReasoningProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  const hasContent = reasoning && reasoning.trim().length > 0;
  const hasDuration = reasoningDurationMs != null && reasoningDurationMs > 0;
  const durationLabel = hasDuration ? `(${(reasoningDurationMs! / 1000).toFixed(1)}s)` : "";

  // No reasoning at all — don't render
  if (!hasContent && !redacted && !hasDuration) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-md border border-border bg-surface">
      <button
        className="flex w-full cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 font-ui text-[11px] font-medium uppercase tracking-[0.05em] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2"
        onClick={() => setOpen(!open)}
      >
        <Icons.brain />
        <span>{t("reasoning")}</span>
        {durationLabel && <span className="normal-case tracking-normal">{durationLabel}</span>}
        <span className="ml-auto">{open ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5 font-body text-[13px] italic leading-[1.6] text-t2">
          {hasContent ? reasoning : t("reasoning_redacted")}
        </div>
      )}
    </div>
  );
}
