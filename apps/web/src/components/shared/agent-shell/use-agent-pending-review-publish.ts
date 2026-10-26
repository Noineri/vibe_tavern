import { useEffect, useRef } from "react";
import { getAgentHost, type AgentKind } from "../../../lib/agent-host-registry.js";
import { useAgentPendingReviewStore, type AgentPendingBufferSummary } from "../../../stores/agent-pending-review-store.js";

/**
 * AP-15 (AGENT_SHELL_POLISH): a review session's PUBLISH side effect —
 * mirrors the thread's pending state into the ONE plain pending-review
 * summary store (`agent-pending-review-store.ts`) that the shell's
 * pending-changes strip will read (AP-16 renders it; nothing here renders).
 * Called by the hosts' review sessions (the experience hook and the script
 * session) with their buffer pending counts — every review behavior of the
 * callers stays untouched; this hook only observes and publishes.
 *
 * Lifecycle (the store's ownership contract, enforced here):
 *   - republish whenever a pending count changes (proposal lands, hunk
 *     accepted/dismissed);
 *   - clear when no buffer has pending hunks left (the strip disappears);
 *   - clear on unmount / thread switch — the callables die with the pane,
 *     and the store must never hold a stale one.
 *
 * The callables stay fresh through refs reassigned every render (the
 * latest-callback-ref pattern the hosts' bridge handles use), so the
 * published entry never holds a stale closure even though the publish
 * effect re-runs only on count changes. Buffer label keys resolve from the
 * host descriptor's `bufferSpecs` — the ONE declaration of buffer labels,
 * never re-typed by a consumer. While a turn streams the callers' review
 * objects go null (the frozen editor shows no review); the entry clears
 * with them and republishes when the round reappears after settle.
 */
export function useAgentPendingReviewPublish({
  kind,
  threadId,
  pendingByBuffer,
  acceptAll,
  open,
}: {
  kind: AgentKind;
  threadId: string | null;
  /** Per-buffer pending hunk counts, by the descriptor's buffer ids. */
  pendingByBuffer: ReadonlyArray<{ id: string; pending: number }>;
  /** Accept every pending hunk (the strip's accept-all action, AP-16). */
  acceptAll: () => void;
  /** Open the review surface (the strip's open action, AP-16). */
  open: () => void;
}): void {
  const acceptAllRef = useRef(acceptAll);
  const openRef = useRef(open);
  acceptAllRef.current = acceptAll;
  openRef.current = open;
  // Serialize the counts into the effect's dependency: the array arrives
  // fresh every render, so only this stable string can gate re-publishes on
  // actual count changes (callables ride through the refs above).
  const countsKey = pendingByBuffer.map((entry) => `${entry.id}:${entry.pending}`).join("\u0000");
  useEffect(() => {
    if (!threadId) return;
    const buffers: AgentPendingBufferSummary[] = getAgentHost(kind).bufferSpecs.flatMap((spec) => {
      const pending = pendingByBuffer.find((entry) => entry.id === spec.id)?.pending ?? 0;
      return pending > 0 ? [{ labelKey: spec.labelKey, pending }] : [];
    });
    const store = useAgentPendingReviewStore.getState();
    if (buffers.length === 0) {
      store.clear(kind, threadId);
      return;
    }
    store.publish(kind, threadId, {
      buffers,
      acceptAll: () => acceptAllRef.current(),
      open: () => openRef.current(),
    });
    // Deps are the kind/thread plus the counts string — see countsKey.
  }, [kind, threadId, countsKey]);
  // Unmount / thread switch: drop the entry — the callables die with the
  // pane, and the store must never hold a stale one.
  useEffect(() => {
    if (!threadId) return;
    return () => useAgentPendingReviewStore.getState().clear(kind, threadId);
  }, [kind, threadId]);
}
