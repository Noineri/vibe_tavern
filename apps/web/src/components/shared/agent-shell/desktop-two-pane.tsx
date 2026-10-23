import type { ReactNode } from "react";
import { useT } from "../../../i18n/context.js";
import { usePersistedBoolean } from "../../../hooks/use-persisted-boolean.js";
import type { AgentKind } from "../../../lib/agent-host-registry.js";
import { ResizableSidePane } from "../resizable-side-pane.js";
import { EDGE_PANE_GROUP, SidechatHandle } from "../../chat/sidechat/SidechatHandle.js";

/**
 * The desktop two-pane assistant layout (SIDECHAT_PLAN, SC-16c) — extracted
 * from `AgentShell` (which renders it for the desktop two-pane branch only;
 * the mobile tab branch and the chat-only branch stay in the shell).
 *
 * The chat pane is LEFT of the editor (both built-in hosts: scripts and
 * mini-apps), so the shared `ResizableSidePane` primitive runs with
 * `resizeEdge="right"` — the drag line sits on the pane's right edge.
 * Plan-settled numbers (never agent-chosen): default 440 (today's width),
 * min 320, max half the window (the primitive's live clamp), double-click
 * reset to the default.
 *
 * Memory is per surface, never per item: one width + one collapsed pair per
 * host kind (`vt.agent-assistant.width.<kind>` /
 * `vt.agent-assistant.collapsed.<kind>`), shared by every script or every
 * mini-app. The kind is only a key namespace here — this module never
 * resolves the host descriptor, so it stays renderable without registration.
 *
 * KEY DIFFERENCE vs the sidechat: the collapsed pane stays MOUNTED and
 * hidden (the primitive's `keepMounted`: a `hidden` zero-width aside after
 * the close glide) — a running assistant turn, the input draft and the
 * scroll position survive a collapse. The expand tab is NOT the primitive's
 * `closedView` (that slot sits where the pane was); it overlays the editor's
 * left edge from inside the editor container (absolute, never shifting the
 * editor), ≥ 44 px tall like every handle. Both handles are the shared
 * `SidechatHandle` SC-16c variants (`pane-collapse` line on the pane's
 * right edge, `editor-tab` capsule on the editor's left edge) — cloned through the
 * component, never copied.
 */

export interface AgentShellDesktopTwoPaneProps {
  /** The host kind driving the shell — the storage-key namespace. */
  kind: AgentKind;
  /** The shell's chat column (session, meter, feed, input). */
  chatPane: ReactNode;
  /** The host's editor column. */
  editorPane: ReactNode;
}

/** Plan-settled: today's assistant width, also the double-click reset target. */
export const AGENT_ASSISTANT_DEFAULT_WIDTH = 440;

/** Plan-settled floor (px) — enforced on read, write, drag and reset. */
export const AGENT_ASSISTANT_MIN_WIDTH = 320;

/** One width preference per host kind, shared by every item of that kind. */
export function agentAssistantWidthKey(kind: AgentKind): string {
  return `vt.agent-assistant.width.${kind}`;
}

/** One collapsed flag per host kind, shared by every item of that kind. */
export function agentAssistantCollapsedKey(kind: AgentKind): string {
  return `vt.agent-assistant.collapsed.${kind}`;
}

export function AgentShellDesktopTwoPane({ kind, chatPane, editorPane }: AgentShellDesktopTwoPaneProps) {
  const { t } = useT();
  const label = t("agent_assistant_toggle_label");
  // Default expanded (today's behaviour): the chat column shows until the
  // user collapses it; the flag re-reads on kind change, never cross-writes.
  const [collapsed, setCollapsed] = usePersistedBoolean(agentAssistantCollapsedKey(kind), false);

  return (
    <div className="flex min-h-0 flex-1">
      <ResizableSidePane
        open={!collapsed}
        keepMounted
        storageKey={agentAssistantWidthKey(kind)}
        defaultWidth={AGENT_ASSISTANT_DEFAULT_WIDTH}
        minWidth={AGENT_ASSISTANT_MIN_WIDTH}
        resizeEdge="right"
        className={`${EDGE_PANE_GROUP} border-r border-border`}
        panelTestId={`agent-assistant-panel-${kind}`}
        resizeHandleTestId={`agent-assistant-resize-${kind}`}
        slideTestId={`agent-assistant-slide-${kind}`}
      >
        {/* Collapse chevron on the pane's right edge — above the drag line
            (children paint after the primitive's strip at the same z), so a
            press on the chevron collapses instead of dragging. Unmounted the
            moment it is pressed (not left hidden in the collapsed pane): the
            collapsed steady state holds exactly one handle — the expand tab.
            The tab itself is immediate on the flag, not delayed to the end
            of the close glide, so expand is never dead for 0.25 s. */}
        {!collapsed && (
          <SidechatHandle
            key="agent-assistant-collapse"
            variant="pane-collapse"
            label={label}
            onToggle={() => setCollapsed(true)}
          />
        )}
        {/* Squeezing content clips itself (the primitive never clips: the
            edge chrome's outset shadows must survive at full width). The key
            keeps this node (and the draft/scroll state inside) mounted while
            siblings come and go: the chevron unmounts on collapse and the
            primitive's drag strip exists only in the open frame — without
            keys both removals shift child indexes and React would remount
            the content, losing the draft the collapse must preserve. */}
        <div key="agent-assistant-content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {chatPane}
        </div>
      </ResizableSidePane>
      {/* `relative` anchors the collapsed tab's overlay; the tab is absolute,
          so it never shifts the editor. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {editorPane}
        {collapsed && (
          <SidechatHandle variant="editor-tab" label={label} onToggle={() => setCollapsed(false)} />
        )}
      </div>
    </div>
  );
}
