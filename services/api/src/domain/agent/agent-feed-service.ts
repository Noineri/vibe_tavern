/**
 * Agent-feed domain projection (AGENT_FEED_PERFORMANCE_PLAN, Wave 2 /
 * AFP-10) — the pure API-domain layer between the DB read seam (AFP-9:
 * `readAgentFeedPage` / `readAgentEventDetail` raw facts) and the HTTP
 * adapter/routes (AFP-11). Owns exactly what the AFP-9 log assigned to this
 * unit: shared frozen validation, lightweight summary/detail projection,
 * complete UI boundary decisions and cursor encoding.
 *
 * Layering decisions:
 * - Message WIRE mapping is NOT here: the arch gate forbids new domain→api/
 *   dependencies, so `toMessageWire` stays in the adapter layer and AFP-11
 *   maps the store messages this layer returns (one derivation, unchanged).
 *   Everything else on the response IS wire-shaped — summaries, boundary,
 *   cursors, epoch/head/range come back ready for the coherent read.
 * - Cursor ENCODING (base64url JSON of the AFP-7 payload contract) is owned
 *   by this module — the single server-side derivation. AFP-11 routes echo
 *   strings; it never re-encodes.
 * - Frozen validation runs through the EXISTING shared parser
 *   (`mapTimelineEvent`, sidechat-timeline-payloads.ts — the same parsers
 *   the context loader and compaction service run). No second validator;
 *   the row's `payloadValid` SQL fact is only a cheap pre-check.
 *
 * Boundary projection notes (AFP-9 raw facts → wire decisions):
 * - `turnOpenerMessageId` is RANGE-scoped (the user row opening the turn the
 *   page start sits inside); `lastUserMessageId` is THREAD-scoped (the
 *   thread's newest user row — the AP-9 regenerate anchor, knowable while
 *   reading old history without loading it). The AFP-7 schema doc for the
 *   latter was corrected in this unit to match this projection.
 * - `startsMidTurn` = the turn opener sits strictly before the page start
 *   (an event-only gap below the cut counts — the opener row itself is an
 *   older record of that turn).
 * - The digest anchor tri-state does NOT disambiguate WHICH SIDE an
 *   `unloaded` anchor sits on; `unloadedOlderCount`/`hasNewer` cover the
 *   common cases and AFP-15 owns the web-side fallback — widen the contract
 *   there if a gate proves it needs the side.
 */

import {
  AGENT_EVENT_DETAIL_PAGE_ITEMS,
  AGENT_FEED_CURSOR_VERSION,
  agentEventDetailCursorPayloadSchema,
  agentFeedCursorPayloadSchema,
  agentFeedDefaultLimit,
  resolveAgentFeedMode,
} from "@vibe-tavern/api-contracts";
import type {
  AgentEventDetailCursorPayload,
  AgentEventDetailResponse,
  AgentFeedBoundary,
  AgentFeedCursorPayload,
  AgentFeedEventSummary,
  AgentFeedOrderPosition,
  AgentFeedQuery,
} from "@vibe-tavern/api-contracts";
import {
  compareAgentFeedPositions,
} from "@vibe-tavern/db";
import type {
  AgentEventDetailRequest,
  AgentEventDetailResult,
  AgentFeedBoundaryFacts,
  AgentFeedEventRecord,
  AgentFeedPageRequest,
  AgentFeedPageResult,
  AgentThreadContextEventKind,
  ExperienceCopilotMessage,
  ExperienceCopilotStore,
} from "@vibe-tavern/db";
import { brandId } from "@vibe-tavern/domain";
import type {
  AgentThreadContextEventId,
  ExperienceCopilotThreadId,
} from "@vibe-tavern/domain";
import { conflict, notFound, unprocessable, validation } from "../../shared/errors.js";
import { mapTimelineEvent } from "../sidechat/sidechat-timeline-payloads.js";
import type { MappedAgentTimelineEvent } from "../sidechat/sidechat-timeline-payloads.js";

/** The stores this service touches — a `Pick` so tests and callers pass the
 *  narrow seam instead of a whole container (the SidechatEventsDeps
 *  convention). */
