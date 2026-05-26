import { useSyncExternalStore } from 'react';

const MOBILE_MQ = '(max-width: 768px)';

function subscribe(cb: () => void) {
  const m = window.matchMedia(MOBILE_MQ);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

function getSnapshot() {
  // Viewport check + UA fallback for file:// URLs on mobile
  if (window.matchMedia(MOBILE_MQ).matches) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
  return false;
}

function getServerSnapshot() { return false; }

/** Returns true when viewport ≤ 768px or on mobile device. Reactive — updates on resize. */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
