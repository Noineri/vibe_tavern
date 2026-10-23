/**
 * The desktop sidechat panel (SIDECHAT_PLAN, Wave 4 / SC-14) — the FIRST unit
 * where the sidechat becomes VISIBLE to the user.
 *
 * Registered as the `rightPanel` slot of the rp play package (`rightPanel:
 * "Sidechat"` in chat-mode-registry); `useShellSurface` renders it DESKTOP-ONLY
 * as a sibling column to `<main>` in AppShell (same slot contract as the
 * co-author editor). The named import below executes `sidechat-host.tsx` as a
 * side effect — module-load registration of the `sidechat-ooc` host fires, so
 * the `AgentShell` mounted here resolves its descriptor.
 *
 * - Rendered ONLY where the served-modes selector allows (a co-author chat has
 *   no sidechat — nothing hard-codes the chat mode) and never on mobile (SC-15
 *   owns the mobile tabs) or while no chat+branch is active.
 * - Open state is per chat (`vt.sidechat.open.<chatId>`, default closed) and
 *   lives in the shared `sidechat-open-store.ts` (SC-18a) — the hook below
 *   re-reads on chat switch and never writes the previous chat's value
 *   under the new chat's key.
 * - Width is one global numeric preference (`vt.sidechat.width`, default 400,
 *   min 320, max 50% of the viewport) shared by all chats — owned by the
 *   shared `ResizableSidePane` primitive (persisted hook, live-max clamp,
 *   resize re-clamp without touching the stored intent).
 * - The closed tab is an overlay straddling nothing: it sits fully inside the
 *   chat column's right edge (the AppShell root clips anything past the edge),
 *   24 px wide and 44 px tall at vertical center — message text (centered,
 *   max-width) and the input (bottom, centered) stay clear; only a 44 px
 *   stretch of the scrollbar track is overlaid, the track stays usable above
 *   and below. Reserving layout space instead would shift the chat on every
 *   toggle.
 * - Sizing, drag and open/close motion live in the shared `ResizableSidePane`
 *   primitive (SC-16b): the left-edge drag line (the GalleryViewer
 *   viewport-pan pattern), the width glide on the rail flyouts' curve, the
 *   double-click reset — no copy of that code remains here.
 * - Panel content is the `AgentShell` chat-only form EXACTLY (the host has no
 *   editor pane, so the shell renders the mini-app assistant's chat pane with
 *   no restyle): session switcher, meter, profile gear, model picker,
 *   checklist, plan block, feed, input.
 */
import { AgentShell } from "../../shared/agent-shell/AgentShell.js";
import { ResizableSidePane } from "../../shared/resizable-side-pane.js";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useSidechatOpen } from "../../../stores/sidechat-open-store.js";
import { selectSidechatServedChatModes, SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
// Module-load registration of the `sidechat-ooc` host (SC-13b) — the shell
// below resolves its descriptor by kind at render time.
import { selectSidechatOwner, SIDECHAT_OPEN_KEY_PREFIX } from "./sidechat-host.js";
import { EDGE_PANE_GROUP, SidechatHandle } from "./SidechatHandle.js";

// Re-exported for any importer that reached the key through the panel — the
// single spelling lives in `sidechat-host.ts` (shared with the mobile tabs).
export { SIDECHAT_OPEN_KEY_PREFIX };

/** Storage key for the one global width preference (all chats share it). */
export const SIDECHAT_WIDTH_KEY = "vt.sidechat.width";

/** Default panel width (px) — plan-settled, not an agent-chosen number. */
export const SIDECHAT_DEFAULT_WIDTH = 400;

/** Minimum panel width (px) — plan-settled, enforced by the persisted hook. */
export const SIDECHAT_MIN_WIDTH = 320;

export function SidechatPanel() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranch = useSnapshotStore((s) => s.activeBranch);
  const agentKindSettings = useBootstrapStore((s) => s.data?.agentKindSettings);
  const chatId = activeChat?.id ?? null;
  const chatMode = activeChat?.mode ?? "rp";
  const served = selectSidechatServedChatModes(agentKindSettings).includes(chatMode);
  const [open, setOpen] = useSidechatOpen(chatId);

  const owner = selectSidechatOwner(
    chatId === null ? null : { id: chatId },
    activeBranch === null ? null : { id: activeBranch.id },
  );
  if (isMobile || owner === null || !served) return null;

  const label = t("sidechat_toggle_label");

  return (
    <ResizableSidePane
      open={open}
      storageKey={SIDECHAT_WIDTH_KEY}
      defaultWidth={SIDECHAT_DEFAULT_WIDTH}
      minWidth={SIDECHAT_MIN_WIDTH}
      resizeEdge="left"
      className={`${EDGE_PANE_GROUP} border-l border-border/50 bg-surface`}
      panelTestId="sidechat-panel"
      resizeHandleTestId="sidechat-resize"
      slideTestId="sidechat-slide"
      // The closed affordance lives in `SidechatHandle` (shared with SC-15's
      // mobile tabs) — same markup, same key, no fork; the pane renders it
      // once the close glide ends.
      closedView={<SidechatHandle variant="desktop" label={label} onOpen={() => setOpen(true)} />}
    >
      {/* Close handle on the panel's left edge (vertically centered); it sits
          above the drag line, so a press on the handle toggles instead. */}
      <SidechatHandle variant="panel-close" label={label} onToggle={() => setOpen(false)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <AgentShell kind={SIDECHAT_AGENT_KIND} owner={owner} isMobile={false} />
      </div>
    </ResizableSidePane>
  );
}
