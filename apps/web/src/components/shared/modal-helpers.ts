/**
 * Returns the nearest modal portal container element.
 * DropdownSelect calls this to portal its content inside the Dialog's focus scope,
 * so keyboard navigation (arrow keys) works inside modals.
 */
export function getModalPortal(): HTMLElement | null {
  return document.getElementById("modal-portal");
}
