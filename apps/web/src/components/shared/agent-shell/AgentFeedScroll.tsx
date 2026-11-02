import type { ReactNode, RefObject } from "react";
import { ScrollArea } from "../scroll-area.js";

/**
 * The agent feed's scroll container (extracted from `AgentMessageList.tsx`
 * under the file-size ratchet at CNR-8h — the list sat exactly at the
 * 800-line cap when its scroll surface moved onto the shared thin lane).
 *
 * CNR-8h: the feed rides the thin ScrollArea lane (3px rest / 5px hover)
 * instead of the native 8px fallback — ONE wrapper around the whole list,
 * so per-flush store writes reconcile rows inside the stable viewport
 * (streaming adds no remounts). The bottom-pinning scroller —
 * `useAgentListScroll`'s element, the stick-to-bottom math and the jump
 * affordance's anchor — repoints to the ScrollArea viewport through
 * viewportProps ref/onScroll (the PersonaModal idiom: same element role the
 * overflow-y-auto div played). Callers lay the rows out and pad them on
 * their own content div, so feed padding scrolls with the rows.
 */
export function AgentFeedScroll({
  scrollRef,
  onScroll,
  children,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  children: ReactNode;
}) {
  return (
    <ScrollArea
      scrollbarSize="thin"
      className="flex-1"
      viewportProps={{ ref: scrollRef, onScroll }}
    >
      {children}
    </ScrollArea>
  );
}
