import { InputArea } from "../chat/InputArea.js";
import { MessageList } from "../chat/MessageList.js";
import { QueueManager } from "../chat/QueueManager.js";
import { DicePanel } from "../chat/DicePanel.js";
import { MessageAiEditorModal } from "../chat/MessageAiEditorModal.js";
import { ExperienceLauncher } from "../experience/ExperienceLauncher.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useAutoNarrate } from "../../hooks/use-auto-narrate.js";

export function PlayMode() {
  useAutoNarrate();
  // Remount at the chat/branch boundary so message-local UI and Virtuoso's
  // old-history measurement cache cannot leak across conversations. The shared
  // scroll hook establishes the new scope's native bottom position.
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
        {/* Shared absolute launcher bar: Dice and the Experience launcher are
         * independent siblings. Either may return null; the other remains
         * correctly centered/usable. They coexist with a gap and no overlap
         * (IR-73B). Both are `docked` so the bar owns the centering. */}
        <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 flex -translate-x-1/2 items-center gap-2">
          <div className="pointer-events-auto">
            <DicePanel docked />
          </div>
          <div className="pointer-events-auto">
            <ExperienceLauncher docked />
          </div>
        </div>
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
