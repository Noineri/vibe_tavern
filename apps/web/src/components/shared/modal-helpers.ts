/**
 * Returns the portal container for floating UI (DropdownSelect popups,
 * nested popovers) opened inside overlays.
 *
 * v1.2.1 mobile defect D2: `document.getElementById("modal-portal")` alone is
 * not enough — that node exists only inside the Radix Modal, so a dropdown
 * opened inside a BottomSheet portaled to document.body (z-400) and painted
 * UNDER the sheet (z-500/501), with cmdk's autofocus summoning the keyboard
 * for an invisible popup. Overlays that host nested floating UI register
 * their own portal node (see BottomSheet); the stack resolves the currently
 * topmost one. With no overlay open this falls back to the Modal's node.
 */
const overlayPortalStack: HTMLElement[] = [];

/**
 * Register an overlay's portal node; returns an unregister function.
 * Designed for React 19 callback refs (return value = ref cleanup).
 */
export function registerOverlayPortal(node: HTMLElement): () => void {
  overlayPortalStack.push(node);
  return () => {
    const index = overlayPortalStack.indexOf(node);
    if (index >= 0) overlayPortalStack.splice(index, 1);
  };
}

/** The innermost currently-open overlay's portal node, or null.
 *  Hardened after SHEET_PORTAL_SELF_TARGETING: a teardown path that skips
 *  the ref cleanup (exactly the bug this hardening follows) can leave
 *  disconnected nodes in the stack; walk from the top, pruning them, so a
 *  stale detached anchor can never become a portal target again. */
export function getTopmostOverlayPortal(exclude: HTMLElement | null = null): HTMLElement | null {
  for (let i = overlayPortalStack.length - 1; i >= 0; i--) {
    const node = overlayPortalStack[i];
    if (!node.isConnected) overlayPortalStack.splice(i, 1);
    else if (node !== exclude) return node;
  }
  return null;
}

export function getModalPortal(exclude: HTMLElement | null = null): HTMLElement | null {
  return getTopmostOverlayPortal(exclude) ?? document.getElementById("modal-portal");
}

/** The application-level modal host — stable per call, independent of the
 *  overlay stack. For overlays that must NEVER chase the topmost sheet
 *  anchor (the rail sidebar): re-targeting their portal mid-life to a sheet
 *  anchor tears them down exactly like SHEET_PORTAL_SELF_TARGETING. */
export function getApplicationModalPortal(): HTMLElement | null {
  return document.getElementById("modal-portal");
}

/**
 * Canonical glass-safe modal panel chrome (SS-6B single source, owner decision 16).
 * Every desktop `Modal` caller renders its own panel as
 * `cn(modalPanelCls, <caller sizes/extras>)` — no hand-written copies.
 *
 * `glass-blur-under`, NEVER `bg-surface`: `--surface` is translucent in glass
 * themes, which made `bg-surface` panels see-through (owner defect 2026-09-10);
 * the underlayer paints `--glass-bg` + frost on a z:-1 ::before, which is
 * opaque and visually identical to `bg-surface` in solid themes (styles.css
 * `.glass-blur-under` comment) and frosted in glass ones. Never combine this
 * constant with `bg-surface` — the two fills conflict.
 *
 * `overflow-hidden` clips the ::before pseudo to the rounded rect (the same
 * R-8 containing-block reason MasterDetailModal documents: the frost must
 * never live on the panel element itself).
 *
 * Caller-owned extras (NOT universal, so NOT in here): `flex`/`flex-col`,
 * sizes/widths, padding, and the mobile-fullscreen branch — dual-mode callers
 * keep the chrome desktop-only (chromeless `glass-blur-under` fullscreen on
 * mobile). The one sanctioned axis narrowing is `overflow-y-auto` on top of
 * the bundled `overflow-hidden` (scene-zone edit panel): Tailwind v4 emits
 * `.overflow-y-auto` after `.overflow-hidden` (verified against the repo's
 * own tailwindcss 4.3.3), so the y-axis scrolls while x stays clipped.
 */
export const modalPanelCls =
  "rounded-xl border border-border2 glass-blur-under shadow-[0_24px_60px_rgba(0,0,0,.5)] overflow-hidden";
