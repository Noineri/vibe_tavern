import { InputArea } from "../chat/InputArea.js";
import { MessageList } from "../chat/MessageList.js";
import { QueueManager } from "../chat/QueueManager.js";
import { CoauthorCharacterForm } from "./CoauthorCharacterForm.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";

/**
 * Co-Author surface — the third AppShell surface (alongside PlayMode / BuildMode),
 * selected by `activeChat.mode === 'coauthor'`. It reuses the RP chat shell
 * (MessageList + InputArea) verbatim on the left; the right half is the LIVE
 * co-author editor (CA-10): a writable MD character form the user and the AI
 * co-author in the same document. The editor is locked during the AI's turn.
 *
 * The chat shell is NOT duplicated — CoauthorMode composes the same MessageList /
 * QueueManager / InputArea components PlayMode uses. Mode differences live in the
 * backend strategy (CoauthorModeStrategy.assemble) and in slot swaps (CA-9), not
 * in a bespoke layout. Mirrors the backend design where co-author is just a chat
 * with a different mode.
 *
 * Mobile (CA-14) will collapse the right panel into a `[Chat] [Doc]` tab bar;
 * until then the editor panel is desktop-only (`hidden lg:flex`) and mobile
 * renders chat-only.
 */
export function CoauthorMode() {
  // key={activeScope} forces MessageList to remount on chat/branch switch, so
  // Virtuoso's initialTopMostItemIndex re-runs and pins to bottom natively on mount.
  // Same rationale as PlayMode.
  const activeScope = useSnapshotStore((s) => {
    const cid = s.activeChat?.id ?? null;
    const bid = s.activeBranch?.id ?? null;
    return cid && bid ? `${cid}|${bid}` : null;
  });

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left: the reused chat shell (MessageList + InputArea), structurally identical to PlayMode. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList key={activeScope} />
        <div className="relative shrink-0">
          <QueueManager />
          <InputArea />
        </div>
      </div>
      {/* Right: the live co-author MD editor (CA-10). Desktop-only for V1; mobile
          gets a [Chat][Doc] tab bar in CA-14. */}
      <aside className="hidden w-[460px] shrink-0 flex-col border-l border-border/50 bg-surface lg:flex">
        <CoauthorCharacterForm />
      </aside>
    </div>
  );
}
