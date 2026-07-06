import { useCallback } from "react";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { CoauthorMessageBlock } from "./CoauthorMessageBlock.js";
import { MessageScroller } from "../chat/MessageScroller.js";
import { useCoauthorTurnIds } from "./useCoauthorTurnIds.js";
import { CoauthorTurnShell } from "./CoauthorTurnShell.js";

/**
 * Co-Author message surface — the structural fork point from RP.
 *
 * Reuses the same {@link MessageScroller} primitive as {@link MessageList} (RP),
 * so streaming-follow, bottom-pinning, and the floating scroll-to-bottom button
 * stay single-sourced. What is OWNED here is the Co-Author id derivation and the
 * per-item renderer, both of which diverge from RP across the upcoming CS tasks:
 *
 *  - CS-30 (author identity): swap `MessageBlock` for `CoauthorMessageBlock`,
 *    which renders "You" + a neutral glyph for the user and
 *    "Coauthor: <char name>" + the character avatar for the AI.
 *  - CS-26 (raw macros): keep `{{char}}` / `{{user}}` literal in co-author
 *    (they are editing instructions, not in-fiction prose) — handled in the
 *    co-author renderer, not here.
 *  - CS-31 (turn grouping): replace the flat `useDisplayMessageIds` derivation
 *    with a turn-grouped one (`assistant(toolCalls) → tool → assistant(final)`
 *    collapses into ONE turn container) and render `CoauthorTurnShell`.
 *  - CS-32 (message controls): drop Branch/Regenerate affordances.
 *
 * Today this mirrors `MessageList` exactly (flat ids + plain `MessageBlock`) so
 * the fork is structural-only with zero behaviour change — the CS tasks then
 * edit THIS file (and `CoauthorMessageBlock`) without re-entering the RP path.
 */
export function CoauthorMessageList() {
  const turnIds = useCoauthorTurnIds();

  const renderItem = useCallback((index: number, turnId: string) => {
    const isLast = index === turnIds.length - 1;

    if (turnId.startsWith("__pending-")) {
      return (
        <CoauthorMessageBlock
          key={turnId}
          messageId={turnId}
          index={index}
          isFirstAssistant={false}
          isLast={isLast}
          prevRole={null}
        />
      );
    }

    const state = useSnapshotStore.getState();
    const role = state.messagesById[turnId]?.role;
    
    if (role === "user") {
      return (
        <CoauthorMessageBlock
          key={turnId}
          messageId={turnId}
          index={index}
          isFirstAssistant={false}
          isLast={isLast}
          prevRole={null}
        />
      );
    }

    return (
      <CoauthorTurnShell
        key={turnId}
        turnId={turnId}
        index={index}
        isLastTurn={isLast}
      />
    );
  }, [turnIds]);

  return (
    <MessageScroller displayIds={turnIds} renderItem={renderItem} />
  );
}
