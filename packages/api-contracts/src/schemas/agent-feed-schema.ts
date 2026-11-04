/**
 * Agent-feed wire contracts (AGENT_FEED_PERFORMANCE_PLAN, Wave 2 / AFP-7) —
 * the ADDITIVE paged-read + lazy frozen-detail schemas behind
 *
 *   GET  /api/agent/threads/:threadId/feed
 *   GET  /api/agent/threads/:threadId/events/:eventId
 *
 * Both routes are additions: the legacy full-list reads
 * (`GET /api/experience-copilot/:threadId/messages`,
 * `GET /api/agent/threads/:threadId/events`) stay byte-identical for every
 * existing consumer, and `listMessages`/`listTimeline` semantics for prompt
 * assembly, compaction and replay are untouched — mounted render rows,
 * fetched UI history and model context remain three separate windows.
 *
 * Response schemas here are DESCRIPTIONS of the server's output (the
 * repo's wire convention — `agent-thread-event-schema.ts`), never a second
 * parser: nothing on the response path validates through them. The tests
 * pin their shapes and the documented invariants so AFP-9/10/11 implement
 * against a fixed contract.
 */

import { z } from "zod";
import {
  AGENT_FEED_CURSOR_VERSION,
  AGENT_FEED_INITIAL_RECORDS,
  AGENT_FEED_OLDER_RECORDS,
  AGENT_FEED_SERVER_MAX_RECORDS,
} from "../agent-feed-policy.js";
import { experienceCopilotMessageSchema } from "./experience-copilot-schema.js";
import {
  branchForkedPayloadSchema,
  profileChangedPayloadSchema,
  rpSyncPayloadSchema,
  selectionChangedPayloadSchema,
  variantsAttachedPayloadSchema,
} from "./agent-thread-event-schema.js";

// ─── Ordering position + page cursor (Wave 2 item 2) ─────────────────────────

/**
 * The full ordering position of ONE primary record on the merged timeline —
 * the keyset coordinate. Ordering is the canonical comparator
 * (`compareTimelineEntries`, packages/db — SC-1): seq ascending with the
 * legacy NULL-seq prefix first, then createdAt, then id; `record` names the
 * table the id lives in (the comparator never compares ids across tables,
 * but a resumed read needs to know which store to seek). Responses expose
 * positions so consumers order ranges WITHOUT decoding the opaque cursors —
 * never invent a UUID-chronological or OFFSET interpretation of this field.
 */
export const agentFeedOrderPositionSchema = z
  .object({
    record: z.enum(["message", "event"]),
    seq: z.number().int().nullable(),
    createdAt: z.string(),
    id: z.string(),
  })
  .strict();
export type AgentFeedOrderPosition = z.infer<typeof agentFeedOrderPositionSchema>;

/**
 * The decoded form of an opaque feed page cursor. On the wire cursors are
 * opaque versioned strings the client echoes back — it never decodes them;
 * the encode/decode derivation lives server-side (AFP-9/10). This schema is
 * the contract of what a cursor MUST carry:
 * - `v` — the cursor version (`AGENT_FEED_CURSOR_VERSION`); any other value
 *   is malformed, refused instead of guessed.
 * - `threadId` + `epoch` — OWNERSHIP identity: a cursor replayed against
 *   another thread is rejected, and an epoch the server cannot resolve by
 *   position yields the explicit stale-window outcome — never a silent
 *   restart at newest (Wave 2 item 2).
 * - `position` — the complete keyset position the page resumes from; a
 *   cursor whose named row was DELETED is still resolvable from this
 *   position (keyset, not row-existence).
 */
export const agentFeedCursorPayloadSchema = z
  .object({
    v: z.literal(AGENT_FEED_CURSOR_VERSION),
    threadId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    position: agentFeedOrderPositionSchema,
  })
  .strict();
export type AgentFeedCursorPayload = z.infer<typeof agentFeedCursorPayloadSchema>;

// ─── Feed request query (Wave 2 item 1) ──────────────────────────────────────

/**
 * Query of `GET /api/agent/threads/:threadId/feed`. FOUR mutually exclusive
 * modes: newest (the default — no paging param), `before` (the older page
 * ending just before the cursor position), `after` (the newer page starting
 * just after it — settle bridging), `aroundMessageId` (one bounded
 * neighborhood of a message — the later search plan's seam; it never reads
 * every page from the beginning). `limit` bounds the primary records of the
 * response; string-first coercion follows the run-query sibling
 * (`experienceCopilotRunQuerySchema.after` — Hono query params are strings)
 * and the bound is 1..server-max: out-of-range values are rejected, never
 * clamped. Per-mode DEFAULTS are resolved from the policy (see
 * {@link agentFeedDefaultLimitForMode}) — the schema itself carries none.
 */
