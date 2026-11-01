import { useEffect, useRef, useState } from "react";
import { agentThreadKey, type AgentKind } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";

/**
 * AgentShell's mobile Chat/Edit tab state, moved out of `AgentShell.tsx`
 * unchanged (the file-size ratchet): the selected tab, the auto-switch to
 * Chat when a proposal lands, and the Edit tab's dirty-edge pulse. Desktop
 * renders both panes and ignores the tab.
 */
export type AgentShellMobileTab = "chat" | "edit";

/** E6: how long the Edit-tab pulse plays after the clean→dirty edge.
 *  Matches the CSS animation total (~2 × 1.1s), same as DOC_PULSE_MS in
 *  CoauthorMode. */
const EDIT_TAB_PULSE_MS = 2200;

export function useAgentShellMobileTab(kind: AgentKind, threadId: string | null, isMobile: boolean, editTabDirty: boolean) {
  const [activeTab, setActiveTab] = useState<AgentShellMobileTab>("chat");

  // ── Mobile auto-switch on proposal ───────────────────────────────────────
  // A proposal becomes reviewable in the Chat pane (activity cards + Apply),
  // so when one lands on mobile the surface jumps there. Ref-guarded edge
  // mirroring CoauthorMode's `useCoauthorMobileTab`.
  const hasProposal = useAgentTurnStore((s) => {
    if (!threadId) return false;
    const activities = s.turnsByThread[agentThreadKey(kind, threadId)] ?? [];
    return activities.some(
      (a) => a.status === "done" && a.target !== undefined && a.proposed !== undefined,
    );
  });
  const prevHasProposal = useRef(hasProposal);
  useEffect(() => {
    const was = prevHasProposal.current;
    prevHasProposal.current = hasProposal;
    if (!was && hasProposal && isMobile) {
      setActiveTab("chat");
    }
  }, [hasProposal, isMobile]);

  // ── E6: Edit-tab dirty badge + one-shot pulse ───────────────────────
  // Ref-guarded clean→dirty edge (proposal edge above, CA-14): the dot shows
  // while dirty and on Chat; the pulse plays once per edge. NO auto-switch —
  // a user-chosen Apply doesn't yank them off the chat tab.
  const [editTabPulse, setEditTabPulse] = useState(false);
  const prevEditTabDirty = useRef(editTabDirty);
  useEffect(() => {
    const was = prevEditTabDirty.current;
    prevEditTabDirty.current = editTabDirty;
    if (!was && editTabDirty) setEditTabPulse(true);
  }, [editTabDirty]);
  // Clear the highlight once the pulse animation has played
  // (coauthor-tab-pulse ≈ 2 × 1.1s, same as DOC_PULSE_MS in CoauthorMode).
  useEffect(() => {
    if (!editTabPulse) return;
    const id = setTimeout(() => setEditTabPulse(false), EDIT_TAB_PULSE_MS);
    return () => clearTimeout(id);
  }, [editTabPulse]);

  return { activeTab, setActiveTab, editTabPulse };
}
