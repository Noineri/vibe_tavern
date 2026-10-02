import { useNavigationStore } from "./navigation-store.js";
import { useCharacterStore } from "./character-store.js";
import { APP_MODES } from "../lib/chat-mode-registry.js";
import { getBuildPanels } from "../lib/build-panel-registry.js";

// BUILD_MODE_F5_RESTORE_REPORT step 1 (A): F5 must not drop build mode.
// sessionStorage, NOT localStorage (owner-approved mechanism, agent proposal
// 2026-09-30): the values survive a reload in the same tab, while a fresh
// start of VT still opens on play as today. Key prefix matches
// lib/local-storage.ts.

const MODE_KEY = "vibe-tavern.nav.mode";
const BUILD_TAB_KEY = "vibe-tavern.nav.build-tab";

let restored = false;

function writeSessionValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  // Writes are suppressed until the first restoreNavigationSession call: the
  // app mounts in play mode and mount-time store setStates (e.g. the theme
  // effect's setTheme) fire the subscriptions with the DEFAULT mode — without
  // this gate they clobber the persisted values before restore reads them
  // (observed live: seeded "build" → restore read "play").
  if (!restored) return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode / quota): navigation just won't persist.
  }
}

function readSessionValue<T extends string>(key: string, valid: readonly T[]): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null || !(valid as readonly string[]).includes(raw)) return null;
    // Validated against `valid` above — the only cast, same shape as branded
    // ID narrowing at boundaries.
    return raw as T;
  } catch {
    return null;
  }
}

/**
 * Restore `mode` + `buildTab` after the initial bootstrap has restored the
 * active chat. Call ONLY from the startup load (`useVibeTavernApp.load`) — a
 * silent re-bootstrap must never fight live navigation. Without an active
 * chat nothing is restored: build mode without a character has nothing to
 * edit, so the app stays on play (the store defaults).
 */
export function restoreNavigationSession(hasActiveChat: boolean): void {
  try {
    if (!hasActiveChat) return;
    const mode = readSessionValue(MODE_KEY, APP_MODES);
    if (mode) useNavigationStore.getState().setMode(mode);
    const buildTab = readSessionValue(BUILD_TAB_KEY, getBuildPanels().map((p) => p.id));
    if (buildTab) useCharacterStore.getState().setBuildTab(buildTab);
  } finally {
    // From here on, live mode/tab changes persist (see writeSessionValue).
    restored = true;
  }
}

let wired = false;

/**
 * Subscribe once at startup (main.tsx) so later `mode`/`buildTab` changes are
 * written to sessionStorage. Idempotent; a no-op where `window` is absent
 * (SSR/tests without dom-env).
 */
export function initNavigationPersistence(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  useNavigationStore.subscribe((s) => writeSessionValue(MODE_KEY, s.mode));
  useCharacterStore.subscribe((s) => writeSessionValue(BUILD_TAB_KEY, s.buildTab));
}

// ── Test seam (test-hygiene R2: snapshot before, restore in afterAll) ──

export interface NavigationPersistenceTestSnapshot {
  wired: boolean;
  restored: boolean;
}

export function __snapshotNavigationPersistenceForTests(): NavigationPersistenceTestSnapshot {
  return { wired, restored };
}

export function __restoreNavigationPersistenceForTests(snapshot: NavigationPersistenceTestSnapshot): void {
  wired = snapshot.wired;
  restored = snapshot.restored;
}

/** Reset the idempotence/restoration guards so each test starts pre-wire, pre-restore. */
export function __resetNavigationPersistenceForTests(): void {
  wired = false;
  restored = false;
}
