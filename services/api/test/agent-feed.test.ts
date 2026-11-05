import { describe, expect, test } from "bun:test";
import {
  agentThreadContextEvents,
  createStoreContainer,
  experienceCopilotMessages,
  experienceCopilotThreads,
  type StoreContainer,
} from "@vibe-tavern/db";
import { agentFeedResponseSchema } from "@vibe-tavern/api-contracts";
import type { Hono } from "hono";
import { AgentFeedAdapter } from "../src/api/adapters/agent-feed-adapter.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { createApp } from "../src/server/app-factory.js";

// AFP-11 L1: (1) relative imports only, no absolute/out-of-repo paths;
// (2) no global/env/registry mutations — each app is created per fixture and
// the container DBs close through the suite's preload sweep; (3) resolved-
// state assertions on committed responses, no sleeps; (4) fixed ids/
// timestamps, no OS/order assumptions; (5) real Hono app + real adapters over
// real template-backed container DBs (T1: no doubles at all — the app factory
// is the seam); (6) invariant reads at rest; (7) fresh in-memory container
// per fixture, no migration subjects.
//
// The pair under test is mounted through the REAL app factory (middleware,
// app-level DomainError mapping, api router) — AFP-11's self-check: real
// route/adapter/DB isolation, coherent response, auth/404/409/limit/detail.

const NOW = "2026-11-05T12:00:00.000Z";

type Db = StoreContainer["db"];

interface FeedWire {
  threadId: string;
  historyEpoch: number;
  head: { id: string } | null;
  range: { oldest: { id: string } | null; newest: { id: string } | null };
  messages: Array<{ id: string; role: string; content: string }>;
  events: Array<{ id: string; kind: string; detailAvailable: boolean } & Record<string, unknown>>;
  hasOlder: boolean;
  hasNewer: boolean;
  cursors: { before: string | null; after: string | null };
  boundary: { startsMidTurn: boolean; lastUserMessageId: string | null };
}

async function setup(options: { mobileAccessToken?: string } = {}) {
  const stores = await createStoreContainer(":memory:");
  // The partial runtime follows the attachment-routes precedent: every route
  // module is mounted (real composition), only the slices this suite requests
  // are backed by real adapters over the SAME container.
  const runtime = {
    agentFeed: new AgentFeedAdapter(stores),
    experienceCopilot: new ExperienceCopilotAdapter(stores),
  } as RuntimeApi;
  const app = await createApp(
    options.mobileAccessToken === undefined
      ? { runtime }
      : { runtime, mobileAccessToken: options.mobileAccessToken },
  );
  return { stores, db: stores.db, app };
}

function msg(id: string, seq: number, role: string, extra: Partial<{ content: string; toolCallsJson: string | null; toolCallId: string | null }> = {}) {
  return { id, threadId: "t1", seq, createdAt: ts(seq), role, content: extra.content ?? `body-${id}`, toolCallsJson: extra.toolCallsJson ?? null, toolCallId: extra.toolCallId ?? null };
}
function evt(id: string, seq: number, kind: string, payloadJson: string) {
  return { id, threadId: "t1", seq, createdAt: ts(seq), kind, payloadJson };
}
function rpMessage(i: number) {
  return { id: `rp-${i}`, position: i, role: i % 2 ? "assistant" : "user", authorName: null, variantId: null, model: null, preset: null, text: `captured-${i}` };
}

/** Distinct per-seq timestamps (a real thread's rows never share one): the
 *  legacy route orders by createdAt+id while the feed orders by seq — equal
 *  only when the two agree, which is the honest parity premise. */
function ts(seq: number): string {
  return new Date(Date.parse(NOW) + seq * 1000).toISOString();
}

/** The interleaved fixture: one tools-only turn + a small rp_sync event + a
 *  clean second turn (the AFP-10 boundary fixture, now served over HTTP). */