export const agentFeedQuerySchema = z
  .object({
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    aroundMessageId: z.string().min(1).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(AGENT_FEED_SERVER_MAX_RECORDS))
      .optional(),
  })
  .superRefine((val, ctx) => {
    const modes: string[] = [];
    if (val.before !== undefined) modes.push("`before`");
    if (val.after !== undefined) modes.push("`after`");
    if (val.aroundMessageId !== undefined) modes.push("`aroundMessageId`");
    if (modes.length > 1) {
      ctx.addIssue({
        code: "custom",
        message:
          `Feed paging modes are mutually exclusive — got ${modes.join(" + ")}; ` +
          "use exactly one of `before` (older page), `after` (newer page) or " +
          "`aroundMessageId` (bounded neighborhood), or none for the newest page.",
      });
    }
  });
export type AgentFeedQuery = z.infer<typeof agentFeedQuerySchema>;

/** The resolved feed mode — one derivation shared by the domain and routes. */
export type AgentFeedMode = "newest" | "before" | "after" | "around";

/**
 * Resolve which mode a PARSED feed query asks for. The query schema's
 * superRefine has already guaranteed at most one paging param, so this
 * switch is total. Routes/domain call this helper instead of re-deriving
 * mode presence from raw params (one derivation — the wire contract is the
 * single source of the mode vocabulary).
 */
export function resolveAgentFeedMode(query: AgentFeedQuery): AgentFeedMode {
  if (query.before !== undefined) return "before";
  if (query.after !== undefined) return "after";
  if (query.aroundMessageId !== undefined) return "around";
  return "newest";
}

/**
 * The default primary-record target of one mode, from the policy source:
 * newest/default windows `AGENT_FEED_INITIAL_RECORDS`; every paged mode
 * (older, bridge, around) pages `AGENT_FEED_OLDER_RECORDS`. Technical
 * targets — the server may return MORE when the canonical comparator
 * refuses to split a coherent unit, and never less-than-requested history
 * silently.
 */
export function agentFeedDefaultLimit(mode: AgentFeedMode): number {
  return mode === "newest" ? AGENT_FEED_INITIAL_RECORDS : AGENT_FEED_OLDER_RECORDS;
}

// ─── Lightweight event summaries (Wave 2 item 5) ─────────────────────────────

/**
 * Base of every event-summary arm: identity, ordering coordinates and
 * detail availability — common to all five stored kinds.
 */
const agentFeedEventSummaryBase = z
  .object({
    id: z.string(),
    // The event's own ordering coordinates (the canonical comparator's
    // seq/createdAt/id triple) — relative order among events, and against
    // range positions, is computable without decoding cursors.
    seq: z.number().int().nullable(),
    createdAt: z.string(),
    // Placement anchor: the FIRST message after this event on the FULL
    // merged timeline (exactly what the events route computes today);
    // null ONLY when the event is the thread's newest row. The anchor may
    // name a message OUTSIDE the loaded page — that is an UNLOADED anchor,
    // never a dangling one, and an old event must not be moved to the
    // bottom because its anchor is not loaded (the plan's named defect).
    beforeMessageId: z.string().nullable(),
    // False when the stored payload is corrupt: every payload-derived field
    // below is null then, and the detail route answers the corrupt outcome
    // instead of a body.
    detailAvailable: z.boolean(),
  })
  .strict();

/**
 * One frozen context event as the FEED response carries it: kind, ordering/
 * placement, counts, frozen profile labels and detail availability — NEVER
 * RP texts or variant bodies (Wave 2 item 5). The frozen body loads only
 * through the detail route. This is structural: no arm has a free-text RP
 * field — the only strings beyond identifiers are the two profile LABELS
 * frozen at write time. Payload-derived facts are NULL under corruption
 * (SQL-side safe malformed-JSON projection); events page in the SAME
 * logical range as messages, including event-only intervals and trailing
 * events.
 */
