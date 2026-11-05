/**
 * AFP-13 (AGENT_FEED_PERFORMANCE_PLAN, Wave 3 item 1): the feed's window
 * lifecycle hook — the stateful twin of `agent-feed-reconcile.ts`. Owns
 * normalized messages/events, covered windows, cursors, the per-thread
 * history epoch and a per-request generation; AFP-14 wires `AgentShell` onto
 * it for mount/retry, activate/new-session and reconnect, with
 * `use-agent-thread-refresh.ts` remaining the one settle/edit/delete refresh
 * ENTRY that calls {@link UseAgentFeedResult.refresh} here.
 *
 * Concurrency model (the plan's "abort where supported and reject late
 * responses regardless of abort success"): the transport member
 * (`transport.feed.page`, `api/agent-feed-api.ts`) carries no AbortSignal,
 * so rejection is explicit instead — a response lands only when ALL of
 *  - its session key (kind/owner/thread — every operation carries them),
 *  - its generation (bumped on session switches, local invalidating
 *    outcomes and typed stale handling) and
 *  - the pure epoch guard inside `applyAgentFeedPage` (a pre-bump page
 *    never stitches)
 * agree with the current state. Session switches commit thread identity and
 * the initial page ATOMICALLY: the controller resets synchronously on the
 * key change, so a new threadId is never rendered with the old thread's rows
 * (the A→B→A pin).
 *
 * Continuity (Wave 3 item 2): a settle refresh reads the newest page, then
 * bridges the interval back toward the retained fresh coverage with bounded
 * `before` walks (several pages when >100 records arrived); an overlap-less
 * newest page never leaves an invisible gap. The typed 409
 * (`AgentFeedStaleError`) adopts the current epoch, stales every window
 * (rows stay for display, cursors die), re-reads the retained READING
 * neighborhood (`readingAnchor`) and retries the newest read once. A plain
 * failure never empties the feed and never permanently clears `hasOlder`
 * (Wave 3 item 3): rows, flags and cursors change only through applied
 * authoritative pages.
 *
 * Not here: the lazy frozen-event detail cache (AFP-16) and the user-facing
 * load/end/error chrome (AFP-17) — this hook exposes raw state surfaces for
 * them to consume.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentFeedEventSummary, AgentFeedResponse, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { AgentFeedStaleError } from "../../../api/agent-feed-api.js";
import type { getAgentFeedPage } from "../../../api/agent-feed-api.js";
import type { AgentKind } from "../../../lib/agent-host-registry.js";
import {
  agentFeedBridgeTarget,
  agentFeedCanLoadOlder,
  agentFeedFlattened,
  agentFeedOldestMessageId,
  applyAgentFeedLocalMutation,
  applyAgentFeedPage,
  initAgentFeedState,
  staleAgentFeedWindows,
  type AgentFeedLocalMutation,
  type AgentFeedReconcileState,
  type AgentFeedWindow,
} from "./agent-feed-reconcile.js";

/**
 * Bridge pages one settle-refresh may walk (40 records each by policy): the
 * plan's "several bounded bridge pages" for >100-record settles, background
 * completions and reconnects. A LARGER gap (a deep `around` jump) is not
 * fetched wholesale — it stays a visible gap between windows and the next
 * settle continues from there.
 */
const MAX_BRIDGE_PAGES = 12;

/** Stable empty model input (the `EMPTY_AGENT_FEED_*` convention). */
const EMPTY_FLAT: { messages: ExperienceCopilotMessageWire[]; events: AgentFeedEventSummary[] } = {
  messages: [],
  events: [],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Agent feed request failed";
}

/** The synchronous controller truth (mirrored to React through `commit`). */
interface AgentFeedControllerState {
  sessionKey: string;
  feed: AgentFeedReconcileState | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  refreshError: string | null;
  loadingOlder: boolean;
  olderError: string | null;
  loadingAround: boolean;
  aroundError: string | null;
}

