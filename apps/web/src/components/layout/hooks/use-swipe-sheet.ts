/**
 * Swipe-gesture hooks shared by the RP `Rail` and `CoauthorRail` (E5b,
 * post-SF-5 dedup). Both were byte-identical inline blocks in each rail
 * before extraction.
 *
 * - `usePanelSwipe` — swipe-left-to-close on the expanded overlay panel.
 *   Tracks horizontal drag; a leftward delta < -40 calls `onClose`.
 * - `useRailEdgeSwipe` — edge swipe to expand/collapse the rail from the
 *   collapsed strip: rightward drag expands, leftward collapses.
 *
 * Bottom-sheet swipe-to-dismiss is NOT here: it lived in `useSheetDrag` (and,
 * before that, inline in each rail sheet) but moved to the shared `BottomSheet`
 * primitive (vaul Drawer) in #36. The rails' sheets now inherit vaul's drag
 * physics and no longer need a local hook.
 */
import { useCallback, useRef } from "react";
import type { TouchEvent } from "react";

/** Swipe-left on the expanded overlay panel to close it. */
export function usePanelSwipe(onClose: () => void) {
  const panelDragRef = useRef({ active: false, startX: 0, currentX: 0 });
  const onTouchStart = useCallback((e: TouchEvent) => {
    panelDragRef.current = { active: true, startX: e.touches[0].clientX, currentX: e.touches[0].clientX };
  }, []);
  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!panelDragRef.current.active) return;
    panelDragRef.current.currentX = e.touches[0].clientX;
  }, []);
  const onTouchEnd = useCallback(() => {
    if (!panelDragRef.current.active) return;
    panelDragRef.current.active = false;
    const delta = panelDragRef.current.currentX - panelDragRef.current.startX;
    if (delta < -40) onClose();
  }, [onClose]);
  return { onTouchStart, onTouchMove, onTouchEnd };
}

/** Edge swipe to expand/collapse the rail. */
export function useRailEdgeSwipe(expanded: boolean, setExpanded: (v: boolean) => void) {
  const dragRef = useRef({ active: false, startX: 0, startExpanded: false, delta: 0 });
  const onTouchStart = useCallback((e: TouchEvent) => {
    dragRef.current = { active: true, startX: e.touches[0].clientX, startExpanded: expanded, delta: 0 };
  }, [expanded]);
  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.delta = e.touches[0].clientX - dragRef.current.startX;
  }, []);
  const onTouchEnd = useCallback(() => {
    if (!dragRef.current.active) return;
    const d = dragRef.current.delta;
    dragRef.current.active = false;
    if (!dragRef.current.startExpanded && d > 40) setExpanded(true);
    if (dragRef.current.startExpanded && d < -40) setExpanded(false);
  }, []);
  return { onTouchStart, onTouchMove, onTouchEnd };
}
