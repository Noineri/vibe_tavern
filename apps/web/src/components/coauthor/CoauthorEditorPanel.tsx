import { CoauthorCharacterForm } from "./CoauthorCharacterForm.js";

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
// ────────────────────────────────────────────────────────────────────────────

/**
 * The desktop co-author editor column. The `hidden ... lg:flex` classes mirror
 * the pre-hoist `<aside>` exactly — below the `lg` breakpoint the column is
 * hidden (no editor on a narrow desktop window), matching prior behavior.
 */
export function CoauthorEditorPanel() {
  return (
    <aside className="hidden w-[460px] shrink-0 flex-col border-l border-border/50 bg-surface lg:flex">
      <CoauthorCharacterForm />
    </aside>
  );
}
