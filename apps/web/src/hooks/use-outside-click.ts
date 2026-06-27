/**
 * Outside-click listener hook — the single home for the "close the popover when
 * the user clicks elsewhere" effect that was hand-rolled across the popover /
 * dropdown / flyout components.
 *
 * Extracted (Wave 1 of reports/frontend-reuse-and-extraction.md) from the
 * duplicated shape
 *   useEffect(() => {
 *     if (!open) return;
 *     const handler = (e) => {
 *       if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
 *     };
 *     document.addEventListener("mousedown", handler);
 *     return () => document.removeEventListener("mousedown", handler);
 *   }, [open]);
 * which lived in MediaMenu, TopBar, LinkBindingPopover, PersonaQuickSwitch,
 * GalleryGrid, LoreEntryEditor, and Rail (pointerdown). Beyond dedup, every
 * adopter now gets correct listener cleanup + null-safe targeting for free.
 *
 * Like `useKeyDown`, the latest `onOutside` is kept in a ref so the listener
 * attaches once per `{ enabled, event }` and always invokes the freshest
 * callback — callers may pass an inline handler without memoizing.
 *
 * Out of scope (intentionally NOT adopted — different structure, not the
 * duplicated single-ref shape):
 *  - `Sidebar` (5 independent refs) and `InputArea` (3 independent refs): each
 *    resets its OWN state per ref inside one shared listener. The hook would
 *    require N listeners instead of 1 — a regression. They stay hand-rolled.
 *  - `ProviderModal`: two dropdown refs + a `modal-portal` escape hatch.
 *  - `TweaksPanel`: a `setTimeout(0)` opener-click guard + a
 *    `closest('[data-dropdown-select-content]')` escape hatch.
 *
 * @example
 *   useOutsideClick(ref, () => setOpen(false));                       // always-on
 *   useOutsideClick(ref, () => setOpen(false), { enabled: open });    // gated
 *   useOutsideClick(ref, closeMenu, { event: "pointerdown" });        // pointerdown
 */
import { useEffect, useRef } from "react";
import type React from "react";

export interface UseOutsideClickOptions {
  /** When `false`, no listener is attached. Defaults to `true`. */
  enabled?: boolean;
  /** Document event to listen for. Defaults to `"mousedown"`; use `"pointerdown"` for Rail-style menus. */
  event?: "mousedown" | "pointerdown";
}

/**
 * Call `onOutside` when a `mousedown` (or `pointerdown`) lands outside `ref`'s
 * element. The listener lives on `document` and is removed on unmount.
 */
export function useOutsideClick<T extends Element = Element>(
  ref: React.RefObject<T | null>,
  onOutside: () => void,
  { enabled = true, event = "mousedown" }: UseOutsideClickOptions = {},
): void {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: Event) => {
      const node = ref.current;
      const target = e.target;
      // `target instanceof Node` is a cast-free null/shape guard (EventTarget →
      // Node); equivalent to the `e.target as Node` cast every original site used,
      // but type-safe rather than asserted.
      if (node && target instanceof Node && !node.contains(target)) onOutsideRef.current();
    };
    document.addEventListener(event, handler);
    return () => document.removeEventListener(event, handler);
  }, [enabled, event, ref]);
}