/** The hook's public surface (consumed by AFP-14's `AgentShell` wiring). */
export interface UseAgentFeedResult {
  /** The covered-range/epoch-aware state — null before the session's first
   *  page commits (and for a session with no thread). */
  feed: AgentFeedReconcileState | null;
  /** Flattened model input over every covered window (stable row references
   *  across applies; stable ARRAY references while the feed state object is
   *  unchanged). */
  messages: readonly ExperienceCopilotMessageWire[];
  events: readonly AgentFeedEventSummary[];
  loading: boolean;
  error: string | null;
  /** The settle/compaction/edit refresh entry: newest read + bridge; never
   *  empties the feed on failure (`refreshError` carries it). */
  refresh: () => void;
  refreshing: boolean;
  refreshError: string | null;
  /** Page one OLDER window in (single-flight per cursor; a stale or dead
   *  oldest cursor routes through a bounded `around` revalidation first). */
  loadOlder: () => void;
  loadingOlder: boolean;
  olderError: string | null;
  /** Read one bounded neighborhood of a message (the later search plan's
   *  seam; also the revalidation path). Never bridges toward it. */
  loadAround: (messageId: string) => void;
  loadingAround: boolean;
  aroundError: string | null;
  canLoadOlder: boolean;
  /** Carry a local edit/delete/attachment outcome into the invalidation
   *  path — targets outside the newest page included. */
  applyLocalOutcome: (mutation: AgentFeedLocalMutation) => void;
  /** Track what the reader is looking at (AFP-14/15 wire the scroll
   *  position); the typed-stale revalidation re-reads THIS neighborhood. */
  setReadingAnchor: (messageId: string | null) => void;
  /** Re-run the initial load after `error` (same session). */
  retry: () => void;
}

/**
 * The paged feed's session state machine. `feedPage` is the host transport's
 * paged read (`transport.feed.page` — the built-in hosts wire the typed
 * client by identity, AFP-12); hosts without the member keep the legacy
 * full-list path and never mount this hook.
 */
