import { useEffect, useRef, useState } from "react";
import { InputArea } from "../chat/InputArea.js";
import { MessageList } from "../chat/MessageList.js";
import { QueueManager } from "../chat/QueueManager.js";
import { CoauthorCharacterForm } from "./CoauthorCharacterForm.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useIsSending } from "../../stores/chat-store.js";
import { useCoauthorTurnStore } from "../../stores/coauthor-turn-store.js";
import type { CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";

/**
 * Stable empty array for the turn-store selector fallback. Returning a fresh
 * `[]` here would create a new reference every render → Zustand's `Object.is`
 * check sees a change → infinite re-render loop ("Maximum update depth").
 * Same trap as CoauthorCharacterForm's EMPTY_ACTIVITIES.
 */
const EMPTY_ACTIVITIES: CoauthorToolActivity[] = [];

/** How long the [Doc] tab highlight pulses after an auto-switch (CA-14). Matches the CSS animation total (~2 × 1.1s). */
const DOC_PULSE_MS = 2200;

/**
 * CA-14 mobile tab state machine — extracted from the component so the contract
 * (auto-switch on the proposal edge, one-shot pulse, no re-trigger if the user
 * deliberately taps back to Chat) is unit-testable without mocking the viewport
 * (mocking `use-mobile` collides with VibeMdView.test process-globally; see
 * AGENTS.md `mock.module` gotcha). Inputs arrive as args, so a `renderHook`
 * test drives them directly.
 *
 * `hasProposal` is the same signal CoauthorCharacterForm derives from the turn
 * store (a turn ended with reviewable tool output). On the false→true EDGE on
 * mobile, the surface jumps to the Doc tab so the diff + Apply are immediately
 * visible, and pulses the tab once. The ref guards the edge so this never
 * fights a user who taps back to Chat mid-review (the proposal stays true, so
 * no new edge fires → no re-trigger). If a proposal is already pending on
 * mount, no auto-switch happens (no jarring jump on chat open); the Doc-tab
 * badge dot hints there's something to review.
 */
export function useCoauthorMobileTab(isMobile: boolean, hasProposal: boolean) {
  const [mobileTab, setMobileTab] = useState<"chat" | "doc">("chat");
  const [docPulse, setDocPulse] = useState(false);
  const prevProposal = useRef(hasProposal);

  useEffect(() => {
    const was = prevProposal.current;
    prevProposal.current = hasProposal;
    if (!was && hasProposal && isMobile) {
      setMobileTab("doc");
      setDocPulse(true);
    }
  }, [hasProposal, isMobile]);

  // Clear the highlight once the pulse animation has played.
  useEffect(() => {
    if (!docPulse) return;
    const id = setTimeout(() => setDocPulse(false), DOC_PULSE_MS);
    return () => clearTimeout(id);
  }, [docPulse]);

  return { mobileTab, setMobileTab, docPulse };
}

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
 * Mobile (CA-14): a `[Chat] [Doc]` tab bar collapses the two panels into one
 * viewport. Both panels stay MOUNTED across tab switches (only `hidden` toggles)
 * so the CodeMirror editor + Virtuoso scroll positions survive — switching to
 * the Doc tab to review a proposal, then back to Chat to reply, must not lose
 * state. When a proposal becomes reviewable the surface auto-switches to Doc
 * and pulses it (see {@link useCoauthorMobileTab}).
 */
export function CoauthorMode() {
  const { t } = useT();
  const isMobile = useIsMobile();

  // key={activeScope} forces MessageList to remount on chat/branch switch, so
  // Virtuoso's initialTopMostItemIndex re-runs and pins to bottom natively on mount.
  // Same rationale as PlayMode.
  const activeScope = useSnapshotStore((s) => {
    const cid = s.activeChat?.id ?? null;
    const bid = s.activeBranch?.id ?? null;
    return cid && bid ? `${cid}|${bid}` : null;
  });

  // The same proposal signal CoauthorCharacterForm derives from the turn store
  // (CA-9.2). Reading the single source of truth here lets the tab bar know a
  // turn just produced reviewable edits, without coupling the two components.
  const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const isSending = useIsSending();
  const activities = useCoauthorTurnStore(
    (s) => (chatId ? (s.turnsByChat[chatId] ?? EMPTY_ACTIVITIES) : EMPTY_ACTIVITIES),
  );
  const hasProposal =
    !isSending && activities.some((a) => a.status === "done" && !!a.proposed && !!a.target);

  const { mobileTab, setMobileTab, docPulse } = useCoauthorMobileTab(isMobile, hasProposal);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isMobile && (
        <div className="flex shrink-0 border-b border-border bg-surface" role="tablist" aria-label={t("coauthor.editor.label")}>
          <TabButton
            label={t("coauthor.tabs.chat")}
            active={mobileTab === "chat"}
            onClick={() => setMobileTab("chat")}
          />
          <TabButton
            label={t("coauthor.tabs.doc")}
            active={mobileTab === "doc"}
            onClick={() => setMobileTab("doc")}
            pulse={docPulse}
            // While a proposal is pending and the user is on Chat, a small dot
            // hints that the Doc tab has something to review.
            badge={hasProposal && mobileTab !== "doc"}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: the reused chat shell (MessageList + InputArea), structurally identical to PlayMode. */}
        <div className={cn("flex min-w-0 flex-1 flex-col", isMobile && mobileTab !== "chat" && "hidden")}>
          <MessageList key={activeScope} />
          <div className="relative shrink-0">
            <QueueManager />
            <InputArea />
          </div>
        </div>
        {/* Right: the live co-author MD editor (CA-10). Desktop keeps the split
            (`hidden lg:flex`); mobile shows it full-width under the Doc tab.
            Always mounted — only visibility toggles — so editor state survives
            tab switches (see component doc). */}
        <aside
          className={cn(
            "shrink-0 flex-col bg-surface",
            isMobile
              ? cn("w-full", mobileTab !== "doc" && "hidden")
              : "hidden w-[460px] border-l border-border/50 lg:flex",
          )}
        >
          <CoauthorCharacterForm />
        </aside>
      </div>
    </div>
  );
}

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  pulse?: boolean;
  badge?: boolean;
}

function TabButton({ label, active, onClick, pulse, badge }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1.5 py-2.5 font-ui text-[0.9rem] font-medium transition-colors",
        active ? "border-b-2 border-accent text-t1" : "border-b-2 border-transparent text-t3",
        pulse && "coauthor-tab-pulse",
      )}
    >
      {label}
      {badge && <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
    </button>
  );
}