export const agentFeedEventSummarySchema = z.discriminatedUnion("kind", [
  agentFeedEventSummaryBase.extend({
    kind: z.literal("rp_sync"),
    fromPosition: z.number().nullable(),
    toPosition: z.number().nullable(),
    messageCount: z.number().int().nonnegative().nullable(),
  }),
  agentFeedEventSummaryBase.extend({
    kind: z.literal("variants_attached"),
    position: z.number().nullable(),
    variantCount: z.number().int().nonnegative().nullable(),
  }),
  agentFeedEventSummaryBase.extend({
    kind: z.literal("selection_changed"),
    position: z.number().nullable(),
    messageId: z.string().nullable(),
  }),
  agentFeedEventSummaryBase.extend({
    kind: z.literal("branch_forked"),
    at: z.number().nullable(),
  }),
  agentFeedEventSummaryBase.extend({
    kind: z.literal("profile_changed"),
    fromLabel: z.string().nullable(),
    toLabel: z.string().nullable(),
  }),
]);
export type AgentFeedEventSummary = z.infer<typeof agentFeedEventSummarySchema>;

// ─── Boundary context (Wave 2 item 4) ─────────────────────────────────────────

/**
 * Boundary metadata of ONE returned page: the facts that keep a page cut
 * from corrupting turn state. The server prefers closing pages at
 * user-turn boundaries; when it cannot (an arbitrarily long tools-only turn
 * must not become an unbounded response), it returns this context instead —
 * incomplete content is explicitly loadable as a continuation, never
 * silently treated as a complete turn, and ask/reasoning/tool state must
 * not change when adjacent pages arrive.
 */
export const agentFeedBoundarySchema = z
  .object({
    // True when older primary records of the turn the range START sits
    // inside exist beyond the cut. When true, `turnOpenerMessageId` is
    // non-null (the cut is a continuation, not a turn start).
    startsMidTurn: z.boolean(),
    // True when newer records of the range-end turn exist beyond the cut.
    // Always false in newest mode — the thread head closes the range.
    endsMidTurn: z.boolean(),
    // The USER row that opened the turn the range start sits inside (null
    // at a clean turn boundary or an event-only interval) — turn identity
    // for captions/digest placement at the cut.
    turnOpenerMessageId: z.string().nullable(),
    // Tool-result rows inside the page whose tool-CALL row is OLDER than
    // the cut: the accordion's pair is split by the PAGE, not by deletion.
    // `toolName` is frozen from the call row (null when its stored JSON no
    // longer parses) so the card can render its header without the call.
    continuedToolCalls: z
      .array(
        z
          .object({
            toolCallId: z.string().min(1),
            toolName: z.string().nullable(),
          })
          .strict(),
      ),
    // The THREAD's newest user row (null when the thread has none) —
    // "last-user identity", the regenerate/edit boundary anchor: a windowed
    // page reading old history still learns which row the thread's last
    // turn regenerates from (AP-9) without loading it. The RANGE-scoped
    // twin ("last user at-or-before the page start") is
    // `turnOpenerMessageId` — the two facts coincide only on head pages.
    lastUserMessageId: z.string().nullable(),
    // Digest coverage FACTS independent of loaded anchors — the contract
    // fix for the conservative missing-anchor fallback that today treats
    // an unloaded anchor as dangling (`agent-flow-boundaries.ts`, the
    // plan's named defect):
    // - `totalInThread` / `unloadedOlderCount`: digests are counted
    //   thread-wide; absence from the page is windowing, NOT deletion.
    // - `lastAnchor`: the state of the LAST digest's anchor (the id in its
    //   `toolCallId`): "loaded" (inside the page), "unloaded" (exists,
    //   outside the page) or "dangling" (names no row server-side — the
    //   conservative end placement legitimately applies). Null when the
    //   thread has no digest.
    digest: z
      .object({
        totalInThread: z.number().int().nonnegative(),
        unloadedOlderCount: z.number().int().nonnegative(),
        lastAnchor: z.enum(["loaded", "unloaded", "dangling"]).nullable(),
      })
      .strict(),
  })
  .strict();
export type AgentFeedBoundary = z.infer<typeof agentFeedBoundarySchema>;

// ─── Feed response (Wave 2 item 1) ────────────────────────────────────────────

/**
 * The ONE coherent read of `GET /api/agent/threads/:threadId/feed`:
 * ordered messages + lightweight event summaries of the same logical range,
 * range positions, adjacent-page cursors, coverage flags, epoch + head
 * watermark, and boundary metadata — one request, no implicit whole-thread
 * download.
 *
 * Documented invariants (fixture-pinned by the contract test; the schema
 * itself stays a description, per the wire convention):
 * - `cursors.before` is non-null IFF `hasOlder`; `cursors.after` non-null
 *   IFF `hasNewer`.
 * - `range.oldest`/`range.newest` are null exactly when the page is empty.
 * - `boundary.startsMidTurn` implies a non-null `turnOpenerMessageId`.
 * - A deleted cursor is resolved from its POSITION by the server; when the
 *   epoch invalidated the window instead, the typed stale-window outcome
 *   below is returned — never a silent restart at newest.
 */
