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
 * When allowShrink is true, shrinks first then grows (for value changes).
 * When false, only grows (while typing).
 * Preserves scroll position of the nearest scrollable ancestor.
 */
export function resizeTextarea(el: HTMLTextAreaElement, allowShrink: boolean, maxHeight?: number): void {
  const scrollParent = findScrollParent(el);
  const scrollTop = scrollParent?.scrollTop ?? 0;

  if (allowShrink) el.style.height = "auto";
  const min = parseFloat(getComputedStyle(el).minHeight) || 0;
  let next = Math.max(el.scrollHeight, min);
  if (maxHeight && next > maxHeight) {
    next = maxHeight;
    el.style.overflowY = "auto";
  } else {
    el.style.overflowY = "hidden";
  }
  if (allowShrink || next > el.getBoundingClientRect().height) {
    el.style.height = `${next}px`;
  }

  // Prevent scroll anchoring from jumping when textarea shrinks/grows
  if (scrollParent) scrollParent.scrollTop = scrollTop;
}
