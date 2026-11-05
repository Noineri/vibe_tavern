/**
 * AFP-13 (AGENT_FEED_PERFORMANCE_PLAN, Wave 3 items 1–2): the PURE state core
 * under `use-agent-feed.ts` — covered-range/epoch-aware feed state built from
 * AFP-7 `AgentFeedResponse` pages. No React, no fetches, no stores: every
 * function takes a state and returns a NEW state (untouched windows keep
 * their object references), and the hook owns when/whether to call them.
 *
 * State model — WINDOWS, not one flat list:
 * - One thread's loaded UI history is a list of WINDOWS ordered oldest →
 *   newest by their position extents, pairwise non-overlapping. A window is
 *   what one coherent read (plus every merge into it) proved: its rows, the
 *   extent positions (`range.oldest`/`range.newest` of the contributing
 *   pages), the adjacent-page cursors, the page-cut boundary facts and the
 *   thread-coverage flags as of its newest contributing read.
 * - Rows are authoritative ONLY inside covered ranges: an applied page
 *   updates changed rows, inserts new rows and removes vanished rows between
 *   its anchors; records outside every covered range are unknown, never
 *   guessed deleted (the plan's named invariant).
 * - `stale` marks windows holding rows that predate an epoch change (a
 *   destructive write bumped `historyEpoch` under them). Stale rows stay on
 *   screen for reading, but the window's cursors are dead (nulled) and a
 *   fresh page that fully re-covers the window clears the flag; a partial
 *   re-read leaves it set (its retained rows are still suspect).
 *
 * Ordering — fork #1 of compareAgentFeedPositions
 * (packages/db/src/stores/agent-feed-order.ts): seq ascending with the legacy
 * NULL-seq prefix first, then createdAt, then id, `record` only as the final
 * equal-key tie (message before event — the merged-timeline collection
 * order). The server twin composes `compareTimelineEntries` (SC-1) and lives
 * behind `bun:sqlite`, which the SPA cannot import — so the same ordering
 * knowledge necessarily lives in both files, and a change to the tie
 * semantics changes BOTH together with the AFP-7 schema doc that states the
 * contract (`agent-feed-schema.ts`). The tie pins live in
 * `agent-feed-reconcile.test.ts`.
 */

import type {
  AgentFeedBoundary,
  AgentFeedEventSummary,
  AgentFeedOrderPosition,
  AgentFeedResponse,
  ExperienceCopilotMessageWire,
} from "@vibe-tavern/api-contracts";

// ─── Ordering contract (see the module header) ───────────────────────────────

/** Compare two merged-timeline positions: seq ascending with the legacy
 *  NULL-seq prefix first, then createdAt, then id; `record` breaks a full
 *  key tie (message before event). Total, antisymmetric, transitive. */
export function compareAgentFeedOrderPositions(a: AgentFeedOrderPosition, b: AgentFeedOrderPosition): number {
  if (a.seq === null && b.seq !== null) return -1;
  if (a.seq !== null && b.seq === null) return 1;
  if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.record === b.record ? 0 : a.record === "message" ? -1 : 1;
}

/** True when the two extents [aOldest..aNewest] and [bOldest..bNewest] share
 *  at least one position (inclusive — equal edges overlap). */
function extentsOverlap(
  aOldest: AgentFeedOrderPosition,
  aNewest: AgentFeedOrderPosition,
  bOldest: AgentFeedOrderPosition,
  bNewest: AgentFeedOrderPosition,
): boolean {
  return compareAgentFeedOrderPositions(bOldest, aNewest) <= 0 && compareAgentFeedOrderPositions(aOldest, bNewest) <= 0;
}

// ─── Windows ─────────────────────────────────────────────────────────────────

/** One contiguous covered range of the thread's merged timeline — everything
 *  its contributing pages proved. Rows stay in merged-timeline order and
 *  keep their object references across applies unless their content changed
 *  (the stable-refs contract Wave 3 item 2 pins). */
