import { useEffect, useState } from "react";

/**
 * A boolean state persisted to `localStorage` as `"true"`/`"false"`.
 *
 * - Reads once on mount (lazy init); writes on every change.
 * - Absent key → `defaultValue`; unparseable value → `defaultValue`.
 * - Both get and set are guarded (private mode / quota) and never throw.
 *
 * Returns the same `[value, setValue]` tuple shape as `useState`, so callers can
 * pass updater functions (`setValue((v) => !v)`) exactly as before. Extracted
 * from the verbatim-identical accordion persistence in `GalleryAccordion` and
 * `VibeMdView` (frontend-reuse-and-extraction.md §1.4).
 */
export function usePersistedBoolean(key: string, defaultValue: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultValue : stored === "true";
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, value ? "true" : "false");
    } catch {
      /* ignore quota / private mode */
    }
  }, [key, value]);

  return [value, setValue] as const;
}