function seedFeedThread(db: Db) {
  db.insert(experienceCopilotThreads).values([
    { id: "t1", createdAt: NOW, updatedAt: NOW },
    { id: "t2", createdAt: NOW, updatedAt: NOW },
  ]).run();
  db.insert(experienceCopilotMessages).values([
    msg("u1", 0, "user"),
    msg("c1", 1, "assistant", { content: "", toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: "tc-1", toolName: "plan", input: {} }]) }),
    msg("r1", 2, "tool", { toolCallId: "tc-1" }),
    msg("a1", 3, "assistant"),
    msg("u2", 5, "user"),
    msg("a2", 6, "assistant"),
  ]).run();
  db.insert(agentThreadContextEvents).values([
    evt("ev1", 4, "rp_sync", JSON.stringify({
      fromPosition: 0,
      toPosition: 1,
      messages: [rpMessage(0), rpMessage(1)],
    })),
    evt("ev-big", 7, "rp_sync", JSON.stringify({
      fromPosition: 0,
      toPosition: 54,
      messages: Array.from({ length: 55 }, (_, i) => rpMessage(i)),
    })),
    evt("ev-fork", 8, "branch_forked", JSON.stringify({ at: 3 })),
    // JSON-invalid payload: the summary must say detailAvailable=false and the
    // detail route must refuse with the typed corrupt outcome (never a body).
    evt("ev-corrupt", 9, "rp_sync", '{"fromPosition": '),
  ]).run();
  // A foreign thread's event for the wrong-thread detail pin.
  db.insert(agentThreadContextEvents).values([
    { ...evt("ev-foreign", 0, "branch_forked", JSON.stringify({ at: 0 })), threadId: "t2" },
  ]).run();
}

function feed(app: Hono, threadId = "t1", query = "") {
  return app.request(`http://localhost/api/agent/threads/${threadId}/feed${query}`);
}
function detail(app: Hono, eventId: string, query = "", threadId = "t1") {
  return app.request(`http://localhost/api/agent/threads/${threadId}/events/${eventId}${query}`);
}

