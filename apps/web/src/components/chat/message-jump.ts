import type { VirtuosoHandle } from "react-virtuoso";
import type { StickToBottom } from "./use-stick-to-bottom.js";

export interface MessageJumpOptions {
  index: number;
  displayIds: readonly string[];
  stableTailStartIndex: number;
  /** Offset added to `index` when addressing the VIRTUALIZER (inverse-scroll
   *  feeds shift the index space via `firstItemIndex`). Default 0 — the RP
   *  feed's array positions are the virtualizer's indexes. */
  virtualIndexBase?: number;
  scroller: HTMLElement | null;
  virtualizer: Pick<VirtuosoHandle, "scrollIntoView"> | null;
  beginExplicitNavigation: StickToBottom["beginExplicitNavigation"];
  onLand?: (target: HTMLElement) => void;
}

/** DOM lookup stays list-scoped; scroll writes and pin ownership stay in the controller. */
export function jumpToMessage({ index, displayIds, stableTailStartIndex, virtualIndexBase = 0, scroller, virtualizer, beginExplicitNavigation, onLand }: MessageJumpOptions): void {
  if (!scroller || !Number.isInteger(index) || index < 0 || index >= displayIds.length) return;
  if (index < stableTailStartIndex && !virtualizer) return;
  const id = displayIds[index];
  const finish = beginExplicitNavigation();
  const virtualIndex = virtualIndexBase + index;
  const done = () => {
    const target = Array.from(scroller.querySelectorAll<HTMLElement>("[data-scroller-message-id]"))
      .find((node) => node.dataset.scrollerMessageId === id);
    if (finish(target) && target) onLand?.(target);
  };
  if (index >= stableTailStartIndex) done();
  else virtualizer?.scrollIntoView({
    index: virtualIndex, align: "start", behavior: "auto",
    calculateViewLocation: () => ({ index: virtualIndex, align: "start", behavior: "auto" }),
    done,
  });
}
