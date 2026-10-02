// fork #1 of use-mobile.ts (the matchMedia + useSyncExternalStore idiom).
// Deviations: a min-width query and no user-agent fallback (a wide desktop
// layout has no device class to sniff).
import { useSyncExternalStore } from 'react';

/** The wide-desktop threshold: the fine-tuning chip opens as two panes from
 *  here (owner-approved mockup 2026-10-01 — at 1440px the popover's
 *  min(960px, 60vw) is ~860px, the narrowest the two panes still fit). */
const WIDE_MQ = '(min-width: 1440px)';

function subscribe(cb: () => void) {
  const m = window.matchMedia(WIDE_MQ);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

function getSnapshot() {
  return window.matchMedia(WIDE_MQ).matches;
}

function getServerSnapshot() { return false; }

/** Returns true when the viewport is at least 1440px wide. Reactive — updates on resize. */
export function useIsWideViewport() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
