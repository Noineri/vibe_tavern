import { InputArea } from "../chat/InputArea.js";
import { MessageList } from "../chat/MessageList.js";
import { QueueManager } from "../chat/QueueManager.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useT } from "../../i18n/context.js";

/**
 * Co-Author surface — the third AppShell surface (alongside PlayMode / BuildMode),
 * selected by `activeChat.mode === 'coauthor'` (see resolveShellSurface). It reuses
 * the RP chat shell (MessageList + InputArea) verbatim on the left; the right half
 * is the diff panel that shows the canonical document with a green/red overlay of
 * the turn's proposed edits (CA-10). Until CA-10 lands, the panel is a placeholder.
 *
 * The chat shell is NOT duplicated — CoauthorMode composes the same MessageList /
 * QueueManager / InputArea components PlayMode uses. Mode differences live in the
 * backend strategy (CoauthorModeStrategy.assemble) and in slot swaps (CA-9), not
 * in a bespoke layout. Mirrors the backend design where co-author is just a chat
 * with a different mode.
 *
 * Mobile (CA-14) will collapse the right panel into a `[Chat] [Doc]` tab bar; until
 * then the panel is desktop-only (`hidden lg:flex`) and mobile renders chat-only.
 */
export function CoauthorMode() {
  const { t } = useT();
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
      {/* Right: diff panel (CA-10 target). Placeholder until CA-10 lands. Desktop-only for V1. */}
      <aside className="hidden w-[420px] shrink-0 flex-col border-l border-border/50 bg-surface lg:flex">
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <p className="max-w-[280px] font-ui text-[0.9rem] leading-relaxed text-t2">
            {t("coauthor.diff.placeholder")}
          </p>
        </div>
      </aside>
    </div>
  );
}