export function useAgentFeed(args: {
  kind: AgentKind;
  ownerKey: string;
  threadId: string | null;
  feedPage: typeof getAgentFeedPage;
}): UseAgentFeedResult {
  const { kind, ownerKey, threadId, feedPage } = args;
  // "\n" separators — kind/ownerKey/threadId are free-form strings that never
  // contain newlines; the key must not admit cross-field collisions.
  const sessionKey = `${kind}\n${ownerKey}\n${threadId ?? ""}`;

  // ── Synchronous truth + React mirror ─────────────────────────────────────
  // Async chains mutate the controller ref directly (reads INSIDE callbacks
  // must see post-action state — render closures hold pre-action state) and
  // publish through `commit`, which takes a fresh object identity per
  // publication so consumers' memo deps see the change.
  // The ref is initialized with a real object (the first render's session
  // key) — never null; the session effect below owns every later value.
  const controllerRef = useRef<AgentFeedControllerState>({
    sessionKey,
    feed: null,
    loading: false,
    error: null,
    refreshing: false,
    refreshError: null,
    loadingOlder: false,
    olderError: null,
    loadingAround: false,
    aroundError: null,
  });
  const [view, setView] = useState<AgentFeedControllerState>(controllerRef.current);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const readingAnchorRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const aroundInFlightRef = useRef(false);
  const olderInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const commit = useCallback(() => {
    if (!mountedRef.current) return;
    controllerRef.current = { ...controllerRef.current };
    setView(controllerRef.current);
  }, []);

  /** Apply one authoritative page to the controller's feed (identity- and
   *  epoch-guarded inside `applyAgentFeedPage`). Returns false when there is
   *  no feed to apply onto. */
  const applyPageInto = useCallback(
    (page: AgentFeedResponse, target?: AgentFeedWindow, emptyPageEdge?: "older" | "newer"): boolean => {
      const feed = controllerRef.current.feed;
      if (feed === null) return false;
      controllerRef.current.feed = applyAgentFeedPage(
        feed,
        page,
        target !== undefined ? { target, ...(emptyPageEdge !== undefined ? { emptyPageEdge } : {}) } : {},
      );
      return true;
    },
    [],
  );

  // ── Initial load (mount / session switch / retry) ────────────────────────
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    // The session switch itself: synchronous atomic reset — thread identity
    // and the first page commit together, never new key with old rows.
    generationRef.current += 1;
    const generation = generationRef.current;
    refreshInFlightRef.current = false;
    aroundInFlightRef.current = false;
    olderInFlightRef.current.clear();
    readingAnchorRef.current = null;
    controllerRef.current = {
      sessionKey,
      feed: null,
      loading: threadId !== null,
      error: null,
      refreshing: false,
      refreshError: null,
      loadingOlder: false,
      olderError: null,
      loadingAround: false,
      aroundError: null,
    };
    commit();
    if (threadId === null) return;
    void (async () => {
      try {
        const page = await feedPage(threadId);
        if (generation !== generationRef.current || !mountedRef.current) return;
        // A foreign-thread page applies onto the thread's empty state and is
        // refused there — no rows ever stitch across threads.
        controllerRef.current.feed = applyAgentFeedPage(initAgentFeedState(threadId), page);
        controllerRef.current.loading = false;
        commit();
      } catch (error) {
        if (generation !== generationRef.current || !mountedRef.current) return;
        controllerRef.current.loading = false;
        controllerRef.current.error = messageOf(error);
        commit();
      }
    })();
  }, [sessionKey, threadId, feedPage, reloadToken, commit]);

  const retry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  // ── Bounded neighborhood read (the search seam + the revalidation path) ──
  const loadAround = useCallback(
    (messageId: string) => {
      if (threadId === null || controllerRef.current.feed === null) return;
      if (aroundInFlightRef.current) return;
      aroundInFlightRef.current = true;
      const generation = generationRef.current;
      readingAnchorRef.current = messageId;
      controllerRef.current = { ...controllerRef.current, loadingAround: true, aroundError: null };
      commit();
      void (async () => {
        try {
          const page = await feedPage(threadId, { aroundMessageId: messageId });
          if (generation === generationRef.current) applyPageInto(page);
        } catch (error) {
          if (generation === generationRef.current) controllerRef.current.aroundError = messageOf(error);
        } finally {
          aroundInFlightRef.current = false;
          if (generation === generationRef.current) {
            controllerRef.current.loadingAround = false;
            commit();
          }
        }
      })();
    },
    [threadId, feedPage, commit, applyPageInto],
  );

  // ── Older-page walk (single-flight per cursor) ───────────────────────────
  const loadOlder = useCallback(() => {
    const feed = controllerRef.current.feed;
    if (feed === null || threadId === null) return;
    const oldest = feed.windows[0];
    if (oldest === undefined) return;
    if (oldest.stale || oldest.before === null || !oldest.hasOlder) {
      // Dead or settled oldest edge while older history is still claimed:
      // revalidate a bounded neighborhood at the oldest loaded row — the
      // re-read restores fresh cursors and paging resumes from there.
      const anchor = agentFeedOldestMessageId(feed);
      if (anchor !== null) loadAround(anchor);
      return;
    }
    const cursor = oldest.before;
    if (olderInFlightRef.current.has(cursor)) return; // single-flight per cursor
    olderInFlightRef.current.add(cursor);
    const generation = generationRef.current;
    controllerRef.current = { ...controllerRef.current, loadingOlder: true, olderError: null };
    commit();
    void (async () => {
      try {
        const page = await feedPage(feed.threadId, { before: cursor });
        if (generation === generationRef.current) {
          applyPageInto(page, oldest, page.messages.length === 0 && page.events.length === 0 ? "older" : undefined);
        }
      } catch (error) {
        if (generation === generationRef.current) {
          if (error instanceof AgentFeedStaleError) {
            // The cursor's epoch died under it: adopt the current epoch, stale
            // the windows, then revalidate the oldest neighborhood once — the
            // caller's next `loadOlder` pages from the fresh cursors.
            const current = controllerRef.current.feed;
            if (current !== null) {
              controllerRef.current.feed = staleAgentFeedWindows(current, error.historyEpoch);
              const anchor = agentFeedOldestMessageId(current);
              if (anchor !== null) {
                try {
                  const around = await feedPage(feed.threadId, { aroundMessageId: anchor });
                  if (generation === generationRef.current) applyPageInto(around);
                } catch {
                  // Best-effort revalidation — the rows are already retained.
                }
              }
            }
          } else {
            // A failed page never empties the feed and never permanently
            // clears hasOlder — only an applied page changes coverage flags.
            controllerRef.current.olderError = messageOf(error);
          }
        }
      } finally {
        olderInFlightRef.current.delete(cursor);
        if (generation === generationRef.current) {
          controllerRef.current.loadingOlder = false;
          commit();
        }
      }
    })();
  }, [threadId, feedPage, commit, applyPageInto, loadAround]);

  // ── Settle refresh: newest read + bounded bridge + stale revalidation ────
  const refresh = useCallback(() => {
    if (threadId === null || controllerRef.current.feed === null) return;
    if (controllerRef.current.sessionKey !== sessionKey) return; // pre-switch closure
    if (refreshInFlightRef.current) return; // one refresh chain at a time
    refreshInFlightRef.current = true;
    const generation = generationRef.current;
    controllerRef.current = { ...controllerRef.current, refreshing: true, refreshError: null };
    commit();
    void (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const newest = await feedPage(threadId);
            if (generation !== generationRef.current) return;
            applyPageInto(newest);
            commit();
            // Bridge the interval between the fresh head window and the
            // retained fresh coverage below it (bounded — see MAX_BRIDGE_PAGES).
            for (let walked = 0; walked < MAX_BRIDGE_PAGES; walked++) {
              const feed = controllerRef.current.feed;
              if (feed === null) return;
              const bridge = agentFeedBridgeTarget(feed);
              if (bridge === null) break;
              const bridging = await feedPage(threadId, { before: bridge.cursor });
              if (generation !== generationRef.current) return;
              applyPageInto(bridging, bridge.window);
              commit();
            }
            return;
          } catch (error) {
            if (!(error instanceof AgentFeedStaleError) || attempt > 0) throw error;
            // The typed stale outcome: adopt the CURRENT epoch, stale every
            // window, re-read the retained reading neighborhood, retry once.
            const current = controllerRef.current.feed;
            if (current === null) throw error;
            controllerRef.current.feed = staleAgentFeedWindows(current, error.historyEpoch);
            commit();
            const anchor = readingAnchorRef.current;
            if (anchor !== null) {
              try {
                const around = await feedPage(threadId, { aroundMessageId: anchor });
                if (generation !== generationRef.current) return;
                applyPageInto(around);
                commit();
              } catch {
                // Best-effort neighborhood re-read — the newest retry still
                // reconnects the head.
              }
            }
          }
        }
      } catch (error) {
        if (generation === generationRef.current) {
          // Rows, cursors and flags stay exactly as the last applied pages
          // left them — the failure is surfaced, never destructive.
          controllerRef.current.refreshError = messageOf(error);
        }
      } finally {
        refreshInFlightRef.current = false;
        if (generation === generationRef.current) {
          controllerRef.current.refreshing = false;
          commit();
        }
      }
    })();
  }, [threadId, sessionKey, feedPage, commit, applyPageInto]);

  // ── Local invalidating outcomes ──────────────────────────────────────────
  const applyLocalOutcome = useCallback(
    (mutation: AgentFeedLocalMutation) => {
      if (controllerRef.current.feed === null) return;
      // In-flight pre-outcome results are late by definition — reject them
      // regardless of the epoch arithmetic (a page computed before the local
      // write can re-add a row the shell already watched die).
      generationRef.current += 1;
      refreshInFlightRef.current = false;
      controllerRef.current.feed = applyAgentFeedLocalMutation(controllerRef.current.feed, mutation);
      commit();
    },
    [commit],
  );

  const setReadingAnchor = useCallback((messageId: string | null) => {
    readingAnchorRef.current = messageId;
  }, []);

  // ── Derived, reference-stable across unchanged feeds ─────────────────────
  const feed = view.feed;
  const flat = useMemo(() => (feed !== null ? agentFeedFlattened(feed) : EMPTY_FLAT), [feed]);

  return {
    feed,
    messages: flat.messages,
    events: flat.events,
    loading: view.loading,
    error: view.error,
    refresh,
    refreshing: view.refreshing,
    refreshError: view.refreshError,
    loadOlder,
    loadingOlder: view.loadingOlder,
    olderError: view.olderError,
    loadAround,
    loadingAround: view.loadingAround,
    aroundError: view.aroundError,
    canLoadOlder: feed !== null && agentFeedCanLoadOlder(feed),
    applyLocalOutcome,
    setReadingAnchor,
    retry,
  };
}
