/**
 * Swipe-gesture hooks shared by the RP `Rail` and `CoauthorRail` (E5b,
 * post-SF-5 dedup). All three were byte-identical inline blocks in both rails
 * before extraction.
 *
 * - `useSheetDrag` — swipe-down-to-dismiss for a bottom sheet (tag-filter
 *   sheet). Returns a ref + three touch handlers; the sheet follows the
 *   finger via an inline transform, releasing past 80px calls `onDismiss`.
 * - `usePanelSwipe` — swipe-left-to-close on the expanded overlay panel.
 *   Tracks horizontal drag; a leftward delta < -40 calls `onClose`.
 * - `useRailEdgeSwipe` — edge swipe to expand/collapse the rail from the
 *   collapsed strip: rightward drag expands, leftward collapses.
 *
 * The action-sheet swipe-to-dismiss (`sheetDragRef` + `onSheetTouch*`) is NOT
 * here — it lives inline in the rail component and is consumed by the
 * `bottomSheet` closure (folded into `ActionSheet` in E5c).
 */
import { useCallback, useRef } from "react";
import type { TouchEvent } from "react";

export function useSheetDrag(onDismiss: () => void) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startY: 0, currentY: 0 });
  const onTouchStart = useCallback((e: TouchEvent) => {
    dragRef.current = { active: true, startY: e.touches[0].clientY, currentY: e.touches[0].clientY };
  }, []);
  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.currentY = e.touches[0].clientY;
    const delta = dragRef.current.currentY - dragRef.current.startY;
    if (delta > 0 && sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${delta}px)`;
      sheetRef.current.style.transition = 'none';
    }
  }, []);
  const onTouchEnd = useCallback(() => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const delta = dragRef.current.currentY - dragRef.current.startY;
    if (sheetRef.current) {
      sheetRef.current.style.transform = '';
      sheetRef.current.style.transition = '';
    }
    if (delta > 80) onDismiss();
  }, [onDismiss]);
  return { sheetRef, onTouchStart, onTouchMove, onTouchEnd };
}

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
