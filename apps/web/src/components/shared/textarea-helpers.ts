/**
 * Find the nearest scrollable ancestor of an element.
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return null;
}

/**
 * Resize a textarea to fit its content.
 * Always shrinks-to-fit first, then grows to scrollHeight — works both on render
 * and during typing/deleting.
 * Preserves scroll position of the nearest scrollable ancestor.
 */
export function resizeTextarea(el: HTMLTextAreaElement, maxHeight?: number): void {
  const scrollParent = findScrollParent(el);
  const scrollTop = scrollParent?.scrollTop ?? 0;

  el.style.height = "auto";
  const min = parseFloat(getComputedStyle(el).minHeight) || 0;
  let next = Math.max(el.scrollHeight, min);
  if (maxHeight && next > maxHeight) {
    next = maxHeight;
    el.style.overflowY = "auto";
  } else {
    el.style.overflowY = "hidden";
  }
  el.style.height = `${next}px`;

  // Prevent scroll anchoring from jumping when textarea shrinks/grows
  if (scrollParent) scrollParent.scrollTop = scrollTop;
}
