import { useEffect, useRef, useState } from "react";

/**
 * A boolean state persisted to `localStorage` as `"true"`/`"false"`.
 *
 * - Reads once on mount (lazy init); writes on every change.
 * - The hook RE-READS when `key` changes (the panel is not remounted on a
 *   chat switch, so with a per-chat key chat A's state would show in chat B
 *   and then be WRITTEN under B's key). The re-read is a render-phase update
 *   (the React-sanctioned derived-state pattern), so no stale frame commits
 *   and the write effect below never persists the previous key's value under
 *   the new key. Existing consumers (constant or per-character keys) behave
 *   as before: the key never changes under them, so the re-read never fires.
 * - Absent key → `defaultValue`; unparseable value → `defaultValue`.
 * - Both get and set are guarded (private mode / quota) and never throw.
 *
 * Returns the same `[value, setValue]` tuple shape as `useState`, so callers can
 * pass updater functions (`setValue((v) => !v)`) exactly as before. Extracted
 * from the verbatim-identical accordion persistence in `GalleryAccordion` and
 * `VibeMdView` (frontend-reuse-and-extraction.md §1.4).
 */
export function usePersistedBoolean(key: string, defaultValue: boolean) {
  const [value, setValue] = useState(() => readBoolean(key, defaultValue));
  // The key the current value was READ for. Diverges from `key` for exactly
  // one render after a key change; the render-phase update below closes it
  // before commit, so the write effect never sees a mismatched pair.
  const readKeyRef = useRef(key);
  if (readKeyRef.current !== key) {
    readKeyRef.current = key;
    const next = readBoolean(key, defaultValue);
    if (next !== value) setValue(next);
  }

  useEffect(() => {
    writeBoolean(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}

/** Bounds a persisted number is clamped to on every read and every write. */
export interface PersistedNumberBounds {
  min?: number;
  max?: number;
}

/**
 * A numeric sibling of `usePersistedBoolean` in the same module (SC-14: the
 * sidechat width, one global preference `vt.sidechat.width` for all chats).
 *
 * - Reads once on mount (lazy init) and re-reads when `key` changes, under
 *   the same no-cross-write rule as the boolean above.
 * - The stored value is CLAMPED ON READ to `bounds` (absent/unparseable/non-
 *   finite → `defaultValue`); the setter clamps too, so storage always holds
 *   a within-bounds finite number. A relative bound (the sidechat's 50% max
 *   needs the live container width) stays with the caller at render/drag
 *   time — the hook only enforces the static bounds it is given.
 * - Both get and set are guarded (private mode / quota) and never throw.
 */
export function usePersistedNumber(key: string, defaultValue: number, bounds?: PersistedNumberBounds) {
  const min = bounds?.min;
  const max = bounds?.max;
  const [value, setValueState] = useState(() => readNumber(key, defaultValue, min, max));
  const readKeyRef = useRef(key);
  if (readKeyRef.current !== key) {
    readKeyRef.current = key;
    const next = readNumber(key, defaultValue, min, max);
    if (next !== value) setValueState(next);
  }

  useEffect(() => {
    writeNumber(key, value);
  }, [key, value]);

  const setValue = (next: number | ((prev: number) => number)) => {
    setValueState((prev) => {
      const raw = typeof next === "function" ? (next as (prev: number) => number)(prev) : next;
      return clampNumber(raw, defaultValue, min, max);
    });
  };

  return [value, setValue] as const;
}

function readBoolean(key: string, defaultValue: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? defaultValue : stored === "true";
  } catch {
    return defaultValue;
  }
}

function writeBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "true" : "false");
  } catch {
    /* ignore quota / private mode */
  }
}

function clampNumber(value: number, defaultValue: number, min: number | undefined, max: number | undefined): number {
  if (!Number.isFinite(value)) return defaultValue;
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

function readNumber(key: string, defaultValue: number, min: number | undefined, max: number | undefined): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return clampNumber(defaultValue, defaultValue, min, max);
    return clampNumber(Number(stored), defaultValue, min, max);
  } catch {
    return clampNumber(defaultValue, defaultValue, min, max);
  }
}

function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore quota / private mode */
  }
}
