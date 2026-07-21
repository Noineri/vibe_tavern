import { InputArea } from "../chat/InputArea.js";
import { MessageList } from "../chat/MessageList.js";
import { QueueManager } from "../chat/QueueManager.js";
import { MessageAiEditorModal } from "../chat/MessageAiEditorModal.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";

export function PlayMode() {
  // key={activeScope} forces MessageList to remount on chat/branch switch, so
  // Virtuoso's initialTopMostItemIndex re-runs and pins to bottom natively on mount.
  // This replaced the old prevScopeRef rAF-pin (spike 2026-06-20).
  const activeScope = useSnapshotStore((s) => {
    const cid = s.activeChat?.id ?? null;
    const bid = s.activeBranch?.id ?? null;
    return cid && bid ? `${cid}|${bid}` : null;
  });
  return (
    <>
      <MessageList key={activeScope} />
      <div className="relative shrink-0">
        <QueueManager />
        <InputArea />
      </div>
      {/* One message AI editor instance, mounted OUTSIDE the virtualized
       *  MessageList so an in-flight generation survives MessageBlock
       *  unmount on scroll/chat-switch and only one editor can exist.
       *  The modal's open state is driven by useMessageAiEditorStore. */}
      <MessageAiEditorModal />
    </>
  );
}
