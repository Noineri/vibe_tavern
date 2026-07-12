import { useCallback, useEffect, useRef } from "react";

/**
 * PR-11: auto-scroll to reveal a newly created persona.
 *
 * WHY NOT scrollIntoView / rAF: the new card mounts collapsed, then
 * transitions to the expanded edit form (setEditingId fires in the same
 * click). The edit form's AutoTextarea auto-resizes via useLayoutEffect, so
 * the card's height is NOT final when the ref callback (or its rAF) runs.
 * A one-shot scrollIntoView caches its target pixel against the stale
 * (short) height and under-scrolls — the user sees the new card cut off
 * near the footer when starting from scrollTop 0.
 *
 * FIX: ResizeObserver on the new card. Since the new persona is always the
 * LAST list item (backend listAll has no ORDER BY → rowid/insertion order),
 * "reveal it" == "pin the scroll container to its bottom". The observer
 * re-pins on every height change DURING THE REVEAL PHASE (collapsed→expanded,
 * initial textarea auto-resize, avatar load) so the destination is always
 * computed against the CURRENT card height.
 *
 * DIRTY-GATE (PR-11 rev 2): the observer must STOP re-pinning once the user
 * is actively editing — otherwise every keystroke that grows the textarea
 * yanks the scroll back to the bottom. The reveal phase completes before the
 * user types (baseline is captured at create time against the empty form, so
 * isDirty is false through expand + auto-resize), so gating on !isDirty lets
 * all the reveal-phase resizes pin the bottom while making typing-induced
 * resizes a no-op. Reads isDirty through a ref to avoid re-creating the
 * observer (which would detach/reattach the ref callback) on every edit.
 *
 * NOT the MessageList rAF bottom-pinning pattern — that is a different
 * concern (live message append during streaming); this is a static list.
 *
 * Extracted from PersonaModal (PERSONA_MODAL_GOD_OBJECT_AUDIT.md, Finding 3).
 * Owns the scroll container ref (only this logic uses it) and returns a
 * `cardRef(id, el)` callback for the list to attach to each card. The host
 * passes the live `isDirty` each render; it is mirrored into a ref here so the
 * async ResizeObserver callback reads the latest value without re-creating the
 * observer.
 */
export function useRevealOnCreate(createdId: string | null, isDirty: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const createdCardObserver = useRef<ResizeObserver | null>(null);
  // Mirror of `isDirty` read inside the ResizeObserver callback. Assigned
  // during render so it's always current when the observer fires; the ref is
  // stable so cardRef's deps don't churn.
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;

  const cardRef = useCallback((personaId: string, el: HTMLDivElement | null) => {
    if (el) {
      cardRefs.current.set(personaId, el);
      if (personaId === createdId) {
        // Start observing this card's size; each change pins the list to its
        // bottom, which always reveals the last item (the new persona).
        createdCardObserver.current?.disconnect();
        const body = containerRef.current;
        const ro = new ResizeObserver(() => {
          if (!body) return;
          // DIRTY-GATE: stop re-pinning once the user is actively editing so
          // typing doesn't yank the scroll. See the PR-11 rev 2 note above.
          if (isDirtyRef.current) return;
          body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
        });
        ro.observe(el);
        createdCardObserver.current = ro;
      }
    } else {
      cardRefs.current.delete(personaId);
      if (personaId === createdId) {
        createdCardObserver.current?.disconnect();
        createdCardObserver.current = null;
      }
    }
  }, [createdId]);

  // Disconnect the observer when the created-draft id changes (new creation,
  // discard, or save) or the host unmounts.
  useEffect(() => {
    return () => {
      createdCardObserver.current?.disconnect();
      createdCardObserver.current = null;
    };
  }, [createdId]);

  return { containerRef, cardRef };
}
