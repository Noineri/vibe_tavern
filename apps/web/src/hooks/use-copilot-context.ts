/**
 * Copilot context meter state (COPILOT_CONTEXT_METER_PLAN, Wave 3 / CM-8).
 *
 * Owns the per-thread context state the meter renders and the compact flow:
 *  - `metrics` + `autoCompact` are fetched from `GET .../context` on mount and
 *    on every thread switch (reset to a clean unmetered state first, so a stale
 *    sibling thread's numbers never flash on the new thread).
 *  - `applyMetrics` is the live SSE feed: the shell passes the `finish` event's
 *    metrics straight in, so the meter updates immediately without a refetch
 *    round-trip (the controller validates the wire shape before calling it).
 *  - `compact` POSTs the manual compaction and, on success, bumps metrics from
 *    the response and calls `onCompacted` (the shell refetches messages so the
 *    digest card appears). Errors propagate to the caller (the meter surfaces a
 *    toast) — the hook holds no toast policy.
 *  - `setAutoCompact` PATCHes the toggle optimistically and reverts on failure,
 *    rethrowing so the caller can toast.
 *
 * The hook is thread-scoped: passing a new `threadId` re-runs the fetch effect
 * and clears prior state. A `threadId` of null (no session yet) is a no-op.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
import {
  getExperienceCopilotContext,
  patchExperienceCopilotContext,
  compactExperienceCopilot,
} from "../api/experience-copilot-api.js";

export interface UseCopilotContextArgs {
  threadId: string | null;
  /** Called after a successful manual compact so the shell can refetch messages
   *  (the newly appended digest message must appear as a card at the boundary). */
  onCompacted?: () => void;
}

export interface CopilotContextController {
  metrics: ExperienceCopilotContextMetrics | null;
  autoCompact: boolean;
  isCompacting: boolean;
  /** Live SSE feed — the shell passes the finish event's validated metrics. */
  applyMetrics: (metrics: ExperienceCopilotContextMetrics | null) => void;
  /** Manual compaction. Rejects on failure (the caller toasts). */
  compact: () => Promise<void>;
  /** Toggle auto-compact. Optimistic; reverts + rethrows on failure. */
  setAutoCompact: (enabled: boolean) => Promise<void>;
}

export function useCopilotContext({ threadId, onCompacted }: UseCopilotContextArgs): CopilotContextController {
  const [metrics, setMetrics] = useState<ExperienceCopilotContextMetrics | null>(null);
  const [autoCompact, setAutoCompactState] = useState(true);
  const [isCompacting, setIsCompacting] = useState(false);
  const isCompactingRef = useRef(false);

  const onCompactedRef = useRef(onCompacted);
  onCompactedRef.current = onCompacted;

  useEffect(() => {
    // Reset first so a sibling thread's metrics never flash on the new thread,
    // then fetch the fresh state.
    setMetrics(null);
    setAutoCompactState(true);
    if (!threadId) return;

    let cancelled = false;
    getExperienceCopilotContext(threadId)
      .then((state) => {
        if (cancelled) return;
        setMetrics(state.metrics);
        setAutoCompactState(state.autoCompact);
      })
      .catch(() => {
        // Best-effort: a transient context-fetch failure leaves the meter in its
        // unmetered state (same swallow policy as the session-list fetch).
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const applyMetrics = useCallback((m: ExperienceCopilotContextMetrics | null) => {
    setMetrics(m);
  }, []);

  const compact = useCallback(async () => {
    if (!threadId || isCompactingRef.current) return;
    isCompactingRef.current = true;
    setIsCompacting(true);
    try {
      const result = await compactExperienceCopilot(threadId);
      setMetrics(result.metrics);
      onCompactedRef.current?.();
    } finally {
      isCompactingRef.current = false;
      setIsCompacting(false);
    }
  }, [threadId]);

  const setAutoCompact = useCallback(async (enabled: boolean) => {
    if (!threadId) return;
    setAutoCompactState(enabled);
    try {
      const state = await patchExperienceCopilotContext(threadId, { autoCompact: enabled });
      setAutoCompactState(state.autoCompact);
    } catch (err) {
      // Revert to the last-known server value; rethrow for the caller's toast.
      setAutoCompactState(!enabled);
      throw err;
    }
  }, [threadId]);

  return { metrics, autoCompact, isCompacting, applyMetrics, compact, setAutoCompact };
}
