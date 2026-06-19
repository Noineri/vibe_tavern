import { useRef, useState, useLayoutEffect } from "react";
import { CustomTooltip } from "./Tooltip.js";
import { cn } from "../../lib/cn.js";

interface OverflowTooltipProps {
  /** Text to display. When it overflows the element's width, the full text is shown in a hover tooltip. */
  text: string;
  /** Classes applied to the rendered text element (color, font size, etc.). `truncate` is added automatically. */
  className?: string;
  /** Where the tooltip opens relative to the text. Defaults to `right` (sidebar-friendly). */
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Renders `text` in a single-line, truncating div and shows a hover tooltip with
 * the full text — but ONLY when the text is actually clipped.
 *
 * Truncation is detected by comparing `scrollWidth` to `clientWidth`, re-checked
 * on element resize via `ResizeObserver`. This avoids showing a redundant tooltip
 * for short titles that already fit (e.g. SillyTavern imports like
 * "Branch #469 - 2025-11-12@05h15m13s" get a tooltip; "New Chat" does not).
 *
 * Requires the rendered element to have a bounded width (e.g. live in a
 * `min-w-0 flex-1` or block column) for the comparison to be meaningful.
 */
export function OverflowTooltip({ text, className, side = "right" }: OverflowTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);

  // Re-run when `text` changes (new content) OR when `truncated` flips (the
  // wrapper restructure below remounts the measured div, so we must re-observe
  // the new node). Measurements are idempotent, so this does not loop.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth - el.clientWidth > 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, truncated]);

  const node = (
    <div ref={ref} className={cn("truncate", className)}>
      {text}
    </div>
  );

  if (!truncated) return node;
  return (
    <CustomTooltip content={text} side={side}>
      {node}
    </CustomTooltip>
  );
}
