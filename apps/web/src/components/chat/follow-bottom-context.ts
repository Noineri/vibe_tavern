import { createContext, useContext } from "react";

/**
 * "Content inside a row just grew — apply the follow-the-bottom rule NOW."
 *
 * The scroller owns that rule (`use-stick-to-bottom.ts`), but its only growth
 * input, `totalListHeightChanged`, arrives one frame late: react-virtuoso
 * re-measures the row and re-renders first. Measured in Chrome during a stream,
 * that frame is visible — every line wrap left the viewport 28px (one line)
 * above the bottom for exactly one frame, so the wrapped line was painted where
 * the generation indicator had been. This context hands the streamed body a
 * direct line to the same rule, in the frame that grew the content.
 *
 * The default no-op covers rendering outside a scroller (tests, future embeds).
 */
export const FollowBottomContext = createContext<() => void>(() => {});

export function useFollowBottom(): () => void {
  return useContext(FollowBottomContext);
}
