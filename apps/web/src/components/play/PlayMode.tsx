import { InputArea } from "../chat/InputArea.js";
import { MessageList } from "../chat/MessageList.js";
import { QueueManager } from "../chat/QueueManager.js";
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
      <QueueManager />
      <InputArea />
    </>
  );
}
