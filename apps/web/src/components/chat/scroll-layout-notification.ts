// Native scroll listeners in ScrollArea still remeasure, but the controller
// must not mistake chrome measurement for a frame of a user's gesture.
const layoutNotifications = new WeakSet<Event>();

export function notifyScrollLayout(viewport: HTMLElement): void {
  const event = new Event("scroll");
  layoutNotifications.add(event);
  viewport.dispatchEvent(event);
}

export function isScrollLayoutNotification(event: Event): boolean {
  return layoutNotifications.has(event);
}
