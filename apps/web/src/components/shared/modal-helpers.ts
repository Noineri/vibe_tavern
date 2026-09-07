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
export function getTopmostOverlayPortal(): HTMLElement | null {
  for (let i = overlayPortalStack.length - 1; i >= 0; i--) {
    const node = overlayPortalStack[i];
    if (node.isConnected) return node;
    overlayPortalStack.splice(i, 1);
  }
  return null;
}

export function getModalPortal(): HTMLElement | null {
  return getTopmostOverlayPortal() ?? document.getElementById("modal-portal");
}

/** The application-level modal host — stable per call, independent of the
 *  overlay stack. For overlays that must NEVER chase the topmost sheet
 *  anchor (the rail sidebar): re-targeting their portal mid-life to a sheet
 *  anchor tears them down exactly like SHEET_PORTAL_SELF_TARGETING. */
export function getApplicationModalPortal(): HTMLElement | null {
  return document.getElementById("modal-portal");
}