export const agentFeedResponseSchema = z
  .object({
    // Thread identity echo: a session-switching client verifies it never
    // stitched rows across threads.
    threadId: z.string(),
    // Bumped by invalidating writes — message edit/delete/attachment
    // update, event rewrite/delete, non-tail insertion (the store/write
    // boundary covers compaction, regenerate and background-run
    // persistence; a timestamp-only `updatedAt` is NOT a revision).
    historyEpoch: z.number().int().nonnegative(),
    // The thread's newest primary record at read time — the suffix-append
    // watermark. Pure suffix appends move `head` WITHOUT bumping
    // historyEpoch (older pages stay valid); a client bridging up to
    // `head` has continuity. Null on an empty thread.
    head: agentFeedOrderPositionSchema.nullable(),
    // The returned page's own extent (null on an empty page) — overlap and
    // gap arithmetic against retained state, without decoding cursors.
    range: z
      .object({
        oldest: agentFeedOrderPositionSchema.nullable(),
        newest: agentFeedOrderPositionSchema.nullable(),
      })
      .strict(),
    // The SAME per-message wire the legacy array route serves
    // (`experienceCopilotMessageSchema`), oldest → newest.
    messages: z.array(experienceCopilotMessageSchema),
    // Event summaries in the same logical range — event-only intervals and
    // trailing events included.
    events: z.array(agentFeedEventSummarySchema),
    // Coverage relative to the WHOLE thread, independent of which pages
    // the client holds.
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    // Opaque versioned keyset cursors for the adjacent pages (decoded
    // form: `agentFeedCursorPayloadSchema`).
    cursors: z
      .object({
        before: z.string().nullable(),
        after: z.string().nullable(),
      })
      .strict(),
    boundary: agentFeedBoundarySchema,
  })
  .strict();
export type AgentFeedResponse = z.infer<typeof agentFeedResponseSchema>;

/**
 * The explicit stale-window outcome (Wave 2 item 2): the requested window
 * cannot be resolved against the current history epoch (e.g. a non-tail
 * rewrite removed the cursor's neighborhood). Served as the typed 409
 * (Conflict family — AFP-11 maps DomainError kinds to HTTP); carries the
 * CURRENT epoch so the client revalidates its retained reading neighborhood
 * plus newest state, instead of indiscriminately dropping every old page on
 * a normal append.
 */
export const agentFeedStaleWindowErrorSchema = z.object({
  error: z.string(),
  code: z.literal("AGENT_FEED_STALE_WINDOW"),
  historyEpoch: z.number().int().nonnegative(),
});
export type AgentFeedStaleWindowError = z.infer<typeof agentFeedStaleWindowErrorSchema>;

// ─── Frozen-event detail (Wave 2 item 6) ──────────────────────────────────────

// Element/member schemas reused from the events route's frozen payload
// derivation (one derivation, never a second parser). Some payloads are
// wrapped in `.readonly()` (zod wrapper types, not plain objects), so
// `.unwrap()` reaches the object/array before `.shape`/`.element`.
const rpSyncMessageElement = rpSyncPayloadSchema.shape.messages.element;
const attachedVariantElement = variantsAttachedPayloadSchema.unwrap().shape.variants.unwrap().element;
const variantSelectionSchema = selectionChangedPayloadSchema.shape.previous;
const branchForkedAtSchema = branchForkedPayloadSchema.unwrap().shape.at;
const profileSideSchema = profileChangedPayloadSchema.unwrap().shape.from;

/**
 * Query of `GET /api/agent/threads/:threadId/events/:eventId`. The first
 * detail page is requested with NO cursor (opening a summary fetches only
 * its first page); continuation pages echo the previous response's
 * `nextCursor`. Page size is policy-owned
 * (`AGENT_EVENT_DETAIL_PAGE_ITEMS`) — clients do not choose it.
 */
export const agentEventDetailQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
});
export type AgentEventDetailQuery = z.infer<typeof agentEventDetailQuerySchema>;

