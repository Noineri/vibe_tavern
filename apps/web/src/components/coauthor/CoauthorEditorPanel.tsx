import { CoauthorCharacterForm } from "./CoauthorCharacterForm.js";
import { ResizableSidePane } from "../shared/resizable-side-pane.js";

// ────────────────────────────────────────────────────────────────────────────
// CoauthorEditorPanel — the shell-level RIGHT PANEL for the co-author chat mode
// (the hoisted live MD editor, CA-10). Registered as the `rightPanel` slot of
// the co-author package (`rightPanel: "CoauthorEditor"` in chat-mode-registry);
// `useShellSurface` renders it DESKTOP-ONLY as a sibling column to <main> in
// AppShell. The editor reads its own stores (snapshot + coauthor-turn) — it
// takes no shell-injected props, so the slot is a plain no-arg component.
//
// WHY THE MOBILE EDITOR IS NOT HERE: a side column is a desktop concept. Mobile
// has no room for one and instead swaps the editor in-flow under the Chat/Doc
// tab bar; that swap stays inside `CoauthorMode` (toggled by its local
// `useCoauthorMobileTab` state). The mobile shell is a separate future effort
// (see RIGHT_PANEL_SHELL_SLOT_REPORT — variant B). This keeps mobile behavior
// byte-identical to pre-hoist; the only structural change is that the DESKTOP
// editor is now shell-owned (reusable for the planned RP sidechat).
//
// SC-16c: the editor column resizes through the shared `ResizableSidePane`
// primitive — the drag line sits on the editor's LEFT edge (`resizeEdge:
// "left"`, the pane is RIGHT of the chat), default 460 (today's width), min
// 320, max half the window, double-click reset, its own stored width. NO
// collapse control by owner decision (the plan settles collapse for scripts
// and mini-apps only). The `hidden ... lg:flex` breakpoint stays on a plain
// wrapper div (never as an appended class on the primitive's `flex`-based
// aside — `cn` is join-only, so a `hidden` there would fight the baked base
// by stylesheet order instead of by intent).
// ────────────────────────────────────────────────────────────────────────────

/** Storage key for the co-author editor's own width preference. */
export const COAUTHOR_EDITOR_WIDTH_KEY = "vt.coauthor.editor.width";

/** Default editor width (px) — plan-settled, not an agent-chosen number. */
export const COAUTHOR_EDITOR_DEFAULT_WIDTH = 460;

/** Minimum editor width (px) — plan-settled, enforced by the persisted hook. */
export const COAUTHOR_EDITOR_MIN_WIDTH = 320;

/**
 * The desktop co-author editor column. The `hidden ... lg:flex` classes mirror
 * the pre-hoist `<aside>` exactly — below the `lg` breakpoint the column is
 * hidden (no editor on a narrow desktop window), matching prior behavior.
 */
export function CoauthorEditorPanel() {
  return (
    <div className="hidden shrink-0 lg:flex" data-testid="coauthor-editor">
      <ResizableSidePane
        open
        storageKey={COAUTHOR_EDITOR_WIDTH_KEY}
        defaultWidth={COAUTHOR_EDITOR_DEFAULT_WIDTH}
        minWidth={COAUTHOR_EDITOR_MIN_WIDTH}
        resizeEdge="left"
        className="border-l border-border/50 bg-surface"
        panelTestId="coauthor-editor-panel"
        resizeHandleTestId="coauthor-editor-resize"
      >
        {/* Squeezing content clips itself (the primitive never clips: the
            edge chrome's outset shadows must survive at full width). */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CoauthorCharacterForm />
        </div>
      </ResizableSidePane>
    </div>
  );
}
