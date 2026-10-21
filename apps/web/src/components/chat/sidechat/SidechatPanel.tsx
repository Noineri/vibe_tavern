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
 * - Open state is per chat (`vt.sidechat.open.<chatId>`, default closed); the
 *   hook re-reads on chat switch and never writes the previous chat's value
 *   under the new chat's key (see `use-persisted-boolean.ts`).
 * - Width is one global numeric preference (`vt.sidechat.width`, default 400,
 *   min 320, max 50% of the viewport) shared by all chats. The static min lives
 *   in the persisted hook (clamped on read); the relative max is enforced at
 *   render/drag time from `window.innerWidth` — the clamp source, read live so
 *   a window resize re-clamps without touching the stored intent.
 * - The closed tab is an overlay straddling nothing: it sits fully inside the
 *   chat column's right edge (the AppShell root clips anything past the edge),
 *   24 px wide and 44 px tall at vertical center — message text (centered,
 *   max-width) and the input (bottom, centered) stay clear; only a 44 px
 *   stretch of the scrollbar track is overlaid, the track stays usable above
 *   and below. Reserving layout space instead would shift the chat on every
 *   toggle.
 * - The drag strip reuses the GalleryViewer viewport-pan pattern (mousedown on
 *   the strip → window mousemove/mouseup with a start ref) — no pointer
 *   capture, no new pattern. The slide-in reuses the rail flyouts' curve
 *   (`flyoutIn 0.18s ease-out`, see SidebarFlyout/CoauthorSidebarFlyout) — no
 *   new curve.
 * - Panel content is the `AgentShell` chat-only form EXACTLY (the host has no
 *   editor pane, so the shell renders the mini-app assistant's chat pane with
 *   no restyle): session switcher, meter, profile gear, model picker,
 *   checklist, plan block, feed, input.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentShell } from "../../shared/agent-shell/AgentShell.js";
import { Icons } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { usePersistedBoolean, usePersistedNumber } from "../../../hooks/use-persisted-boolean.js";
import { selectSidechatServedChatModes, SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
// Module-load registration of the `sidechat-ooc` host (SC-13b) — the shell
// below resolves its descriptor by kind at render time.
import { selectSidechatOwner, SIDECHAT_OPEN_KEY_PREFIX } from "./sidechat-host.js";
import { SidechatHandle } from "./SidechatHandle.js";

// Re-exported for any importer that reached the key through the panel — the
// single spelling lives in `sidechat-host.ts` (shared with the mobile tabs).
export { SIDECHAT_OPEN_KEY_PREFIX };

/** Storage key for the one global width preference (all chats share it). */
export const SIDECHAT_WIDTH_KEY = "vt.sidechat.width";

/** Default panel width (px) — plan-settled, not an agent-chosen number. */
export const SIDECHAT_DEFAULT_WIDTH = 400;

/** Minimum panel width (px) — plan-settled, enforced by the persisted hook. */
export const SIDECHAT_MIN_WIDTH = 320;

/** Live viewport width for the relative max (subscribers re-render on resize). */
function readViewportWidth(): number {
  if (typeof window === "undefined") return 1024;
  return window.innerWidth || 1024;
}

/** The 50% max at clamp time, never below the static min. */
function maxWidthFor(viewportWidth: number): number {
  return Math.max(SIDECHAT_MIN_WIDTH, Math.floor(viewportWidth / 2));
}

export function SidechatPanel() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranch = useSnapshotStore((s) => s.activeBranch);
  const agentKindSettings = useBootstrapStore((s) => s.data?.agentKindSettings);
  const chatId = activeChat?.id ?? null;
  const chatMode = activeChat?.mode ?? "rp";
  const served = selectSidechatServedChatModes(agentKindSettings).includes(chatMode);
  const [open, setOpen] = usePersistedBoolean(`${SIDECHAT_OPEN_KEY_PREFIX}${chatId ?? ""}`, false);
  const [width, setWidth] = usePersistedNumber(SIDECHAT_WIDTH_KEY, SIDECHAT_DEFAULT_WIDTH, {
    min: SIDECHAT_MIN_WIDTH,
  });
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(readViewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const liveMax = maxWidthFor(viewportWidth);
  const effectiveWidth = Math.min(Math.max(width, SIDECHAT_MIN_WIDTH), liveMax);

  // Border drag (GalleryViewer viewport-pan pattern): mousedown records the
  // start, window-level move/up listeners carry the gesture so fast pointer
  // travel off the 6 px strip never drops it.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onDragMove = useCallback(
    (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const raw = drag.startWidth + (drag.startX - event.clientX);
      setWidth(Math.min(Math.max(raw, SIDECHAT_MIN_WIDTH), maxWidthFor(readViewportWidth())));
    },
    [setWidth],
  );
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
    return () => {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
    };
  }, [dragging, onDragMove, onDragEnd]);
  const onDragStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: effectiveWidth };
    setDragging(true);
  };

  const owner = selectSidechatOwner(
    chatId === null ? null : { id: chatId },
    activeBranch === null ? null : { id: activeBranch.id },
  );
  if (isMobile || owner === null || !served) return null;

  const label = t("sidechat_toggle_label");

  if (!open) {
    // The closed affordance lives in `SidechatHandle` (shared with SC-15's
    // mobile tabs) — same markup, same key, no fork.
    return <SidechatHandle variant="desktop" label={label} onOpen={() => setOpen(true)} />;
  }

  return (
    <aside
      className="relative flex shrink-0 animate-[flyoutIn_0.18s_ease-out] flex-col border-l border-border/50 bg-surface"
      style={{ width: effectiveWidth }}
      data-testid="sidechat-panel"
    >
      {/* Width drag strip on the left border (col-resize); the close handle
          below sits above it, so a press on the chevron toggles instead. */}
      <div
        data-testid="sidechat-resize"
        onMouseDown={onDragStart}
        className={`absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-col-resize select-none ${dragging ? "bg-accent" : "bg-transparent hover:bg-accent/60"}`}
      />
      {/* Close handle on the panel's left edge (vertically centered). */}
      <div className="absolute top-1/2 left-0 z-10 -translate-y-1/2">
        <CustomTooltip content={label} side="left">
          <button
            type="button"
            aria-label={label}
            data-testid="sidechat-toggle"
            onClick={() => setOpen(false)}
            className="flex h-11 w-6 cursor-pointer items-center justify-center rounded-r-md border border-l-0 border-border bg-surface text-t3 shadow-[4px_0_12px_rgba(0,0,0,.25)] transition-colors hover:bg-s2 hover:text-t1"
          >
            <Icons.Caret direction="r" />
          </button>
        </CustomTooltip>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgentShell kind={SIDECHAT_AGENT_KIND} owner={owner} isMobile={false} />
      </div>
    </aside>
  );
}
