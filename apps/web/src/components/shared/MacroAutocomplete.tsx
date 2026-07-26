import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { MacroCatalogEntry } from "@vibe-tavern/prompt-pipeline";
import { macroCategoryLabel } from "./macro-autocomplete-store.js";
import { cn } from "../../lib/cn.js";

const POPUP_MAX_WIDTH = 380;
const EDGE_GAP = 8;
/** Gap between the textarea edge and the popup edge. */
const ANCHOR_GAP = 4;
/** Hard cap on popup height (~8–10 rows); the list scrolls internally beyond this. */
const CONTENT_CAP = 240;

export interface MacroAutocompleteProps {
  /** Already ordered + filtered entries to render. */
  items: readonly MacroCatalogEntry[];
  /** Index of the keyboard-active item (-1 = none). */
  activeIndex: number;
  /** Fired when the user picks an entry (click or Enter). */
  onSelect: (name: string) => void;
  /** Fired when the user hovers an item with the mouse. */
  onHover: (index: number) => void;
  /** Anchor textarea; the popup positions itself against its rect. */
  anchorEl: HTMLElement | null;
  /** Current query (shown in the empty state). */
  query: string;
}

interface Placement {
  style: React.CSSProperties;
  /** Which side of the textarea the popup sits on — drives the enter animation. */
  side: "below" | "above";
}

/**
 * Floating macro-picker anchored to its textarea. Purely presentational: the
 * owning textarea keeps DOM focus (so typing continues), and this popup drives
 * selection through `onSelect`/`onHover`. Keyboard navigation (arrows / Enter /
 * Escape) is handled by the textarea's `onKeyDown`; this component only renders
 * the active highlight + handles mouse interaction.
 *
 * Positioned via a portal to `document.body` against the textarea's bounding rect (below by
 * default, flips above near the viewport bottom). No `@floating-ui` in the stack
 * (only Radix Popover + cmdk), and Radix Popover anchors to a trigger element
 * rather than an inline caret, so a manual fixed-position portal is the fit.
 * The rect is re-read on scroll/resize so the popup tracks the textarea.
 */
export function MacroAutocomplete({
  items,
  activeIndex,
  onSelect,
  onHover,
  anchorEl,
  query,
}: MacroAutocompleteProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [placement, setPlacement] = useState<Placement>({
    style: { left: 0, top: 0, width: POPUP_MAX_WIDTH },
    side: "below",
  });

  // Compute placement from the anchor rect; recompute on scroll/resize so the
  // popup tracks the textarea across page scroll and viewport changes.
  // Prefer the side with more room. When ABOVE, anchor the popup's BOTTOM edge
  // to just above the textarea (CSS `bottom`) and let it grow upward — so a
  // short list sits flush against the input instead of floating high with a
  // gap. When BELOW, anchor the top edge (`top`) and grow down. `maxHeight` is
  // the available space on the chosen side so the list scrolls internally
  // rather than overflowing the viewport.
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const place = () => {
      const rect = anchorEl.getBoundingClientRect();
      const width = Math.min(rect.width, POPUP_MAX_WIDTH);
      const left = Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - width - EDGE_GAP));
      const spaceBelow = window.innerHeight - rect.bottom - ANCHOR_GAP - EDGE_GAP;
      const spaceAbove = rect.top - ANCHOR_GAP - EDGE_GAP;
      const placeBelow = spaceBelow >= spaceAbove;
      const style: React.CSSProperties = placeBelow
        ? { left, width, top: rect.bottom + ANCHOR_GAP, maxHeight: Math.min(CONTENT_CAP, Math.max(0, spaceBelow)) }
        : { left, width, bottom: window.innerHeight - rect.top + ANCHOR_GAP, maxHeight: Math.min(CONTENT_CAP, Math.max(0, spaceAbove)) };
      setPlacement({ style, side: placeBelow ? "below" : "above" });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorEl]);

  // Keep the active item scrolled into view during keyboard navigation.
  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <AnimatePresence>
      <motion.div
        key="macro-autocomplete"
        initial={{ opacity: 0, y: placement.side === "below" ? -4 : 4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        style={{ position: "fixed", zIndex: 650, ...placement.style }}
        className="glass-blur flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
        // Prevent mousedown inside the popup from stealing focus from the textarea.
        onMouseDown={(e) => e.preventDefault()}
        role="listbox"
        aria-label="Macro picker"
      >
        {items.length === 0 ? (
          <div className="px-3 py-2.5 font-ui text-[12px] text-t3">
            {query ? <>No macro matches “{query}”.</> : "No macros available."}
          </div>
        ) : (
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
            {items.map((entry, index) => {
              const isActive = index === activeIndex;
              return (
                <div
                  key={entry.name}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? "" : undefined}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onSelect(entry.name)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5",
                    isActive ? "bg-s2" : "bg-transparent",
                  )}
                >
                  <code className="shrink-0 font-mono text-[12px] text-accent-t">{`{{${entry.name}}}`}</code>
                  <span className="min-w-0 flex-1 truncate font-ui text-[11px] text-t3">{entry.description}</span>
                  <span className="shrink-0 rounded-sm bg-s2/60 px-1.5 py-0.5 font-ui text-[9px] uppercase tracking-[0.06em] text-t4">
                    {macroCategoryLabel(entry.category)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