describe("GET /api/agent/threads/:threadId/feed (AFP-11)", () => {
  test("coherent newest page: schema-valid, echo + coverage + boundary facts, summary without frozen bodies", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);

    const response = await feed(app);
    expect(response.status).toBe(200);
    const body = await response.json();
    // The WHOLE response parses against the AFP-7 wire contract.
    expect(agentFeedResponseSchema.parse(body)).toEqual(body);
    const page = body as FeedWire;
    expect(page.threadId).toBe("t1");
    // The whole thread fits the initial window: full coverage, no cursors.
    expect(page.messages.map((m) => m.id)).toEqual(["u1", "c1", "r1", "a1", "u2", "a2"]);
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(false);
    expect(page.cursors).toEqual({ before: null, after: null });
    expect(page.head?.id).toBe("ev-corrupt"); // newest primary record (a trailing event)
    expect(page.range.newest?.id).toBe("ev-corrupt");
    expect(page.range.oldest?.id).toBe("u1");
    expect(page.boundary.startsMidTurn).toBe(false);
    expect(page.boundary.lastUserMessageId).toBe("u2");
    // Event summaries page in the same logical range — counts and placement,
    // never the frozen bodies.
    expect(page.events.map((e) => e.id)).toEqual(["ev1", "ev-big", "ev-fork", "ev-corrupt"]);
    const ev1 = page.events[0]!;
    expect(ev1.kind).toBe("rp_sync");
    expect(ev1.detailAvailable).toBe(true);
    expect(ev1.messageCount).toBe(2);
    expect(ev1.fromPosition).toBe(0);
    expect(ev1.beforeMessageId).toBe("u2"); // the first message row after the event
    expect(Object.keys(ev1).sort()).toEqual([
      "beforeMessageId", "createdAt", "detailAvailable", "fromPosition", "id", "kind", "messageCount", "seq", "toPosition",
    ]);
    expect(page.events[3]!.detailAvailable).toBe(false);
  });

  test("limit + before/after paging over HTTP: complete backward walk, no dups or gaps, after-cursor bridges forward", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);

    const first = await (await feed(app, "t1", "?limit=2")).json() as FeedWire;
    // The two NEWEST primary records are the trailing events — an event-only
    // newest window is a legitimate feed page (trailing events are never
    // moved to the bottom), so the newest page here carries no messages.
    expect(first.messages).toEqual([]);
    expect(first.events.map((e) => e.id)).toEqual(["ev-fork", "ev-corrupt"]);
    expect(first.cursors.before).not.toBeNull();
    expect(first.cursors.after).toBeNull();

    // Walk every older page to the true end (the first page's own rows count
    // toward the coverage set — the walk only collects what follows below).
    const seenMessages: string[] = [];
    const seenEvents: string[] = [...first.events.map((e) => e.id)];
    let cursor = first.cursors.before;
    for (let i = 0; i < 10 && cursor !== null; i += 1) {
      const response = await feed(app, "t1", `?before=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(200);
      const page = await response.json() as FeedWire;
      seenMessages.push(...page.messages.map((m) => m.id));
      seenEvents.push(...page.events.map((e) => e.id));
      cursor = page.cursors.before;
    }
    expect(cursor).toBeNull(); // the walk ended at the true oldest end
    // Exactly the seeded rows, each exactly once — no duplicates, no gaps.
    expect([...seenMessages].sort()).toEqual(["a1", "a2", "c1", "r1", "u1", "u2"]);
    expect([...seenEvents].sort()).toEqual(["ev-big", "ev-corrupt", "ev-fork", "ev1"]);

    // A mid-history page's after cursor bridges forward to the newest head
    // (paged modes default to the policy's 40 older records — bound explicitly
    // to keep the pin about the bridge, not the page size).
    const mid = await (await feed(app, "t1", `?before=${encodeURIComponent(first.cursors.before!)}&limit=2`)).json() as FeedWire;
    expect(mid.messages.map((m) => m.id)).toEqual(["a2"]);
    expect(mid.events.map((e) => e.id)).toEqual(["ev-big"]);
    expect(mid.hasNewer).toBe(true);
    expect(mid.cursors.after).not.toBeNull();
    const bridged = await (await feed(app, "t1", `?after=${encodeURIComponent(mid.cursors.after!)}&limit=2`)).json() as FeedWire;
    expect(bridged.messages).toEqual([]);
    expect(bridged.events.map((e) => e.id)).toEqual(["ev-fork", "ev-corrupt"]);
    expect(bridged.hasNewer).toBe(false);
  });

  test("query validation is the route's edge: limit bounds, non-numeric limit and mixed modes are 400", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);
    for (const query of ["?limit=0", "?limit=201", "?limit=abc", "?before=x&after=y", "?after=y&aroundMessageId=u1"]) {
      const response = await feed(app, "t1", query);
      expect(response.status).toBe(400);
      expect((await response.json() as { success?: boolean }).success).toBe(false);
    }
  });

  test("a missing thread is the 404 sibling outcome (feed and detail alike)", async () => {
    const { app } = await setup();
    const feedResponse = await feed(app, "never_born_afp11");
    expect(feedResponse.status).toBe(404);
    const feedBody = await feedResponse.json() as { error: { kind: string; resource?: string } };
    expect(feedBody.error.kind).toBe("NotFound");
    expect(feedBody.error.resource).toBe("ExperienceCopilotThread");

    const detailResponse = await detail(app, "ev1", "", "never_born_afp11");
    expect(detailResponse.status).toBe(404);
    expect(((await detailResponse.json()) as { error: { kind: string } }).error.kind).toBe("NotFound");
  });

  test("an invalidating sibling write turns the old cursor into the typed 409 with the CURRENT epoch", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);

    const first = await (await feed(app, "t1", "?limit=2")).json() as FeedWire;
    // A sibling writer (NOT the store API) edits an old loaded message — the
    // AFP-8 trigger must bump the epoch for ANY writer.
    db.$client.run("UPDATE experience_copilot_messages SET content = 'edited' WHERE thread_id = ? AND id = ?", ["t1", "u1"]);
    const response = await feed(app, "t1", `?before=${encodeURIComponent(first.cursors.before!)}`);
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { kind: string; details?: { code?: string; historyEpoch?: number } } };
    expect(body.error.kind).toBe("Conflict");
    expect(body.error.details?.code).toBe("AGENT_FEED_STALE_WINDOW");
    expect(body.error.details?.historyEpoch).toBe(first.historyEpoch + 1);
  });

  test("malformed and foreign cursors are 400 Validation, never a silent restart", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);
    const malformed = await feed(app, "t1", "?before=not-a-cursor");
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: { kind: string } }).error.kind).toBe("Validation");

    // A cursor OWNED by t2 replayed against t1: ownership, not position.
    const t2Page = await (await feed(app, "t2")).json() as FeedWire;
    expect(t2Page.cursors.before).toBeNull(); // t2 holds no primary records
    // Build the foreign cursor from t1's real cursor position but t2's id:
    // decoding is server-side, so craft it through the service's own format.
    const t1Page = await (await feed(app, "t1", "?limit=2")).json() as FeedWire;
    const payload = JSON.parse(Buffer.from(t1Page.cursors.before!, "base64url").toString("utf8")) as Record<string, unknown>;
    const foreign = Buffer.from(JSON.stringify({ ...payload, threadId: "t2" }), "utf8").toString("base64url");
    const response = await feed(app, "t1", `?before=${encodeURIComponent(foreign)}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { kind: string } }).error.kind).toBe("Validation");
  });
});