export interface AgentFeedWindow {
  /** Loaded messages of this range, oldest → newest. */
  messages: ExperienceCopilotMessageWire[];
  /** Loaded event summaries of the same logical range, oldest → newest. */
  events: AgentFeedEventSummary[];
  /** The range's position extent — exact extremes of the contributing pages
   *  (`range.oldest`/`range.newest`), never derived from rows client-side. */
  oldest: AgentFeedOrderPosition;
  newest: AgentFeedOrderPosition;
  /** Page-cut facts of the window's EDGES: start-side fields
   *  (`startsMidTurn`, `turnOpenerMessageId`, `continuedToolCalls`) come from
   *  the OLDEST contributing page, end/thread-side fields (`endsMidTurn`,
   *  `lastUserMessageId`, `digest`) from the NEWEST one. */
  boundary: AgentFeedBoundary;
  /** Thread-coverage flags as of the window's newest contributing read. */
  hasOlder: boolean;
  hasNewer: boolean;
  /** Opaque cursor of the adjacent OLDER page (null ⇒ the thread start is
   *  proven, or the cursor is dead — `stale` distinguishes nothing here:
   *  dead cursors are nulled when the window goes stale). */
  before: string | null;
  /** Opaque cursor of the adjacent NEWER page (same null semantics). */
  after: string | null;
  /** Some retained rows predate an epoch change — display-retained, never
   *  authoritative; both cursors above are dead (null). */
  stale: boolean;
}

/** The whole loaded feed state of ONE thread session. */
export interface AgentFeedReconcileState {
  threadId: string;
  /** The newest `historyEpoch` any applied page (or typed stale outcome)
   *  carried — null before the first read. A page from an older epoch is a
   *  late pre-bump result and is refused by `applyAgentFeedPage`. */
  historyEpoch: number | null;
  /** The thread's newest primary record as of the newest applied read. */
  head: AgentFeedOrderPosition | null;
  /** Covered windows, ordered oldest → newest, pairwise non-overlapping. */
  windows: AgentFeedWindow[];
}

/** The empty session state — no pages applied yet. */
export function initAgentFeedState(threadId: string): AgentFeedReconcileState {
  return { threadId, historyEpoch: null, head: null, windows: [] };
}

// ─── Row-level merge (authoritative in-range reconcile) ──────────────────────

/** Field-by-field equality of two wire rows (both are zod-`.strict()` objects,
 *  so the key sets are fixed). Equal rows keep their RETAINED reference. */
