/**
 * `keydown` listener hook — the single home for the "Escape closes the
 * overlay" / "arrow keys navigate" effect that was hand-rolled across the
 * viewer and overlay components.
 *
 * Extracted (Wave 1 of reports/frontend-reuse-and-extraction.md) from the
 * duplicated shape
 *   useEffect(() => {
 *     const onKey = (e) => { if (e.key === "Escape") onClose(); };
 *     window.addEventListener("keydown", onKey);
 *     return () => window.removeEventListener("keydown", onKey);
 *   }, [onClose]);
 * which lived in GalleryLightbox, GalleryGrid, GalleryViewer (×2), MediaModal,
 * LoreEntryEditor, and AvatarPanel (×2). Beyond dedup, every adopter now gets
 * correct listener cleanup by construction.
 *
 * Implementation note: the latest `key` and `handler` are kept in refs so the
 * listener attaches once per `{ enabled, target }` and always calls the freshest
 * callback. Callers may therefore pass an inline key array or an inline handler
 * (closing over changing values like `hasNav`) without memoizing and without
 * risking a stale closure — the handler invoked is always the current one.
 * (Equivalent to the inline pattern for stable handlers; strictly safer for
 * inline ones.)
 *
 * @example
 *   useKeyDown("Escape", onClose);                         // close on Escape
 *   useKeyDown(["ArrowRight", "ArrowLeft"], (e) => {       // multi-key + branch
 *     if (e.key === "ArrowRight") goNext(); else goPrev();
 *   });
 *   useKeyDown("Escape", onClose, { enabled: open });      // gated
 *   useKeyDown("Escape", onClose, { target: document });   // document-level
 */
import { useEffect, useRef } from "react";

export interface UseKeyDownOptions {
  /** When `false`, no listener is attached. Defaults to `true`. */
  enabled?: boolean;
  /** Event target. Defaults to `window`; pass `document` for document-level listeners. */
  target?: Window | Document;
}

/**
 * Attach a `keydown` listener for one key (string) or a set of keys (array).
 * The listener is removed on unmount or when `{ enabled, target }` change.
 * Pass the raw event to `handler` so it can branch on `event.key` (arrow nav).
 */
export function useKeyDown(
  key: string | readonly string[],
  handler: (event: KeyboardEvent) => void,
  { enabled = true, target = window }: UseKeyDownOptions = {},
): void {
  const keyRef = useRef(key);
  const handlerRef = useRef(handler);
  keyRef.current = key;
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: Event) => {
      // "keydown" always dispatches KeyboardEvent; the instanceof guard narrows
      // the type because the `Window | Document` union target collapses
      // addEventListener to the generic EventListener signature ((evt: Event)).
      if (!(event instanceof KeyboardEvent)) return;
      const k = keyRef.current;
      const hit = typeof k === "string" ? event.key === k : k.includes(event.key);
      if (hit) handlerRef.current(event);
    };
    target.addEventListener("keydown", onKey);
    return () => target.removeEventListener("keydown", onKey);
  }, [enabled, target]);
}
