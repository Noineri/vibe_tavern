import { useCallback, useEffect, useState } from "react";

import { devLog } from "../lib/dev-log.js";

/** Per-command "done" marks for the setup guides (owner flow 2026-09-06:
 *  copy → paste → wait → tick the step off). Persisted in localStorage so a
 *  long install (torch cu124 downloads for minutes) survives modal close and
 *  page reloads. Keyed per guide AND per OS — the two OS branches are
 *  different command lists, each keeps its own honest state. */
const STORAGE_PREFIX = "vt-guide-checks:v1:";

function readChecks(storageKey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    // Corrupt/partial JSON or blocked storage — start from an empty list.
    return new Set();
  }
}

function persistChecks(storageKey: string, checks: Set<string>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...checks]));
  } catch (cause) {
    // Private mode / quota — the checklist degrades to in-memory for this
    // session instead of breaking the guide.
    devLog("guide-checks-persist-failed", { error: String(cause) });
  }
}

export interface GuideChecklist {
  /** Is the command at `stepId[index]` marked done? */
  isChecked: (stepId: string, index: number) => boolean;
  /** Toggle the manual done-mark for `stepId[index]` (never auto-set:
   *  copying a command is not running it). */
  toggle: (stepId: string, index: number) => void;
  /** Clear every mark for the current guide+OS (reinstall flow — stale
   *  "done" marks would lie during a redo). */
  reset: () => void;
  /** How many commands are marked (drives the reset link visibility). */
  total: number;
}

export function useGuideChecklist(guideId: string, os: string): GuideChecklist {
  const storageKey = STORAGE_PREFIX + guideId + ":" + os;
  const [checks, setChecks] = useState<Set<string>>(() => readChecks(storageKey));

  // OS toggle swaps the command list — reload that list's own marks.
  useEffect(() => {
    setChecks(readChecks(storageKey));
  }, [storageKey]);

  const isChecked = useCallback(
    (stepId: string, index: number) => checks.has(stepId + ":" + index),
    [checks],
  );

  const toggle = useCallback(
    (stepId: string, index: number) => {
      setChecks((prev) => {
        const key = stepId + ":" + index;
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        persistChecks(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    setChecks(new Set());
    try {
      window.localStorage.removeItem(storageKey);
    } catch (cause) {
      devLog("guide-checks-reset-failed", { error: String(cause) });
    }
  }, [storageKey]);

  return { isChecked, toggle, reset, total: checks.size };
}
