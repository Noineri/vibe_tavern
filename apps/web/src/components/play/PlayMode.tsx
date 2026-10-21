import { InputArea } from "../chat/InputArea.js";
import { MessageList } from "../chat/MessageList.js";
import { QueueManager } from "../chat/QueueManager.js";
import { DicePanel } from "../chat/DicePanel.js";
import { NarrationPlaylistPanel } from "../chat/NarrationPlaylistPanel.js";
import { ImageGenFineTuningChip } from "../chat/ImageGenFineTuningChip.js";
import { ImageGenProgressRow } from "../chat/ImageGenProgressRow.js";
import { MessageAiEditorModal } from "../chat/MessageAiEditorModal.js";
import { ExperienceLauncher } from "../experience/ExperienceLauncher.js";
import { AgentShell } from "../shared/agent-shell/AgentShell.js";
import { AgentShellTabButton } from "../shared/agent-shell/AgentShellTabButton.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useSidechatMobileStore } from "../../stores/sidechat-mobile-store.js";
import { useAutoNarrate } from "../../hooks/use-auto-narrate.js";
import { useElementHeight } from "../../hooks/use-element-height.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useSidechatOpen } from "../../stores/sidechat-open-store.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import {
  selectSidechatServedChatModes,
  SIDECHAT_AGENT_KIND,
} from "../../api/agent-kind-served-modes.js";
// Module-load registration of the `sidechat-ooc` host (SC-13b) — the mobile
// pane below resolves its shell descriptor by kind at render time, exactly
// like SC-14's desktop panel does.
import { selectSidechatOwner } from "../chat/sidechat/sidechat-host.js";
import type { AgentThreadOwner } from "@vibe-tavern/domain";

export function PlayMode() {
  useAutoNarrate();
  const isMobile = useIsMobile();
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranch = useSnapshotStore((s) => s.activeBranch);
  const agentKindSettings = useBootstrapStore((s) => s.data?.agentKindSettings);
  const chatId = activeChat?.id ?? null;
  const chatMode = activeChat?.mode ?? "rp";
  // The served-modes gate is SC-13b's selector, shared with SC-14's panel: a
  // co-author chat (or a missing bootstrap map) sees no tabs, no handle.
  const served = selectSidechatServedChatModes(agentKindSettings).includes(chatMode);
  // The SAME open flag as the desktop panel (SC-18a's shared store): opening
  // on one surface opens the other. Never written under the wrong chat's key
  // (the store re-reads on chat switch — see sidechat-open-store.ts).
  const [sidechatOpen, setSidechatOpen] = useSidechatOpen(chatId);
  const owner = selectSidechatOwner(
    chatId === null ? null : { id: chatId },
    activeBranch === null ? null : { id: activeBranch.id },
  );
  // SC-15 owns ONLY the mobile branch. Desktop (and every unserved surface)
  // renders the chat pane exactly as before.
  if (isMobile && served && owner !== null) {
    return (
      <PlayModeMobileSidechat
        owner={owner}
        open={sidechatOpen}
        setOpen={setSidechatOpen}
      />
    );
  }
  return <PlayModeChatPane />;
}

/**
 * The RP chat surface on mobile with the sidechat open-capable (SIDECHAT_PLAN,
 * Wave 4 / SC-15) — the mobile twin of SC-14's desktop panel.
 *
 * - Closed: the chat pane alone; the compact top bar's sidechat button opens
 *   the sidechat AND switches the mobile tab to Sidechat (SC-16f removed the
 *   right-edge handle — it covered message text edge to edge).
 * - Open: a `[Chat][Sidechat]` tab row (built from `AgentShellTabButton`,
 *   like the co-author `[Chat][Doc]` row — `CoauthorMode.tsx:121-130`) sits
 *   directly under the top bar. Both panes stay MOUNTED across tab switches;
 *   only `hidden` toggles, so the chat's scroll position and the sidechat's
 *   session survive. The × on the «Sidechat» tab closes back to «Chat».
 * - The active tab lives in `useSidechatMobileStore` (shared UI state, not
 *   local state) so SC-16 can switch it from inside the sidechat.
 */
