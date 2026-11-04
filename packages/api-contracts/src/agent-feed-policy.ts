/**
 * Agent-feed windowing + lazy-detail policy (AGENT_FEED_PERFORMANCE_PLAN,
 * Wave 2 / AFP-7) — the ONE shared source of the paging numbers every layer
 * reads: the domain/routes (AFP-10/11) resolve defaults and caps from here,
 * the web feed state (Wave 3) reads the same targets, and the contract tests
 * pin them. No other module hand-writes these numbers — a second derivation
 * is a defect from copy #2 (AGENTS.md §3).
 *
 * These are TECHNICAL TARGETS, not permission to cut a turn or silently
 * truncate text (plan, Wave 2 item 1): the server prefers closing a page at
 * a user-turn boundary and returns boundary context when it cannot — it never
 * drops or splits away records to fit a number. Stored history and model
 * context (`listMessages` / `listTimeline` semantics) are never truncated by
 * these limits: mounted render rows, fetched UI history and model context
 * stay three separate windows.
 */

/** Default primary-record target of the newest/default feed mode — the
 *  initial window `GET /api/agent/threads/:threadId/feed` serves when the
 *  request carries no `limit`. "Primary record" = one merged-timeline row:
 *  a message OR a frozen context event. */
export const AGENT_FEED_INITIAL_RECORDS = 100;

/** Default primary-record target of every paged mode (`before`, `after`,
 *  `aroundMessageId`) — the load-older, bridge-newer and around-target page
 *  size. `aroundMessageId` is the later search plan's seam and reads one
 *  bounded neighborhood, never every page from the beginning. */
export const AGENT_FEED_OLDER_RECORDS = 40;

/** Hard wire ceiling on the feed `limit` query parameter. A request above it
 *  is REJECTED by the contract (400), never silently clamped. */
export const AGENT_FEED_SERVER_MAX_RECORDS = 200;

/** Version stamped into every opaque feed/detail cursor. A cursor carrying a
 *  different version is malformed — the server refuses it instead of
 *  guessing the encoding of another era. `as const` keeps the LITERAL type
 *  non-widening so `z.literal(...)` and object-literal fixtures stay `1`,
 *  not `number`. */
export const AGENT_FEED_CURSOR_VERSION = 1 as const;

/** Shared event-detail cache bounds (consumed by Wave 3's
 *  `agent-event-detail-cache.ts`): at most 32 retained detail pages / 2 MiB
 *  of captured bytes. Oversized pages still RENDER — eviction just does not
 *  retain them beyond active use (plan, Wave 3 item 4). */
export const AGENT_EVENT_DETAIL_CACHE_MAX_ENTRIES = 32;
export const AGENT_EVENT_DETAIL_CACHE_MAX_BYTES = 2 * 1024 * 1024;

/** Maximum frozen-body items (rp_sync messages, attached variants) one detail
 *  page carries; `nextCursor` continues the rest. AFP-7's one named addition
 *  beside the plan's numbers: Wave 2 item 6 requires "bounded slices" of a
 *  large frozen body but fixes no page number — this is that bound, owned
 *  here so it changes in exactly one place. */
export const AGENT_EVENT_DETAIL_PAGE_ITEMS = 50;