describe("GET /api/agent/threads/:threadId/events/:eventId (AFP-11)", () => {
  test("a 55-message rp_sync serves 50 + 5 through the policy page size, then ends", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);

    const first = await detail(app, "ev-big");
    expect(first.status).toBe(200);
    const page1 = await first.json() as {
      threadId: string; eventId: string; epoch: number; kind: string; offset: number;
      messages: Array<{ id: string }>; nextCursor: string | null;
    };
    expect(page1.kind).toBe("rp_sync");
    expect(page1.threadId).toBe("t1");
    expect(page1.eventId).toBe("ev-big");
    expect(page1.offset).toBe(0);
    expect(page1.messages).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();

    const second = await detail(app, "ev-big", `?cursor=${encodeURIComponent(page1.nextCursor!)}`);
    expect(second.status).toBe(200);
    const page2 = await second.json() as typeof page1;
    expect(page2.offset).toBe(50);
    expect(page2.messages).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
  });

  test("a small kind is one atomic page; a wrong-thread event id is 404, never a cross-thread body", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);

    const atomic = await detail(app, "ev-fork");
    expect(atomic.status).toBe(200);
    const body = await atomic.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["at", "epoch", "eventId", "kind", "nextCursor", "threadId"]);
    expect(body.at).toBe(3);
    expect(body.nextCursor).toBeNull();

    const foreign = await detail(app, "ev-foreign");
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { kind: string; resource?: string } }).error.resource).toBe("AgentThreadContextEvent");

    const missing = await detail(app, "never_born_event");
    expect(missing.status).toBe(404);
  });

  test("a corrupt frozen payload is the typed 422; a malformed detail cursor is 400", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);

    const corrupt = await detail(app, "ev-corrupt");
    expect(corrupt.status).toBe(422);
    const corruptBody = await corrupt.json() as { error: { kind: string; details?: { code?: string } } };
    expect(corruptBody.error.kind).toBe("Unprocessable");
    expect(corruptBody.error.details?.code).toBe("AGENT_EVENT_CORRUPT");

    const malformed = await detail(app, "ev-fork", "?cursor=zzz");
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: { kind: string } }).error.kind).toBe("Validation");
  });
});

describe("AFP-11 app-level integration", () => {
  test("the pair sits behind the existing mobile-token auth like every /api/* route", async () => {
    const { db, app } = await setup({ mobileAccessToken: "feed-token" });
    seedFeedThread(db);
    // app.request carries no requestIP, so the client is untrusted-remote:
    // the middleware must protect the new pair exactly like the rest.
    const denied = await feed(app);
    expect(denied.status).toBe(401);
    const detailDenied = await detail(app, "ev-fork");
    expect(detailDenied.status).toBe(401);

    const wrong = await app.request("http://localhost/api/agent/threads/t1/feed", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);

    const allowed = await app.request("http://localhost/api/agent/threads/t1/feed", {
      headers: { Authorization: "Bearer feed-token" },
    });
    expect(allowed.status).toBe(200);
  });

  test("the legacy full-list messages route is untouched and wire-identical to the feed page", async () => {
    const { db, app } = await setup();
    seedFeedThread(db);

    const legacyResponse = await app.request("http://localhost/api/experience-copilot/t1/messages");
    expect(legacyResponse.status).toBe(200);
    const legacy = await legacyResponse.json() as Array<Record<string, unknown>>;
    // The legacy array stays exactly the messages (no events, no seq, no feed
    // fields leaked backward).
    expect(legacy.map((m) => m.id).sort()).toEqual(["a1", "a2", "c1", "r1", "u1", "u2"]);

    const feedPage = await (await feed(app)).json() as { messages: Array<Record<string, unknown>> };
    // The SAME per-message wire the legacy route serves — one toMessageWire
    // derivation, observable at both routes over the same rows.
    expect(feedPage.messages).toEqual(legacy);
  });
});