function PlayModeMobileSidechat({
  owner,
  open,
  setOpen,
}: {
  owner: AgentThreadOwner;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useT();
  const tab = useSidechatMobileStore((s) => s.tab);
  const setTab = useSidechatMobileStore((s) => s.setTab);
  const closeSidechat = () => {
    setOpen(false);
    setTab("chat");
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {open && (
        <div
          className="flex shrink-0 border-b border-border bg-surface"
          role="tablist"
          aria-label={t("sidechat_toggle_label")}
        >
          <AgentShellTabButton
            label={t("coauthor.tabs.chat")}
            active={tab === "chat"}
            onClick={() => setTab("chat")}
          />
          <AgentShellTabButton
            label={t("sidechat_toggle_label")}
            active={tab === "sidechat"}
            onClick={() => setTab("sidechat")}
            onClose={closeSidechat}
            closeLabel={t("sidechat_close_label")}
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Both panes stay mounted across tab switches (only `hidden`
            toggles) — the AgentShell mobile contract (`copilot-pane-chat` /
            `copilot-pane-edit`): the chat keeps its scroll and state. */}
        <div
          data-testid="sidechat-mobile-pane-chat"
          className={cn("flex min-w-0 flex-1 flex-col", open && tab !== "chat" && "hidden")}
        >
          <PlayModeChatPane />
        </div>
        {open && (
          <div
            data-testid="sidechat-mobile-pane-sidechat"
            className={cn("flex min-w-0 flex-1 flex-col", tab !== "sidechat" && "hidden")}
          >
            <AgentShell kind={SIDECHAT_AGENT_KIND} owner={owner} isMobile />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The RP chat pane — MessageList + the shared launcher bar + InputArea.
 * Verbatim the pre-SC-15 `PlayMode` body; shared by the desktop surface and
 * the mobile chat pane so the two never fork the composer stack.
 */
function PlayModeChatPane() {
  // Remount at the chat/branch boundary so message-local UI and Virtuoso's
  // old-history measurement cache cannot leak across conversations. The shared
  // scroll hook establishes the new scope's native bottom position.
  const activeScope = useSnapshotStore((s) => {
    const cid = s.activeChat?.id ?? null;
    const bid = s.activeBranch?.id ?? null;
    return cid && bid ? `${cid}|${bid}` : null;
  });
  // MUI step 14 (2026-09-11): the launcher bar floats absolutely over the
  // list's bottom edge; its measured height becomes scroll clearance below
  // the last message so the message controls can be scrolled clear of the
  // chips. Empty bar (all launchers null) measures 0 → no extra clearance.
  const [launcherBarRef, launcherBarHeight] = useElementHeight<HTMLDivElement>();
  // The launcher bar's chat id (the FT pill's gate reads it; DicePanel reads
  // its own chat context internally).
  const launcherChatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  return (
    <>
      <MessageList key={activeScope} bottomInset={launcherBarHeight} />
      <div className="relative shrink-0">
        <QueueManager />
        {/* Shared absolute launcher bar: Dice, the Experience launcher, and
         * the IG-17 fine-tuning pill are independent siblings. Any may return
         * null; the others remain correctly centered/usable. They coexist with
         * a gap and no overlap (IR-73B). All are `docked` so the bar owns the
         * centering — the FT pill joins the dice tray per the design's
         * "chip above the input joins them" line. */}
        <div ref={launcherBarRef} className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 flex -translate-x-1/2 items-center gap-2">
          <div className="pointer-events-auto">
            <DicePanel docked />
          </div>
          <div className="pointer-events-auto">
            <NarrationPlaylistPanel docked />
          </div>
          <div className="pointer-events-auto">
            <ExperienceLauncher docked />
          </div>
          {launcherChatId && (
            <div className="pointer-events-auto">
              <ImageGenFineTuningChip chatId={launcherChatId} />
            </div>
          )}
          {launcherChatId && (
            <div className="pointer-events-auto">
              <ImageGenProgressRow chatId={launcherChatId} />
            </div>
          )}
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
