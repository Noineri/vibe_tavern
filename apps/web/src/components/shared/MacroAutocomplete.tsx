import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { MacroCatalogEntry } from "@vibe-tavern/prompt-pipeline";
import { macroCategoryLabel } from "./macro-autocomplete-store.js";
import { cn } from "../../lib/cn.js";

/** Estimated popup height used for the below/above flip decision. */
const POPUP_MAX_HEIGHT = 240;
const POPUP_MAX_WIDTH = 380;
const EDGE_GAP = 8;

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

interface Position {
  left: number;
  top: number;
  width: number;
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
  const [position, setPosition] = useState<Position>({ left: 0, top: 0, width: POPUP_MAX_WIDTH });

  // Compute placement from the anchor rect; recompute on scroll/resize so the
  // popup tracks the textarea across page scroll and viewport changes.
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const place = () => {
      const rect = anchorEl.getBoundingClientRect();
      const width = Math.min(rect.width, POPUP_MAX_WIDTH);
      const left = Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - width - EDGE_GAP));
      const spaceBelow = window.innerHeight - rect.bottom;
      const placeBelow = spaceBelow >= POPUP_MAX_HEIGHT + EDGE_GAP || spaceBelow >= rect.top;
      const top = placeBelow
        ? rect.bottom + 4
        : Math.max(EDGE_GAP, rect.top - POPUP_MAX_HEIGHT - 4);
      setPosition({ left, top, width });
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
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        style={{ position: "fixed", left: position.left, top: position.top, width: position.width, zIndex: 650 }}
        className="glass-blur overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
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
          <div ref={listRef} className="max-h-[240px] overflow-y-auto p-1">
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