function sameWireRow<T extends object>(a: T, b: T): boolean {
  for (const key of Object.keys(a)) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/** One id-keyed row array carrying its provenance for the merge math. */
interface RowBag<T> {
  rows: readonly T[];
  idOf: (row: T) => string;
  /** The bag's position extent — the PAGE's own extent for a page bag (exact),
   *  the window's extent for a window bag (exact extremes of its pages). */
  oldest: AgentFeedOrderPosition;
  newest: AgentFeedOrderPosition;
}

/** Result of merging one authoritative page bag into one retained bag. */
interface MergedRows<T> {
  rows: T[];
  /** How many retained rows the page re-matched by id (anchors). */
  anchors: number;
  /** True when retained rows survived OUTSIDE the page's extent (head and/or
   *  tail) — their staleness carries into the merged window. */
  retainedOutsideExtent: boolean;
}

/**
 * Merge an authoritative page's ordered rows into a retained window's rows.
 * `page` is authoritative for its OWN extent; anchors (shared ids) locate
 * that extent inside the retained array:
 * - between the first and last anchor the page's span replaces the retained
 *   span (updates take the incoming row, vanished retained rows drop, new
 *   ids insert — in page order);
 * - outside the anchors, the page extends the range on the side(s) its
 *   extent reaches beyond the window's (`po <= wo` covers the whole head,
 *   `pn >= wn` the whole tail); retained rows proven outside the page extent
 *   survive in place;
 * - zero anchors with overlapping extents means the overlapped rows were ALL
 *   replaced (only possible after an epoch change — same-epoch writes keep
 *   ids): the caller replaces the whole window.
 * Equal rows keep their retained object references (stable refs).
 */
function mergeRows<T extends object>(page: RowBag<T>, retained: RowBag<T>): MergedRows<T> {
  const pageIds = new Map<string, number>();
  page.rows.forEach((row, index) => pageIds.set(page.idOf(row), index));

  let firstRetained = -1;
  let lastRetained = -1;
  for (let i = 0; i < retained.rows.length; i++) {
    if (pageIds.has(retained.idOf(retained.rows[i]!))) {
      if (firstRetained === -1) firstRetained = i;
      lastRetained = i;
    }
  }

  // Reference retention: prefer the retained object when a re-read row is
  // field-identical (downstream memos keep their snapshot identities).
  const retainedById = new Map<string, T>();
  for (const row of retained.rows) retainedById.set(retained.idOf(row), row);
  const keepRef = (row: T): T => {
    const existing = retainedById.get(page.idOf(row));
    return existing !== undefined && sameWireRow(existing, row) ? existing : row;
  };

  const pageCoversHead = compareAgentFeedOrderPositions(page.oldest, retained.oldest) <= 0;
  const pageCoversTail = compareAgentFeedOrderPositions(page.newest, retained.newest) >= 0;

  if (firstRetained === -1) {
    // No anchors. Disjoint extents: plain concatenation by extent order (the
    // caller only reaches this for request-adjacent pages — keyset walks).
    // Overlapping extents: the caller replaces the window instead (see
    // applyAgentFeedPage); this branch returns the retained rows untouched so
    // the caller can detect `anchors === 0` and decide. An empty side (no
    // rows of this type anywhere) reports no retained rows — the OTHER row
    // type's anchors govern the merge.
    return {
      rows: [...retained.rows],
      anchors: 0,
      retainedOutsideExtent: false,
    };
  }

  const firstIncoming = pageIds.get(retained.idOf(retained.rows[firstRetained]!))!;
  const lastIncoming = pageIds.get(retained.idOf(retained.rows[lastRetained]!))!;

  // Head side (older): page rows below the first anchor extend the range
  // when the page reaches past the window's oldest; otherwise they are
  // in-extent insertions and land between the retained head and the anchor.
  // Retained head rows survive only when proven outside the page extent.
  const head: T[] = pageCoversHead
    ? page.rows.slice(0, firstIncoming).map(keepRef)
    : [...retained.rows.slice(0, firstRetained), ...page.rows.slice(0, firstIncoming).map(keepRef)];
  // The authoritative span between the anchors.
  const span: T[] = page.rows.slice(firstIncoming, lastIncoming + 1).map(keepRef);
  // Tail side (newer): mirrored logic.
  const tail: T[] = pageCoversTail
    ? page.rows.slice(lastIncoming + 1).map(keepRef)
    : [...page.rows.slice(lastIncoming + 1).map(keepRef), ...retained.rows.slice(lastRetained + 1)];

  const retainedHeadKept = !pageCoversHead && firstRetained > 0;
  const retainedTailKept = !pageCoversTail && lastRetained + 1 < retained.rows.length;

  return {
    rows: [...head, ...span, ...tail],
    anchors: lastRetained - firstRetained + 1,
    retainedOutsideExtent: retainedHeadKept || retainedTailKept,
  };
}

/** Mix two windows' boundary facts for a coalesce of `older` then `newer`:
 *  start-side fields from the older contributor's oldest cut, end/thread
 *  fields from the newest contributor's freshest read. */
function mixBoundaries(older: AgentFeedBoundary, newer: AgentFeedBoundary): AgentFeedBoundary {
  return {
    startsMidTurn: older.startsMidTurn,
    turnOpenerMessageId: older.turnOpenerMessageId,
    continuedToolCalls: older.continuedToolCalls,
    endsMidTurn: newer.endsMidTurn,
    lastUserMessageId: newer.lastUserMessageId,
    digest: newer.digest,
  };
}

/** Coalesce two NON-overlapping windows `older` + `newer` into one (the
 *  request-adjacent path — a keyset page walk): rows concatenate, extents
 *  union, boundary/cursors/flags take each side from its own contributor and
 *  staleness survives when either side retains stale rows. */
function coalesceWindows(older: AgentFeedWindow, newer: AgentFeedWindow): AgentFeedWindow {
  return {
    messages: [...older.messages, ...newer.messages],
    events: [...older.events, ...newer.events],
    oldest: older.oldest,
    newest: newer.newest,
    boundary: mixBoundaries(older.boundary, newer.boundary),
    hasOlder: older.hasOlder,
    hasNewer: newer.hasNewer,
    before: older.stale ? null : older.before,
    after: newer.stale ? null : newer.after,
    stale: older.stale || newer.stale,
  };
}

/** Merge an authoritative page window into a retained window. Overlapping or
 *  anchored: the in-range reconcile (`mergeRows` per row type); disjoint
 *  (request-adjacent): coalesce by extent order. Returns null when the page
 *  fully replaces the window (zero anchors over a fully-covered extent — the
 *  post-epoch mass-replacement case). */
function mergePageIntoWindow(page: AgentFeedWindow, window: AgentFeedWindow): AgentFeedWindow | "replace" {
  const overlap = extentsOverlap(page.oldest, page.newest, window.oldest, window.newest);
  if (!overlap) {
    // Request-adjacent (the hook fetched this page through one of the
    // window's cursors): concatenate in extent order. A stale window's rows
    // are retained; the merged cursors follow the contributing edges.
    return compareAgentFeedOrderPositions(page.oldest, window.oldest) < 0
      ? coalesceWindows(page, window)
      : coalesceWindows(window, page);
  }

  const messages = mergeRows(
    { rows: page.messages, idOf: (m) => m.id, oldest: page.oldest, newest: page.newest },
    { rows: window.messages, idOf: (m) => m.id, oldest: window.oldest, newest: window.newest },
  );
  const events = mergeRows(
    { rows: page.events, idOf: (e) => e.id, oldest: page.oldest, newest: page.newest },
    { rows: window.events, idOf: (e) => e.id, oldest: window.oldest, newest: window.newest },
  );
  if (messages.anchors === 0 && events.anchors === 0) {
    // Overlapping extents, zero shared rows: every retained row in the
    // overlapped range was replaced. Only an epoch change can do that
    // (same-epoch writes keep ids) — the caller drops the window and keeps
    // the page as the authoritative replacement.
    return "replace";
  }

  // Edge facts come from whichever contributor REACHES the edge; on an exact
  // tie the fresh page wins — an equal-extent re-read revalidated that edge,
  // so its live cursor and coverage flags supersede the retained window's.
  const pageOwnsOldest = compareAgentFeedOrderPositions(page.oldest, window.oldest) <= 0;
  const pageOwnsNewest = compareAgentFeedOrderPositions(page.newest, window.newest) >= 0;
  const oldestSide = pageOwnsOldest ? page : window;
  const newestSide = pageOwnsNewest ? page : window;
  const retainedOutside = messages.retainedOutsideExtent || events.retainedOutsideExtent;
  return {
    messages: messages.rows,
    events: events.rows,
    oldest: oldestSide.oldest,
    newest: newestSide.newest,
    boundary: mixBoundaries(oldestSide.boundary, newestSide.boundary),
    hasOlder: oldestSide.hasOlder,
    hasNewer: newestSide.hasNewer,
    before: oldestSide.stale ? null : oldestSide.before,
    after: newestSide.stale ? null : newestSide.after,
    // Staleness survives only through retained rows outside the page extent;
    // a page that re-covered the window's whole extent revalidated it.
    stale: (window.stale || page.stale) && (retainedOutside || !overlap),
  };
}

// ─── Page application ────────────────────────────────────────────────────────

/** Options of {@link applyAgentFeedPage}. */
export interface AgentFeedApplyPageOptions {
  /** The window this page was fetched THROUGH (its `before`/`after` cursor) —
   *  request-adjacent by keyset construction, so it coalesces with the page
   *  even when the extents merely touch. */
  target?: AgentFeedWindow;
  /** Which coverage edge an EMPTY page (no rows) settles on the target:
   *  `"older"` (a `before` walk that reached the thread start — the target's
   *  `hasOlder` clears and its `before` cursor goes null) or `"newer"` (an
   *  `after` walk that reached the head). */
  emptyPageEdge?: "older" | "newer";
}

/**
 * Apply one authoritative feed page to the session state — THE reconcile
 * entry (Wave 3 item 2). Foreign-thread pages and pages from an epoch older
 * than the state's (late pre-bump results) are refused by returning the SAME
 * state reference; the hook's generation checks are the first line, this is
 * the pure safety net.
 *
 * A page carrying a NEWER epoch stales every window it does not touch (their
 * cursors are dead); `head`/`historyEpoch` always advance to the page's.
 */
export function applyAgentFeedPage(
  state: AgentFeedReconcileState,
  page: AgentFeedResponse,
  options: AgentFeedApplyPageOptions = {},
): AgentFeedReconcileState {
  if (page.threadId !== state.threadId) return state;
  if (state.historyEpoch !== null && page.historyEpoch < state.historyEpoch) return state;
  const epochBumped = state.historyEpoch !== null && page.historyEpoch > state.historyEpoch;

  const hasRows = page.messages.length > 0 || page.events.length > 0;
  // Contract: range.oldest/newest are non-null exactly when the page has rows.
  const pageWindow: AgentFeedWindow | null = hasRows
    ? {
        messages: page.messages,
        events: page.events,
        oldest: page.range.oldest!,
        newest: page.range.newest!,
        boundary: page.boundary,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        before: page.cursors.before,
        after: page.cursors.after,
        stale: false,
      }
    : null;

  const survivors: AgentFeedWindow[] = [];
  let merged: AgentFeedWindow | null = pageWindow;
  let droppedAny = false;

  for (const window of state.windows) {
    if (merged === null) {
      survivors.push(window);
      continue;
    }
    const isTarget = options.target !== undefined && window === options.target;
    const touches =
      isTarget ||
      extentsOverlap(merged.oldest, merged.newest, window.oldest, window.newest) ||
      sharesAnyRow(merged, window);
    if (!touches) {
      survivors.push(window);
      continue;
    }
    const result = mergePageIntoWindow(merged, window);
    if (result === "replace") {
      // The overlapped window's rows were wholesale replaced — drop it; the
      // page window itself carries the authoritative rows.
      droppedAny = true;
      continue;
    }
    merged = result;
  }

  let windows: AgentFeedWindow[];
  if (merged !== null) {
    windows = [...survivors, merged].sort((a, b) => compareAgentFeedOrderPositions(a.oldest, b.oldest));
  } else {
    // An empty page settles an edge on its target, if any (a before/after
    // walk that ran out of records — NOT an error and NOT an emptied feed).
    windows = survivors.map((window) => {
      if (options.target === undefined || window !== options.target || options.emptyPageEdge === undefined) {
        return window;
      }
      return options.emptyPageEdge === "older"
        ? { ...window, hasOlder: false, before: null }
        : { ...window, hasNewer: false, after: null };
    });
  }

  // An epoch bump invalidates every window the page did not touch: rows stay
  // for display, cursors die. Windows already stale keep their references.
  if (epochBumped) {
    windows = windows.map((window) =>
      window.stale || (merged !== null && window === merged)
        ? window
        : { ...window, stale: true, before: null, after: null },
    );
  }

  if (
    !epochBumped &&
    !droppedAny &&
    merged === null &&
    page.head === state.head &&
    page.historyEpoch === state.historyEpoch
  ) {
    // Nothing changed (an empty no-target page echoing the known facts).
    return state;
  }

  return {
    ...state,
    historyEpoch: page.historyEpoch,
    head: page.head,
    windows,
  };
}

/** True when the two windows share at least one row id of either type. */
function sharesAnyRow(a: AgentFeedWindow, b: AgentFeedWindow): boolean {
  for (const message of a.messages) if (b.messages.some((m) => m.id === message.id)) return true;
  for (const event of a.events) if (b.events.some((e) => e.id === event.id)) return true;
  return false;
}

// ─── Bridge planning (Wave 3 item 2's gap arithmetic) ────────────────────────

/** Where a settle-refresh must resume bridging: the FRESH head window (the
 *  newest non-stale window — it holds the just-read head) when the next
 *  fresh window below it does not connect to it, plus that head window's
 *  `before` cursor (fresh by construction — it arrived with the newest page).
 *  Null when fresh coverage is connected (or a single window): continuity is
 *  proven. Stale windows below never trigger a bridge — their ranges are
 *  display-retained suspects, not continuity anchors. */
export function agentFeedBridgeTarget(state: AgentFeedReconcileState): { window: AgentFeedWindow; cursor: string } | null {
  const fresh = state.windows.filter((window) => !window.stale);
  if (fresh.length < 2) return null;
  const head = fresh[fresh.length - 1]!;
  const below = fresh[fresh.length - 2]!;
  if (head.before === null || !head.hasOlder) return null;
  if (compareAgentFeedOrderPositions(head.oldest, below.newest) <= 0) return null; // connected (defensive — overlap merges already)
  return { window: head, cursor: head.before };
}

// ─── Typed stale outcome + local mutations ───────────────────────────────────

/**
 * Invalidate for a typed stale outcome (`AgentFeedStaleError`): adopt the
 * CURRENT epoch the outcome carried and stale every window — their cursors
 * were minted under a dead epoch. Rows stay for display until the
 * revalidation reads re-cover them; a no-op (same reference) when the state
 * already knows an epoch at least as new.
 */
export function staleAgentFeedWindows(state: AgentFeedReconcileState, currentEpoch: number): AgentFeedReconcileState {
  if (state.historyEpoch !== null && currentEpoch <= state.historyEpoch) return state;
  return {
    ...state,
    historyEpoch: currentEpoch,
    windows: state.windows.map((window) =>
      window.stale ? window : { ...window, stale: true, before: null, after: null },
    ),
  };
}

/** A locally-originated invalidating outcome the shell already knows — the
 *  same invalidation path a server-detected epoch change takes, carried to
 *  targets OUTSIDE the newest page too (Wave 3 item 2). */
export interface AgentFeedLocalMutation {
  /** Message rows the shell deleted (definite knowledge — removed now). */
  deletedMessageIds?: readonly string[];
  /** Event rows the shell deleted. */
  deletedEventIds?: readonly string[];
  /** Message rows the shell edited in place (ids kept, content changed
   *  server-side; the fresh text arrives through the next revalidating page). */
  editedMessageIds?: readonly string[];
}

/**
 * Apply a local edit/delete outcome: deleted rows leave their windows
 * immediately, and every window still holding a targeted row goes stale (its
 * cursors are dead under the epoch the write bumped server-side). Windows
 * holding no target keep their references untouched.
 */
export function applyAgentFeedLocalMutation(
  state: AgentFeedReconcileState,
  mutation: AgentFeedLocalMutation,
): AgentFeedReconcileState {
  const deletedMessages = new Set(mutation.deletedMessageIds ?? []);
  const deletedEvents = new Set(mutation.deletedEventIds ?? []);
  const edited = new Set(mutation.editedMessageIds ?? []);
  if (deletedMessages.size === 0 && deletedEvents.size === 0 && edited.size === 0) return state;

  let touched = false;
  const windows = state.windows.map((window) => {
    const messages = deletedMessages.size > 0 ? window.messages.filter((m) => !deletedMessages.has(m.id)) : window.messages;
    const events = deletedEvents.size > 0 ? window.events.filter((e) => !deletedEvents.has(e.id)) : window.events;
    const holdsTarget =
      messages.length !== window.messages.length ||
      events.length !== window.events.length ||
      window.messages.some((m) => edited.has(m.id));
    if (!holdsTarget) return window;
    touched = true;
    return { ...window, messages, events, stale: true, before: null, after: null };
  });
  if (!touched) return state;
  return { ...state, windows };
}

// ─── Read-side helpers ───────────────────────────────────────────────────────

/** The flattened model input over every covered window: messages and events
 *  concatenated in window order (each window is internally ordered; windows
 *  are ordered by extent). The HOOK memoizes on the state's identity — this
 *  helper itself allocates. */
export function agentFeedFlattened(state: AgentFeedReconcileState): {
  messages: ExperienceCopilotMessageWire[];
  events: AgentFeedEventSummary[];
} {
  const messages: ExperienceCopilotMessageWire[] = [];
  const events: AgentFeedEventSummary[] = [];
  for (const window of state.windows) {
    messages.push(...window.messages);
    events.push(...window.events);
  }
  return { messages, events };
}

/** The oldest loaded message id — the revalidation anchor when the oldest
 *  window is stale and `loadOlder` must re-read a bounded neighborhood
 *  before it can page further into history. */
export function agentFeedOldestMessageId(state: AgentFeedReconcileState): string | null {
  return state.windows[0]?.messages[0]?.id ?? null;
}

/** True when `loadOlder` can page right now: an oldest window that is fresh,
 *  claims older records exist, and carries a live cursor for them. A stale
 *  or cursor-less oldest window routes through `loadAround` revalidation
 *  first (the hook owns that decision). */
export function agentFeedCanLoadOlder(state: AgentFeedReconcileState): boolean {
  const oldest = state.windows[0];
  if (oldest === undefined || oldest.stale) return false;
  return oldest.hasOlder && oldest.before !== null;
}
