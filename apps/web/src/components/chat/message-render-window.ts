export const MESSAGE_PAGE_SIZE = 20;
export const STABLE_TAIL_PAGES = 5;

export interface MessageRenderWindow {
  /** Older messages owned by the virtualizer. */
  virtualizedIds: string[];
  /** Recent messages that remain mounted below the virtualized history. */
  stableTailIds: string[];
  /** Global index of the first stable-tail message. */
  stableTailStartIndex: number;
}

/**
 * Splits a conversation at a page boundary so the recent visible surface stays
 * mounted while older history remains virtualized. Keeping several complete
 * pages means that starting a new page only retires the oldest, already distant
 * page; the latest four pages retain their React and DOM identity.
 */
export function partitionMessageRenderWindow(displayIds: string[]): MessageRenderWindow {
  const pageCount = Math.ceil(displayIds.length / MESSAGE_PAGE_SIZE);
  const firstStablePage = Math.max(0, pageCount - STABLE_TAIL_PAGES);
  const stableTailStartIndex = firstStablePage * MESSAGE_PAGE_SIZE;

  return {
    virtualizedIds: displayIds.slice(0, stableTailStartIndex),
    stableTailIds: displayIds.slice(stableTailStartIndex),
    stableTailStartIndex,
  };
}