/**
 * The decoded form of a detail cursor: ownership (thread + event + epoch)
 * plus the slice `offset` into the frozen array (rp_sync messages /
 * attached variants). An epoch mismatch (an event rewrite bumped
 * historyEpoch under the cursor) is the stale outcome, never a silently
 * restarted slice.
 */
export const agentEventDetailCursorPayloadSchema = z
  .object({
    v: z.literal(AGENT_FEED_CURSOR_VERSION),
    threadId: z.string().min(1),
    eventId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export type AgentEventDetailCursorPayload = z.infer<typeof agentEventDetailCursorPayloadSchema>;

/**
 * Base of every detail-response arm: ownership echo, the immutable
 * event/version key and the continuation cursor.
 */
const agentEventDetailBase = z
  .object({
    threadId: z.string(),
    eventId: z.string(),
    // The immutable event/version key (Wave 2 item 6): events never change,
    // but a REWRITE (which bumps historyEpoch) invalidates cached detail —
    // the shared detail cache keys by thread/event/version/detail-cursor
    // (Wave 3 item 4). This is the epoch AT READ TIME.
    epoch: z.number().int().nonnegative(),
    // The next slice's cursor; null when the frozen body is complete. The
    // small kinds are atomic single pages (always null there).
    nextCursor: z.string().nullable(),
  })
  .strict();

/**
 * One frozen event's immutable DETAIL, paged (Wave 2 item 6). A large
 * `rp_sync` body carries bounded slices of its frozen messages, and
 * `variants_attached` slices its variants, so one separator with thousands
 * of RP messages does not defeat windowing; `selection_changed` /
 * `branch_forked` / `profile_changed` are small atomic payloads. The item
 * schemas REUSE the events route's frozen payload derivation
 * (`agent-thread-event-schema.ts` — one derivation of every frozen shape,
 * never a second parser). A frozen event remains the exact historical
 * snapshot even after source edit/swipe/deletion — no reference back to
 * today's RP message text; full legacy reads and prompt assembly still
 * receive the exact original snapshot.
 */
export const agentEventDetailResponseSchema = z.discriminatedUnion("kind", [
  agentEventDetailBase.extend({
    kind: z.literal("rp_sync"),
    fromPosition: z.number(),
    toPosition: z.number(),
    offset: z.number().int().nonnegative(),
    messages: z.array(rpSyncMessageElement),
  }),
  agentEventDetailBase.extend({
    kind: z.literal("variants_attached"),
    position: z.number(),
    offset: z.number().int().nonnegative(),
    variants: z.array(attachedVariantElement),
  }),
  agentEventDetailBase.extend({
    kind: z.literal("selection_changed"),
    position: z.number(),
    messageId: z.string(),
    previous: variantSelectionSchema,
    current: variantSelectionSchema,
  }),
  agentEventDetailBase.extend({
    kind: z.literal("branch_forked"),
    at: branchForkedAtSchema,
  }),
  agentEventDetailBase.extend({
    kind: z.literal("profile_changed"),
    from: profileSideSchema,
    to: profileSideSchema,
  }),
]);
export type AgentEventDetailResponse = z.infer<typeof agentEventDetailResponseSchema>;

/** The typed detail-error codes — explicit outcomes (Wave 2 item 6). */
export const AGENT_EVENT_DETAIL_ERROR_CODES = [
  // 404: missing thread, or the event does not exist IN THIS THREAD
  // (wrong-thread ids never leak cross-thread existence — the read is
  // scoped to the owning thread).
  "AGENT_EVENT_NOT_FOUND",
  // 422: the stored payload is not the frozen shape — the same refusal
  // `mapTimelineEvent` raises for the loader, surfaced as a typed outcome
  // instead of a body.
  "AGENT_EVENT_CORRUPT",
  // 409: the detail cursor's epoch no longer matches (an event rewrite
  // bumped historyEpoch under the cursor); carries the current epoch.
  "AGENT_EVENT_CURSOR_STALE",
] as const;
export type AgentEventDetailErrorCode = (typeof AGENT_EVENT_DETAIL_ERROR_CODES)[number];

/**
 * Body of a typed detail error. Authentication and thread access are
 * preserved by the existing app-level mapping — these codes are additive
 * typed bodies, not a parallel auth story.
 */
export const agentEventDetailErrorSchema = z.object({
  error: z.string(),
  code: z.enum(AGENT_EVENT_DETAIL_ERROR_CODES),
  historyEpoch: z.number().int().nonnegative().optional(),
});
export type AgentEventDetailError = z.infer<typeof agentEventDetailErrorSchema>;
