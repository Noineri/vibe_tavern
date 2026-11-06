import { useRef, useState, useLayoutEffect, type ReactNode } from "react";
import { CustomTooltip } from "./Tooltip.js";
import { cn } from "../../lib/cn.js";

interface OverflowTooltipProps {
  /** Text to display. When it overflows the element's width, the full text is shown in a hover tooltip. */
  text: string;
  /** Classes applied to the rendered text element (color, font size, etc.). `truncate` is added automatically. */
  className?: string;
  /** Optional styled display content; the hint still shows only text. */
  children?: ReactNode;
  /** Where the tooltip opens relative to the text. Defaults to `right` (sidebar-friendly). */
  side?: "top" | "right" | "bottom" | "left";
  /** Use inside buttons, where a div is invalid phrasing content. */
  asSpan?: boolean;
}

/**
 * Renders `text` in a single-line, truncating div (or span inside a button) and shows a hover tooltip with
 * the full text — but ONLY when the text is actually clipped.
 *
 * Styled two-part content can be supplied as children while the hint contains only the truncated user data.
 *
 * Truncation is detected by comparing `scrollWidth` to `clientWidth`, re-checked
 * on element resize via `ResizeObserver`. This avoids showing a redundant tooltip
 * for short titles that already fit (e.g. SillyTavern imports like
 * "Branch #469 - 2025-11-12@05h15m13s" get a tooltip; "New Chat" does not).
 *
 * Requires the rendered element to have a bounded width (e.g. live in a
 * `min-w-0 flex-1` or block column) for the comparison to be meaningful.
 */
export function OverflowTooltip({ text, className, side = "right", asSpan = false, children }: OverflowTooltipProps) {
  const ref = useRef<HTMLElement>(null);
  const [truncated, setTruncated] = useState(false);

  // Re-run when `text` or styled children change (new content) OR when `truncated` flips (the
  // wrapper restructure below remounts the measured element, so we must re-observe
  // the new node). Measurements are idempotent, so this does not loop.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth - el.clientWidth > 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, children, truncated]);

  const node = asSpan ? (
    <span ref={(element) => { ref.current = element; }} className={cn("truncate", className)}>{children ?? text}</span>
  ) : (
    <div ref={(element) => { ref.current = element; }} className={cn("truncate", className)}>{children ?? text}</div>
  );

  if (!truncated) return node;
  return (
    <CustomTooltip content={text} side={side}>
      {node}
    </CustomTooltip>
  );
}
