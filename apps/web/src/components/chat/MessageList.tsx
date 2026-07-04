import { useMemo, useCallback } from "react";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useMessageOrder } from "../../stores/index.js";
import { MessageBlock } from "./MessageBlock.js";
import { MessageScroller, useDisplayMessageIds } from "./MessageScroller.js";

/**
 * RP (Play Mode) message surface: virtualized, bottom-pinned chat thread.
 *
 * The fragile streaming-follow machinery (rAF pinning, wheel/touch listeners,
 * the floating scroll-to-bottom button) lives in the shared {@link MessageScroller}
 * primitive; this component owns the RP-specific parts only — the flat display-id
 * derivation (tool messages filtered out + pending placeholders) and the
 * per-item render (which needs RP-only derivations: isFirstAssistant for the
 * context-separator, prevRole for adjacent-message styling).
 *
 * Co-Author mode has its own `CoauthorMessageList` that reuses the same
 * scroller but can swap both the id derivation and the renderer independently
 * (CS-30 author identity, CS-31 turn grouping). Touching this file does NOT
 * affect Co-Author, and vice versa.
 */
export function MessageList() {
  const messageOrder = useMessageOrder();
  const displayMessageIds = useDisplayMessageIds();

  // Hoisted from MessageBlock (was an O(n²) useMemo over messageOrder inside
  // every mounted block). Computed once here, passed as a prop.
  const firstAssistantMsgId = useMemo(() => {
    const state = useSnapshotStore.getState();
    for (const id of messageOrder) {
      if (state.messagesById[id]?.role === "assistant") return id;
    }
    return null;
  }, [messageOrder]);

  const renderItem = useCallback((index: number, messageId: string) => {
    // Derivations hoisted from MessageBlock so individual blocks no longer
    // subscribe to the full messageOrder array. Pending ids (__pending-*)
    // short-circuit inside MessageBlock, so these values are unused for them.
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
