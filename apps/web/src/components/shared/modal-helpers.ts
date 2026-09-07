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

/** The innermost currently-open overlay's portal node, or null. */
export function getTopmostOverlayPortal(): HTMLElement | null {
  return overlayPortalStack.length > 0
    ? overlayPortalStack[overlayPortalStack.length - 1]
    : null;
}

export function getModalPortal(): HTMLElement | null {
  return getTopmostOverlayPortal() ?? document.getElementById("modal-portal");
}