export interface AgentFeedServiceDeps {
  readonly store: Pick<ExperienceCopilotStore, "readFeedPage" | "readEventDetail">;
}

/** The projected feed page — the coherent wire read minus the message wire
 *  mapping (AFP-11's adapter runs `toMessageWire` over `messages`). */
export interface AgentFeedPage {
  readonly threadId: string;
  readonly historyEpoch: number;
  readonly head: AgentFeedOrderPosition | null;
  readonly range: { readonly oldest: AgentFeedOrderPosition | null; readonly newest: AgentFeedOrderPosition | null };
  readonly messages: readonly ExperienceCopilotMessage[];
  readonly events: readonly AgentFeedEventSummary[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly cursors: { readonly before: string | null; readonly after: string | null };
  readonly boundary: AgentFeedBoundary;
}

// ─── Cursor codec (the one server-side encoding derivation) ──────────────────

/** Opaque cursor token: base64url of the JSON payload. Clients echo it and
 *  never decode it; only this module and the tests know the format. */
function encodeCursorToken(payload: AgentFeedCursorPayload | AgentEventDetailCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decode a cursor token's raw JSON, refusing malformed input as a typed 400
 *  (never guess another era's encoding — the payload schema checks the
 *  version literal next). */
function decodeCursorToken(raw: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw validation(`${what} is not a valid cursor token.`);
  }
}

function decodeFeedCursor(raw: string): AgentFeedCursorPayload {
  const parsed = agentFeedCursorPayloadSchema.safeParse(decodeCursorToken(raw, "The feed cursor"));
  if (!parsed.success) {
    throw validation(`The feed cursor payload failed its contract (${parsed.error.issues[0]?.message ?? "unknown issue"}).`);
  }
  return parsed.data;
}

function decodeDetailCursor(raw: string): AgentEventDetailCursorPayload {
  const parsed = agentEventDetailCursorPayloadSchema.safeParse(decodeCursorToken(raw, "The event detail cursor"));
  if (!parsed.success) {
    throw validation(`The event detail cursor payload failed its contract (${parsed.error.issues[0]?.message ?? "unknown issue"}).`);
  }
  return parsed.data;
}

// ─── Feed page projection ─────────────────────────────────────────────────────

/**
 * Read one coherent feed page for the wire query (AFP-7 contract): resolves
 * the mode/limit from the policy source, decodes the opaque cursor, runs the
 * AFP-9 seam and projects raw facts onto the wire shapes. Typed outcomes are
 * DomainErrors AFP-11 maps: missing thread/`aroundMessageId` → 404, a
 * malformed or foreign cursor → 400 validation, an epoch-invalidated window
 * → 409 carrying `AGENT_FEED_STALE_WINDOW` + the CURRENT epoch (the client
 * revalidates its neighborhood + newest state, never silently restarts).
 */
export async function loadAgentFeedPage(
  deps: AgentFeedServiceDeps,
  threadId: string,
  query: AgentFeedQuery,
): Promise<AgentFeedPage> {
  const mode = resolveAgentFeedMode(query);
  const limit = query.limit ?? agentFeedDefaultLimit(mode);
  let request: AgentFeedPageRequest;
  if (mode === "around") {
    if (query.aroundMessageId === undefined) {
      throw new Error("resolveAgentFeedMode and agentFeedQuerySchema disagree on the around mode");
    }
    request = { mode, limit, messageId: query.aroundMessageId };
  } else if (mode === "before" || mode === "after") {
    const raw = mode === "before" ? query.before : query.after;
    if (raw === undefined) {
      throw new Error("resolveAgentFeedMode and agentFeedQuerySchema disagree on the cursor mode");
    }
    request = { mode, limit, cursor: decodeFeedCursor(raw) };
  } else {
    request = { mode: "newest", limit };
  }
  const result = await deps.store.readFeedPage(threadId, request);
  // The AFP-9 result's refusal member carries a multi-literal status, so the
  // members cannot be peeled off one by one — gate on `ready` positively and
  // exhaust the refusal statuses in order instead (no casts).
  if (result.status !== "ready") {
    if (result.status === "stale-window") {
      throw conflict(
        `The requested feed window no longer matches thread '${threadId}'s history epoch; revalidate the newest page.`,
        { code: "AGENT_FEED_STALE_WINDOW", historyEpoch: result.historyEpoch },
      );
    }
    if (result.status === "missing-thread") {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    if (result.status === "missing-message") {
      throw notFound("ExperienceCopilotMessage", `Message '${request.mode === "around" ? request.messageId : "?"}' was not found in thread '${threadId}'.`);
    }
    throw validation(`The feed cursor does not belong to thread '${threadId}' (or names a foreign thread).`);
  }
  return projectFeedPage(result);
}

function projectFeedPage(result: Extract<AgentFeedPageResult, { status: "ready" }>): AgentFeedPage {
  const oldest = result.records[0]?.position ?? null;
  const newest = result.records.at(-1)?.position ?? null;
  const messages: ExperienceCopilotMessage[] = [];
  const events: AgentFeedEventSummary[] = [];
  for (const record of result.records) {
    if (record.record === "message") {
      messages.push(record.message);
    } else {
      events.push(projectEventSummary(record));
    }
  }
  return {
    threadId: result.thread.id,
    historyEpoch: result.historyEpoch,
    head: result.head,
    range: { oldest, newest },
    messages,
    events,
    hasOlder: result.hasOlder,
    hasNewer: result.hasNewer,
    cursors: {
      before: result.hasOlder
        ? encodeCursorToken(cursorPayload(result.thread.id, result.historyEpoch, oldest ?? result.resumePosition, "before"))
        : null,
      after: result.hasNewer
        ? encodeCursorToken(cursorPayload(result.thread.id, result.historyEpoch, newest ?? result.resumePosition, "after"))
        : null,
    },
    boundary: projectBoundary(result.boundary, oldest, newest),
  };
}

function cursorPayload(
  threadId: string,
  epoch: number,
  position: AgentFeedOrderPosition | null,
  edge: "before" | "after",
): AgentFeedCursorPayload {
  if (position === null) {
    // Every encode path guarantees a non-null anchor: hasOlder/hasNewer is
    // only true with either a page position or the resume position.
    throw new Error(`Agent feed ${edge} cursor issued without a resumable position`);
  }
  return { v: AGENT_FEED_CURSOR_VERSION, threadId, epoch, position };
}

/**
 * One frozen event's lightweight summary (AFP-9 SQL facts → the AFP-7 wire
 * union). Payload-derived facts stay null when the payload is corrupt or a
 * scalar has the wrong type; `detailAvailable` is the SQL facts' verdict on
 * whether the detail route can serve the event (deep shape corruption that
 * SQL cannot see still surfaces on OPEN as the typed corrupt outcome).
 * An unknown stored kind is refused loudly, exactly like the events route —
 * never silently dropped.
 */
function projectEventSummary(record: AgentFeedEventRecord): AgentFeedEventSummary {
  const { kind, facts } = record;
  const base = {
    id: record.position.id,
    seq: record.position.seq,
    createdAt: record.position.createdAt,
    beforeMessageId: record.beforeMessageId,
  };
  switch (kind) {
    case "rp_sync":
      return {
        ...base,
        kind,
        fromPosition: facts.fromPosition,
        toPosition: facts.toPosition,
        messageCount: facts.messageCount,
        detailAvailable: facts.payloadValid
          && facts.fromPosition !== null && facts.toPosition !== null && facts.messageCount !== null,
      };
    case "variants_attached":
      return {
        ...base,
        kind,
        position: facts.position,
        variantCount: facts.variantCount,
        detailAvailable: facts.payloadValid && facts.position !== null && facts.variantCount !== null,
      };
    case "selection_changed":
      return {
        ...base,
        kind,
        position: facts.position,
        messageId: facts.messageId,
        detailAvailable: facts.payloadValid && facts.position !== null && facts.messageId !== null,
      };
    case "branch_forked":
      return {
        ...base,
        kind,
        at: facts.at,
        detailAvailable: facts.payloadValid && facts.at !== null,
      };
    case "profile_changed":
      return {
        ...base,
        kind,
        fromLabel: facts.fromName,
        toLabel: facts.toName,
        detailAvailable: facts.payloadValid
          && facts.fromId !== null && facts.fromName !== null && facts.toId !== null && facts.toName !== null,
      };
    default:
      throw unprocessable(
        `Agent feed event '${record.position.id}' has unknown stored kind '${kind}' — refusing to project a corrupted row`,
        { code: "AGENT_EVENT_CORRUPT" },
      );
  }
}

/** Raw boundary facts → the wire boundary block (see the module header for
 *  the range-scoped vs thread-scoped decisions). */
function projectBoundary(
  facts: AgentFeedBoundaryFacts,
  oldest: AgentFeedOrderPosition | null,
  newest: AgentFeedOrderPosition | null,
): AgentFeedBoundary {
  const startsMidTurn = oldest !== null
    && facts.turnOpener !== null
    && compareAgentFeedPositions(facts.turnOpener, oldest) < 0;
  const lastDigest = facts.digests.last;
  let lastAnchor: AgentFeedBoundary["digest"]["lastAnchor"] = null;
  if (lastDigest !== null) {
    if (lastDigest.anchorId === null || lastDigest.anchorPosition === null) {
      lastAnchor = "dangling";
    } else if (
      oldest !== null && newest !== null
      && compareAgentFeedPositions(lastDigest.anchorPosition, oldest) >= 0
      && compareAgentFeedPositions(lastDigest.anchorPosition, newest) <= 0
    ) {
      lastAnchor = "loaded";
    } else {
      lastAnchor = "unloaded";
    }
  }
  return {
    startsMidTurn,
    endsMidTurn: facts.nextMessage !== null && facts.nextMessage.role !== "user",
    turnOpenerMessageId: facts.turnOpener?.id ?? null,
    continuedToolCalls: facts.continuedToolCalls.map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
    lastUserMessageId: facts.lastUser?.id ?? null,
    digest: {
      totalInThread: facts.digests.total,
      unloadedOlderCount: facts.digests.older,
      lastAnchor,
    },
  };
}

// ─── Frozen-event detail ──────────────────────────────────────────────────────

type ReadyDetail = Extract<AgentEventDetailResult, { status: "ready" }>;

/**
 * One frozen event's immutable DETAIL (Wave 2 item 6): first page with no
 * cursor, continuation via the previous response's `nextCursor`; page size
 * is the policy constant. The slice's payload is re-validated through the
 * SHARED frozen parser before serving (deep shape corruption → the typed
 * 422 `AGENT_EVENT_CORRUPT`); a frozen body never references today's RP
 * text — later edits/deletes of other rows only move the epoch, making old
 * CURSORS stale while fresh no-cursor reads keep serving the same snapshot.
 */
export async function loadAgentEventDetail(
  deps: AgentFeedServiceDeps,
  threadId: string,
  eventId: string,
  cursor?: string,
): Promise<AgentEventDetailResponse> {
  const request: AgentEventDetailRequest = {
    limit: AGENT_EVENT_DETAIL_PAGE_ITEMS,
    ...(cursor !== undefined ? { cursor: decodeDetailCursor(cursor) } : {}),
  };
  const result = await deps.store.readEventDetail(threadId, eventId, request);
  // Same multi-literal refusal member as the feed read: gate on `ready`
  // positively, then exhaust the refusal statuses (no casts).
  if (result.status !== "ready") {
    if (result.status === "stale-window") {
      throw conflict(
        `The detail cursor for event '${eventId}' no longer matches thread '${threadId}'s history epoch.`,
        { code: "AGENT_EVENT_CURSOR_STALE", historyEpoch: result.historyEpoch },
      );
    }
    if (result.status === "missing-thread") {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    if (result.status === "missing-event") {
      throw notFound("AgentThreadContextEvent", `Event '${eventId}' was not found in thread '${threadId}'.`);
    }
    if (result.status === "corrupt") {
      throw unprocessable(
        `The frozen event '${eventId}' payload is not valid JSON of its kind — refusing to serve corrupted frozen context.`,
        { code: "AGENT_EVENT_CORRUPT" },
      );
    }
    throw validation(`The event detail cursor is malformed or does not belong to event '${eventId}' of thread '${threadId}'.`);
  }
  const mapped = validateFrozenSlice(threadId, result);
  return projectDetailPage(result, mapped);
}

/** Run the shared frozen parser over the sliced payload. The synthetic entry
 *  carries neutral seq/createdAt: the detail read returns neither, and the
 *  parser only uses them inside corrupt-refusal messages. The kind cast is
 *  safe — the store seam already refused unknown kinds as `corrupt`. */
function validateFrozenSlice(threadId: string, result: ReadyDetail): MappedAgentTimelineEvent {
  try {
    return mapTimelineEvent(threadId, {
      id: brandId<AgentThreadContextEventId>(result.eventId),
      threadId: brandId<ExperienceCopilotThreadId>(threadId),
      seq: null,
      createdAt: "",
      kind: result.kind as AgentThreadContextEventKind,
      payload: result.payload,
    });
  } catch (err) {
    throw unprocessable(
      `The frozen event '${result.eventId}' payload is not its frozen shape (${err instanceof Error ? err.message : String(err)}) — refusing to serve corrupted frozen context.`,
      { code: "AGENT_EVENT_CORRUPT" },
    );
  }
}

/** `Omit` over the detail union must DISTRIBUTE per kind arm — the builtin
 *  Omit collapses a union to its shared keys and would reject the arm fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function projectDetailPage(result: ReadyDetail, mapped: MappedAgentTimelineEvent): AgentEventDetailResponse {
  const identity = { threadId: result.threadId, eventId: result.eventId, epoch: result.historyEpoch };
  let body: DistributiveOmit<AgentEventDetailResponse, "nextCursor">;
  let itemCount = 0;
  switch (mapped.kind) {
    case "rp_sync":
      itemCount = mapped.payload.messages.length;
      body = {
        ...identity,
        kind: mapped.kind,
        fromPosition: mapped.payload.fromPosition,
        toPosition: mapped.payload.toPosition,
        offset: result.offset,
        messages: mapped.payload.messages.map((message) => ({ ...message })),
      };
      break;
    case "variants_attached":
      itemCount = mapped.payload.variants.length;
      body = {
        ...identity,
        kind: mapped.kind,
        position: mapped.payload.position,
        offset: result.offset,
        variants: mapped.payload.variants.map((variant) => ({ ...variant })),
      };
      break;
    case "selection_changed":
      body = {
        ...identity,
        kind: mapped.kind,
        position: mapped.payload.position,
        messageId: mapped.payload.messageId,
        previous: { ...mapped.payload.previous },
        current: { ...mapped.payload.current },
      };
      break;
    case "branch_forked":
      body = { ...identity, kind: mapped.kind, at: mapped.payload.at };
      break;
    case "profile_changed":
      body = {
        ...identity,
        kind: mapped.kind,
        from: { ...mapped.payload.from },
        to: { ...mapped.payload.to },
      };
      break;
    case "rp_summary":
      // SC-6: summary events are NEVER stored (summaries render live from
      // coverage) — a stored row reaching this arm is corruption; refuse
      // loudly like the events route, never serve an unstorable kind.
      throw unprocessable(
        `Frozen event '${result.eventId}' mapped to rp_summary — summary events are never stored (SC-6); refusing to serve a corrupted row`,
        { code: "AGENT_EVENT_CORRUPT" },
      );
    default: {
      // The mapped union is closed (the five stored kinds); this arm is
      // compile-time-only and keeps `body` definitely assigned.
      const exhaustive: never = mapped;
      throw new Error(`projectDetailPage: unmapped frozen event kind '${String(exhaustive)}'`);
    }
  }
  return {
    ...body,
    nextCursor: result.hasMore
      ? encodeCursorToken({
        v: AGENT_FEED_CURSOR_VERSION,
        threadId: result.threadId,
        eventId: result.eventId,
        epoch: result.historyEpoch,
        offset: result.offset + itemCount,
      })
      : null,
  };
}
