import { useEffect, useRef, useState } from "react";

/** Observe an element's rendered height (0 while unmounted).
 *
 * MUI step 14 (2026-09-11): the chat add-on launcher bar (dice/playlist/
 * experience chips) floats absolutely ABOVE the input dock, overlaying the
 * bottom of the message list. Its measured height feeds the scroller's bottom
 * clearance (scrollable room below the last message) so the last message's
 * controls can be scrolled clear of the bar. A ResizeObserver — not a one-shot
 * measure — because the chips appear/disappear dynamically (dice enabled,
 * playlist populated) and the clearance must track the bar's real height.
 *
 * Without a ResizeObserver in the environment (SSR / stripped test DOM) the
 * hook degrades to the one-shot initial measure. */
export function useElementHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, height];
}
