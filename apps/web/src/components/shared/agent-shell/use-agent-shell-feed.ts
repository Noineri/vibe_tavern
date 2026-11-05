/**
 * AFP-14 (AGENT_FEED_PERFORMANCE_PLAN): the shell's paged-feed wiring — the
 * ONE place `AgentShell` decides between the legacy full-list path and the
 * AFP-13 windowed lifecycle. Extracted from `AgentShell.tsx` by the
 * file-size ratchet; the shell consumes this hook's result verbatim.
 *
 * A host whose transport carries `feed` (AFP-12's additive member) never
 * loads the full thread through `listMessages`: the initial page, every
 * settle/edit/delete/compaction/attachment refresh and the reconnect walk
 * go through the AFP-13 feed hook (covered ranges, history epoch, bounded
 * gap bridging), and a real session change swaps the feed state atomically
 * (never a new threadId with the previous thread's rows). Legacy hosts
 * keep the full-list path byte-identical — they pass `threadId: null` into
 * the hook so NO request runs, and every `feed*` seam below stays
 * `undefined` (the optional-member contracts downstream).
 */
import { useMemo } from "react";
import type { getAgentFeedPage } from "../../../api/agent-feed-api.js";
import type { AgentHostTransport } from "../../../lib/agent-host-registry.js";
import type { AgentKind } from "../../../lib/agent-host-registry.js";
import { useAgentFeed } from "./use-agent-feed.js";
import type { AgentFeedWindow } from "./agent-feed-reconcile.js";

/** Never invoked — legacy hosts pass `threadId: null` into the feed hook,
 *  so no request ever runs; the stub only satisfies the unconditional hook
 *  call's argument type. */
const LEGACY_FEED_PAGE: typeof getAgentFeedPage = async () => {
  throw new Error("Legacy host transport has no paged feed member");
};

/** The shell's paged-feed seam bundle (all members `undefined`/stable
 *  empties for a legacy host — the full-list path reads none of them). */
export interface AgentShellFeed {
  /** True ⇔ the host transport carries `feed` (constant per shell mount). */
  isPaged: boolean;
  /** The AFP-13 lifecycle hook's full surface (never called for legacy). */
  feed: ReturnType<typeof useAgentFeed>;
  /** The reconciled covered windows (`undefined` before the first page). */
  pageWindows: readonly AgentFeedWindow[] | undefined;
  /** Flattened covered-window rows — the legacy `messages` stand-in. */
  messages: ReturnType<typeof useAgentFeed>["messages"];
  /** The one refresh entry (`use-agent-thread-refresh`'s `feedRefresh`). */
  refresh: (() => void) | undefined;
  /** The local-outcome seam (`use-agent-controller`'s `feedOutcome`). */
  outcome: { applyLocalOutcome: ReturnType<typeof useAgentFeed>["applyLocalOutcome"]; loadAround: ReturnType<typeof useAgentFeed>["loadAround"] } | undefined;
  /** AFP-16's lazy-detail provider source (null for legacy hosts and before
   *  the first page commits); `onStale` adopts a new epoch through the SAME
   *  one refresh path, never an eager detail-restart loop. */
  detailSource: {
    threadId: string;
    epoch: number;
    loadDetail: NonNullable<AgentHostTransport["feed"]>["detail"];
    onStale: () => void;
  } | null;
}

export function useAgentShellFeed(args: {
  kind: AgentKind;
  ownerKey: string;
  threadId: string | null;
  transport: AgentHostTransport;
}): AgentShellFeed {
  const { kind, ownerKey, threadId, transport } = args;
  const feedTransport = transport.feed;
  const isPaged = feedTransport !== undefined;
  const feed = useAgentFeed({
    kind,
    ownerKey,
    threadId: isPaged ? threadId : null,
    feedPage: feedTransport?.page ?? LEGACY_FEED_PAGE,
  });
  const feedState = feed.feed;
  const refresh = isPaged ? feed.refresh : undefined;
  const outcome = useMemo(
    () =>
      isPaged
        ? { applyLocalOutcome: feed.applyLocalOutcome, loadAround: feed.loadAround }
        : undefined,
    [isPaged, feed.applyLocalOutcome, feed.loadAround],
  );
  // AFP-16's lazy-detail seam: summaries render above the provider; their
  // bodies open through `transport.feed.detail` keyed by the feed's history
  // epoch. `onStale` (a 409 detail read — the history changed under the
  // loaded window) is the notification AFP-16 exposed for exactly this
  // lifecycle integration.
  const detailSource = useMemo(
    () =>
      feedTransport !== undefined && threadId !== null && feedState !== null
        ? {
            threadId,
            epoch: feedState.historyEpoch ?? 0,
            loadDetail: feedTransport.detail,
            onStale: () => feed.refresh(),
          }
        : null,
    [feedTransport, threadId, feedState, feed.refresh],
  );
  return {
    isPaged,
    feed,
    pageWindows: feedState?.windows,
    messages: feed.messages,
    refresh,
    outcome,
    detailSource,
  };
}
