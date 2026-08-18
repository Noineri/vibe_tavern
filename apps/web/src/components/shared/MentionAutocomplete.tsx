import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { MentionAutocompleteItem } from "./mention-autocomplete-query.js";
import { cn } from "../../lib/cn.js";

const POPUP_MAX_WIDTH = 380;
const EDGE_GAP = 8;
/** Gap between the anchor element edge and the popup edge. */
const ANCHOR_GAP = 4;
/** Hard cap on popup height (~8–10 rows); the list scrolls internally beyond this. */
const CONTENT_CAP = 240;

export interface MentionAutocompleteProps {
  /** Already ordered + filtered items to render (see filterMentionItems). */
  items: readonly MentionAutocompleteItem[];
  /** Index of the keyboard-active item (-1 = none). */
  activeIndex: number;
  /** Fired when the user picks an item (click or Enter). Receives the full
   *  item — the owning surface needs targetType+id to build the pin. */
  onSelect: (item: MentionAutocompleteItem) => void;
  /** Fired when the user hovers an item with the mouse. */
  onHover: (index: number) => void;
  /** Anchor text field; the popup positions itself against its rect. */
  anchorEl: HTMLElement | null;
  /** Current query (shown in the empty state). */
  query: string;
}

interface Placement {
  style: React.CSSProperties;
  /** Which side of the anchor the popup sits on — drives the enter animation. */
  side: "below" | "above";
}

/** i18n keys for the known target-type chips. Unknown types fall back to the
 *  raw string so non-copilot surfaces can reuse the primitive unlisted. */
const TYPE_LABEL_KEYS = {
  character: "copilot_mention_type_character",
  persona: "copilot_mention_type_persona",
  lorebook: "copilot_mention_type_lorebook",
  script: "copilot_mention_type_script",
  skill: "copilot_mention_type_skill",
} as const;

type KnownTargetType = keyof typeof TYPE_LABEL_KEYS;

/** Chip label for a target type: localized for the five copilot kinds, raw
 *  string otherwise. `t` is passed in (not imported) so this stays trivially
 *  testable through the component. */
function typeLabel(t: ReturnType<typeof useTranslation>["t"], targetType: string): string {
  if (targetType in TYPE_LABEL_KEYS) {
    return t(TYPE_LABEL_KEYS[targetType as KnownTargetType]);
  }
  return targetType;
}

/**
 * Floating `@`-mention picker anchored to its text field (CX-5,
 * COPILOT_CONTEXT_PICKER_PLAN). Purely presentational — the structural twin
 * of {@link MacroAutocomplete}: the owning field keeps DOM focus (so typing
 * continues) and drives the session (query, keyboard navigation, pick-insert)
 * itself; this popup only renders the rows and handles mouse interaction.
 * Picking an item does NOT insert text into the field — the owning surface
 * removes the `@query` and pins the target (per-thread link, PATCH
 * full-replace). The co-author chat adopts this primitive later.
 *
 * Positioned via a portal to `document.body` against the anchor's bounding
 * rect (below by default, flips above near the viewport bottom); the rect is
 * re-read on scroll/resize so the popup tracks the anchor. No
 * `@floating-ui` in the stack and Radix Popover anchors to a trigger element
 * rather than an inline caret — a manual fixed-position portal is the fit
 * (same reasoning as MacroAutocomplete; see its doc comment).
 */
export function MentionAutocomplete({
  items,
  activeIndex,
  onSelect,
  onHover,
  anchorEl,
  query,
}: MentionAutocompleteProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [placement, setPlacement] = useState<Placement>({
    style: { left: 0, top: 0, width: POPUP_MAX_WIDTH },
    side: "below",
  });

  // Compute placement from the anchor rect; recompute on scroll/resize so the
  // popup tracks the anchor across page scroll and viewport changes. Prefer
  // the side with more room. When ABOVE, anchor the popup's BOTTOM edge to
  // just above the anchor (CSS `bottom`) and let it grow upward — so a short
  // list sits flush against the input instead of floating high with a gap.
  // `maxHeight` is the available space on the chosen side so the list scrolls
  // internally rather than overflowing the viewport.
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
        key="mention-autocomplete"
        initial={{ opacity: 0, y: placement.side === "below" ? -4 : 4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        style={{ position: "fixed", zIndex: 650, ...placement.style }}
        className="glass-blur flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
        // Prevent mousedown inside the popup from stealing focus from the field.
        onMouseDown={(e) => e.preventDefault()}
        role="listbox"
        aria-label={t("copilot_mention_picker_label")}
      >
        {items.length === 0 ? (
          <div className="px-3 py-2.5 font-ui text-[12px] text-t3">
            {query ? t("copilot_mention_no_matches", { query }) : t("copilot_mention_empty")}
          </div>
        ) : (
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
            {items.map((item, index) => {
              const isActive = index === activeIndex;
              return (
                <div
                  key={`${item.targetType}:${item.id}`}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? "" : undefined}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onSelect(item)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5",
                    isActive ? "bg-s2" : "bg-transparent",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-ui text-[12px] text-t1">{item.label}</span>
                  {item.hint ? (
                    <span className="min-w-0 shrink-[2] truncate font-ui text-[11px] text-t3">{item.hint}</span>
                  ) : null}
                  <span className="shrink-0 rounded-sm bg-s2/60 px-1.5 py-0.5 font-ui text-[9px] uppercase tracking-[0.06em] text-t4">
                    {typeLabel(t, item.targetType)}
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
