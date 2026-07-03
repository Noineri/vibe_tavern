import { useMemo, useCallback } from "react";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useMessageOrder } from "../../stores/index.js";
import { MessageBlock } from "../chat/MessageBlock.js";
import { MessageScroller, useDisplayMessageIds } from "../chat/MessageScroller.js";

/**
 * Co-Author message surface — the structural fork point from RP.
 *
 * Reuses the same {@link MessageScroller} primitive as {@link MessageList} (RP),
 * so streaming-follow, bottom-pinning, and the floating scroll-to-bottom button
 * stay single-sourced. What is OWNED here is the Co-Author id derivation and the
 * per-item renderer, both of which diverge from RP across the upcoming CS tasks:
 *
 *  - CS-30 (author identity): swap `MessageBlock` for `CoauthorMessageBlock`,
 *    which renders "Вы / You" + a neutral glyph for the user and
 *    "Соавтор: <char name>" + the character avatar for the AI.
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
  const messageOrder = useMessageOrder();
  const displayMessageIds = useDisplayMessageIds();

  const firstAssistantMsgId = useMemo(() => {
    const state = useSnapshotStore.getState();
    for (const id of messageOrder) {
      if (state.messagesById[id]?.role === "assistant") return id;
    }
    return null;
  }, [messageOrder]);

  const renderItem = useCallback((index: number, messageId: string) => {
    const state = useSnapshotStore.getState();
    const isFirstAssistant = messageId === firstAssistantMsgId;
    const isLast = index === messageOrder.length - 1;
    const prevRole =
      index > 0 && messageOrder[index - 1]
        ? (state.messagesById[messageOrder[index - 1]]?.role ?? null)
        : null;
    return (
      <MessageBlock
        key={messageId}
        messageId={messageId}
        index={index}
        isFirstAssistant={isFirstAssistant}
        isLast={isLast}
        prevRole={prevRole}
      />
    );
  }, [firstAssistantMsgId, messageOrder]);

  return (
    <MessageScroller displayIds={displayMessageIds} renderItem={renderItem} />
  );
}
