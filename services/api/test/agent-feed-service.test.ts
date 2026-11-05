import { describe, expect, test } from "bun:test";
import {
  agentThreadContextEvents,
  createStoreContainer,
  experienceCopilotMessages,
  experienceCopilotThreads,
  ExperienceCopilotStore,
} from "@vibe-tavern/db";
import type { AgentEventDetailRequest, AgentEventDetailResult, AgentFeedPageRequest, AgentFeedPageResult } from "@vibe-tavern/db";
import { agentFeedQuerySchema } from "@vibe-tavern/api-contracts";
import { DomainError, isDomainError } from "../src/shared/errors.js";
import { loadAgentEventDetail, loadAgentFeedPage, type AgentFeedServiceDeps } from "../src/domain/agent/agent-feed-service.js";

// AFP-10 L1: (1) relative imports only, no absolute/out-of-repo paths;
// (2) no global/env/registry mutations — the container DB closes through the
// suite's preload sweep; (3) resolved-state assertions on committed reads,
// no sleeps; (4) fixed timestamps/ids, no OS/order assumptions; (5) real
// store container (template-backed) + one narrow T1 stub deps for
// request-building pins, no module mocks; (6) invariant reads at rest;
// (7) fresh in-memory container per fixture, no migration subjects.
//
// Every feed query enters through the AFP-7 wire schema (exactly what
// AFP-11's zValidator produces from HTTP): the service consumes the PARSED
// AgentFeedQuery, never raw query strings.

const NOW = "2026-11-04T12:00:00.000Z";

type Db = Awaited<ReturnType<typeof createStoreContainer>>["db"];

async function setup() {
  const stores = await createStoreContainer(":memory:");
  const db = stores.db;
  db.insert(experienceCopilotThreads).values([
    { id: "t1", createdAt: NOW, updatedAt: NOW },
    { id: "t2", createdAt: NOW, updatedAt: NOW },
  ]).run();
  const store = new ExperienceCopilotStore(db);
  return { db, deps: { store } satisfies AgentFeedServiceDeps };
}

/** The wire entry point: raw query-string shaped input → parsed AgentFeedQuery. */
function q(raw: Record<string, string> = {}) {
  return agentFeedQuerySchema.parse(raw);
}

function msg(id: string, seq: number, role: string, extra: Partial<{ content: string; toolCallsJson: string | null; toolCallId: string | null }> = {}) {
  return { id, threadId: "t1", seq, createdAt: NOW, role, content: extra.content ?? `body-${id}`, toolCallsJson: extra.toolCallsJson ?? null, toolCallId: extra.toolCallId ?? null };
}
function evt(id: string, seq: number, kind: string, payloadJson: string) {
  return { id, threadId: "t1", seq, createdAt: NOW, kind, payloadJson };
}
function rpMessage(i: number) {
  return { id: `rp-${i}`, position: i, role: i % 2 ? "assistant" : "user", authorName: null, variantId: null, model: null, preset: null, text: `captured-${i}` };
}
// Raw sibling-writer mutations (not the store's API): the AFP-8 epoch
// triggers must fire for ANY writer, which is exactly what these pin.
function editMessage(db: Db, id: string) {
  db.$client.run("UPDATE experience_copilot_messages SET content = 'edited' WHERE thread_id = ? AND id = ?", ["t1", id]);
}
function deleteMessage(db: Db, id: string) {
  db.$client.run("DELETE FROM experience_copilot_messages WHERE thread_id = ? AND id = ?", ["t1", id]);
}

async function rejects(fn: () => Promise<unknown>): Promise<DomainError> {
  try {
    await fn();
  } catch (err) {
    expect(isDomainError(err)).toBe(true);
    return err as DomainError;
  }
  throw new Error("Expected the call to reject");
}

/** A long tools-only turn: user → tool-call row → tool result → tail, then a
 *  second turn — the AFP-10 self-check's "long turn, tool pairs across cut". */
function seedToolsTurn(db: Db) {
  db.insert(experienceCopilotMessages).values([
    msg("u1", 0, "user"),
    msg("c1", 1, "assistant", { content: "", toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: "tc-1", toolName: "plan", input: {} }]) }),
    msg("r1", 2, "tool", { toolCallId: "tc-1" }),
    msg("a1", 3, "assistant"),
    msg("u2", 4, "user"),
    msg("a2", 5, "assistant"),
  ]).run();
}

describe("AFP-10 boundary decisions", () => {
  test("AFP-15 profile summaries preserve IDs for the shared builtin-name formatter", async () => {
    const { db, deps } = await setup();
    db.insert(agentThreadContextEvents).values(evt("profile", 1, "profile_changed", JSON.stringify({
      from: { id: "builtin", name: "Frozen OOC" }, to: { id: "builtin-director", name: "Frozen Director" },
    }))).run();
    const page = await loadAgentFeedPage(deps, "t1", q());
    expect(page.events[0]).toMatchObject({ fromId: "builtin", toId: "builtin-director", fromLabel: "Frozen OOC", toLabel: "Frozen Director" });
  });
  test("AFP-15 page facts carry unloaded anchor coordinates and complete digest counts", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([
      msg("u", 0, "user"), msg("a", 1, "assistant"), msg("b", 2, "assistant"),
      msg("d1", 3, "digest", { toolCallId: "a" }),
      msg("c", 4, "assistant"), msg("d2", 5, "digest", { toolCallId: "c" }),
    ]).run();
    const page = await loadAgentFeedPage(deps, "t1", q({ limit: "1" }));
    expect(page.boundary.pageFacts).toMatchObject({
      lastUserPosition: { id: "u", seq: 0 }, lastDigestAnchorPosition: { id: "c", seq: 4 },
      messagePositions: [{ id: "d2", seq: 5 }], digestCounts: [{ id: "d2", coveredCount: 2 }],
    });
    const older = await loadAgentFeedPage(deps, "t1", q({ aroundMessageId: "u", limit: "1" }));
    expect(older.boundary.pageFacts?.lastDigestAnchorPosition?.id).toBe("c");
    expect(older.boundary.pageFacts?.digestCounts).toEqual([]);
    const first = await loadAgentFeedPage(deps, "t1", q({ aroundMessageId: "d1", limit: "1" }));
    expect(first.boundary.pageFacts?.digestCounts).toEqual([{ id: "d1", coveredCount: 1 }]);
  });
  test("a page cut inside a long tools-only turn: mid-turn flags, split tool pair, thread-wide last user", async () => {
    const { db, deps } = await setup();
    seedToolsTurn(db);
    const page = await loadAgentFeedPage(deps, "t1", q({ aroundMessageId: "r1", limit: "1" }));
    expect(page.messages.map((m) => m.id)).toEqual(["r1"]);
    expect(page.boundary.startsMidTurn).toBe(true);
    expect(page.boundary.endsMidTurn).toBe(true); // a1 (assistant) follows the cut inside the same turn
    expect(page.boundary.turnOpenerMessageId).toBe("u1");
    expect(page.boundary.lastUserMessageId).toBe("u2"); // THREAD-scoped: newer than the whole page
    expect(page.boundary.continuedToolCalls).toEqual([{ toolCallId: "tc-1", toolName: "plan" }]);
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(true);
    expect(page.cursors.before).not.toBeNull();
    expect(page.cursors.after).not.toBeNull();
  });

  test("a clean head page starts at a user row: no partial-turn flags, no after cursor", async () => {
    const { db, deps } = await setup();
    seedToolsTurn(db);
    const page = await loadAgentFeedPage(deps, "t1", q({ limit: "2" }));
    expect(page.messages.map((m) => m.id)).toEqual(["u2", "a2"]);
    expect(page.boundary.startsMidTurn).toBe(false);
    expect(page.boundary.endsMidTurn).toBe(false);
    expect(page.boundary.turnOpenerMessageId).toBe("u2");
    expect(page.boundary.lastUserMessageId).toBe("u2");
    expect(page.boundary.continuedToolCalls).toEqual([]);
    expect(page.hasNewer).toBe(false);
    expect(page.cursors.after).toBeNull();
    expect(page.cursors.before).not.toBeNull();
  });

  test("digest anchor tri-state: unloaded below the page, loaded inside it, dangling after anchor deletion", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([
      msg("u1", 0, "user"),
      msg("a1", 1, "assistant"),
      msg("dg1", 2, "digest", { content: "compacted", toolCallId: "a1" }),
      msg("u2", 3, "user"),
      msg("a2", 4, "assistant"),
    ]).run();
    const head = await loadAgentFeedPage(deps, "t1", q({ limit: "2" }));
    expect(head.boundary.digest).toEqual({ totalInThread: 1, unloadedOlderCount: 1, lastAnchor: "unloaded" });

    const aroundAnchor = await loadAgentFeedPage(deps, "t1", q({ aroundMessageId: "a1", limit: "3" }));
    expect(aroundAnchor.boundary.digest.lastAnchor).toBe("loaded");

    deleteMessage(db, "a1");
    const afterDelete = await loadAgentFeedPage(deps, "t1", q({ limit: "2" }));
    expect(afterDelete.boundary.digest.lastAnchor).toBe("dangling");
    expect(afterDelete.historyEpoch).toBeGreaterThan(head.historyEpoch); // the deletion invalidated the epoch
  });

  test("an empty thread answers a zeroed coherent page", async () => {
    const { deps } = await setup();
    const page = await loadAgentFeedPage(deps, "t2", q());
    expect(page.messages).toEqual([]);
    expect(page.events).toEqual([]);
    expect(page.head).toBeNull();
    expect(page.range).toEqual({ oldest: null, newest: null });
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(false);
    expect(page.cursors).toEqual({ before: null, after: null });
    expect(page.boundary).toEqual({
      pageFacts: { lastUserPosition: null, lastDigestAnchorPosition: null, firstAssistantMessageId: null, messagePositions: [], digestCounts: [] },
      startsMidTurn: false,
      endsMidTurn: false,
      turnOpenerMessageId: null,
      continuedToolCalls: [],
      lastUserMessageId: null,
      digest: { totalInThread: 0, unloadedOlderCount: 0, lastAnchor: null },
    });
  });
});

describe("AFP-10 cursor lifecycle", () => {
  test("opaque cursors round-trip through older/newer traversal to the true ends", async () => {
    const { db, deps } = await setup();
    seedToolsTurn(db);
    const newest = await loadAgentFeedPage(deps, "t1", q({ limit: "2" })); // u2, a2
    if (newest.cursors.before === null) throw new Error("expected an older cursor");
    const middle = await loadAgentFeedPage(deps, "t1", q({ before: newest.cursors.before, limit: "2" })); // r1, a1
    expect(middle.messages.map((m) => m.id)).toEqual(["r1", "a1"]);
    if (middle.cursors.before === null || middle.cursors.after === null) throw new Error("expected both cursors");
    const oldest = await loadAgentFeedPage(deps, "t1", q({ before: middle.cursors.before, limit: "2" })); // u1, c1
    expect(oldest.messages.map((m) => m.id)).toEqual(["u1", "c1"]);
    expect(oldest.hasOlder).toBe(false);
    expect(oldest.cursors.before).toBeNull();
    const bridged = await loadAgentFeedPage(deps, "t1", q({ after: middle.cursors.after, limit: "40" }));
    expect(bridged.messages.map((m) => m.id)).toEqual(["u2", "a2"]);
    expect(bridged.hasNewer).toBe(false);
  });

  test("a pure suffix append keeps the old window: same epoch, newer rows bridge up", async () => {
    const { db, deps } = await setup();
    seedToolsTurn(db);
    const before = await loadAgentFeedPage(deps, "t1", q({ limit: "2" }));
    if (before.cursors.before === null) throw new Error("expected an older cursor");
    db.insert(experienceCopilotMessages).values(msg("a3", 6, "assistant")).run();
    const staleCandidate = await loadAgentFeedPage(deps, "t1", q({ before: before.cursors.before, limit: "2" }));
    expect(staleCandidate.historyEpoch).toBe(before.historyEpoch); // append-only: no epoch bump
    expect(staleCandidate.messages.map((m) => m.id)).toEqual(["r1", "a1"]);
    expect(staleCandidate.hasNewer).toBe(true);
    if (staleCandidate.cursors.after === null) throw new Error("expected an after cursor");
    const bridged = await loadAgentFeedPage(deps, "t1", q({ after: staleCandidate.cursors.after, limit: "40" }));
    expect(bridged.messages.map((m) => m.id)).toEqual(["u2", "a2", "a3"]);
  });

  test("an invalidating edit bumps the epoch: the old cursor gets the typed stale-window conflict", async () => {
    const { db, deps } = await setup();
    seedToolsTurn(db);
    const before = await loadAgentFeedPage(deps, "t1", q({ limit: "2" }));
    if (before.cursors.before === null) throw new Error("expected an older cursor");
    editMessage(db, "u1");
    const err = await rejects(() => loadAgentFeedPage(deps, "t1", q({ before: before.cursors.before, limit: "2" })));
    expect(err.kind).toBe("Conflict");
    expect(err.details).toMatchObject({ code: "AGENT_FEED_STALE_WINDOW" });
    expect(err.details?.historyEpoch).toBe(before.historyEpoch + 1);
  });

  test("a malformed or foreign cursor is a typed validation refusal", async () => {
    const { db, deps } = await setup();
    seedToolsTurn(db);
    const malformed = await rejects(() => loadAgentFeedPage(deps, "t1", q({ before: "!!!not-a-cursor", limit: "2" })));
    expect(malformed.kind).toBe("Validation");
    const foreign = Buffer.from(JSON.stringify({
      v: 1, threadId: "t2", epoch: 0,
      position: { record: "message", seq: 0, createdAt: NOW, id: "u1" },
    }), "utf8").toString("base64url");
    const foreignErr = await rejects(() => loadAgentFeedPage(deps, "t1", q({ before: foreign, limit: "2" })));
    expect(foreignErr.kind).toBe("Validation");
  });

  test("missing thread and missing around-target are typed not-found refusals", async () => {
    const { deps } = await setup();
    const thread = await rejects(() => loadAgentFeedPage(deps, "nope", q()));
    expect(thread.kind).toBe("NotFound");
    const target = await rejects(() => loadAgentFeedPage(deps, "t1", q({ aroundMessageId: "ghost" })));
    expect(target.kind).toBe("NotFound");
  });
});

describe("AFP-10 event summaries", () => {
  test("all five stored kinds project their facts without any frozen body", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([msg("u1", 0, "user"), msg("a1", 8, "assistant")]).run();
    db.insert(agentThreadContextEvents).values([
      evt("e-rp", 1, "rp_sync", JSON.stringify({ fromPosition: 0, toPosition: 2, messages: [rpMessage(0), rpMessage(1)] })),
      evt("e-va", 2, "variants_attached", JSON.stringify({ position: 4, variants: [{ text: "v1", selected: true, number: 1, model: null, preset: null }] })),
      evt("e-sc", 3, "selection_changed", JSON.stringify({ messageId: "m4", position: 4, previous: { variantId: "v0", text: "old", model: null, preset: null }, current: { variantId: "v1", text: "new", model: null, preset: null } })),
      evt("e-bf", 4, "branch_forked", JSON.stringify({ at: 7 })),
      evt("e-pc", 5, "profile_changed", JSON.stringify({ from: { id: "p1", name: "Default" }, to: { id: "p2", name: "Sharp" } })),
    ]).run();
    const page = await loadAgentFeedPage(deps, "t1", q({ limit: "40" }));
    const byId = new Map(page.events.map((event) => [event.id, event]));
    expect(page.events.map((event) => event.id)).toEqual(["e-rp", "e-va", "e-sc", "e-bf", "e-pc"]);
    const rp = byId.get("e-rp");
    if (rp?.kind !== "rp_sync") throw new Error("expected rp_sync");
    expect(rp).toMatchObject({ detailAvailable: true, fromPosition: 0, toPosition: 2, messageCount: 2, beforeMessageId: "a1", seq: 1 });
    const va = byId.get("e-va");
    if (va?.kind !== "variants_attached") throw new Error("expected variants_attached");
    expect(va).toMatchObject({ detailAvailable: true, position: 4, variantCount: 1 });
    const sc = byId.get("e-sc");
    if (sc?.kind !== "selection_changed") throw new Error("expected selection_changed");
    expect(sc).toMatchObject({ detailAvailable: true, position: 4, messageId: "m4" });
    const bf = byId.get("e-bf");
    if (bf?.kind !== "branch_forked") throw new Error("expected branch_forked");
    expect(bf).toMatchObject({ detailAvailable: true, at: 7 });
    const pc = byId.get("e-pc");
    if (pc?.kind !== "profile_changed") throw new Error("expected profile_changed");
    expect(pc).toMatchObject({ detailAvailable: true, fromLabel: "Default", toLabel: "Sharp" });
    // No arm carries a frozen text anywhere on the summary path.
    expect(JSON.stringify(page.events)).not.toContain("captured-");
  });

  test("a corrupt payload keeps its slot with null facts and detail unavailable", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([msg("u1", 0, "user"), msg("a1", 2, "assistant")]).run();
    db.insert(agentThreadContextEvents).values([
      evt("e-bad", 1, "rp_sync", '{"fromPosition": 0,'),
      evt("e-shape", 3, "rp_sync", JSON.stringify({ fromPosition: "zero", toPosition: 9, messages: [rpMessage(0)] })),
    ]).run();
    const page = await loadAgentFeedPage(deps, "t1", q({ limit: "40" }));
    const bad = page.events.find((event) => event.id === "e-bad");
    if (bad?.kind !== "rp_sync") throw new Error("expected e-bad rp_sync");
    expect(bad).toMatchObject({ detailAvailable: false, fromPosition: null, toPosition: null, messageCount: null, beforeMessageId: "a1" });
    const shape = page.events.find((event) => event.id === "e-shape");
    if (shape?.kind !== "rp_sync") throw new Error("expected e-shape rp_sync");
    expect(shape.detailAvailable).toBe(false); // fromPosition stored as text
    expect(shape.messageCount).toBe(1); // honest SQL fact, detail still refuses
  });
});

describe("AFP-10 frozen detail", () => {
  test("a large rp_sync snapshot pages its frozen messages and continues by cursor", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([msg("u1", 0, "user"), msg("a1", 2, "assistant")]).run();
    const messages = Array.from({ length: 55 }, (_, i) => rpMessage(i));
    db.insert(agentThreadContextEvents).values(
      evt("snap", 1, "rp_sync", JSON.stringify({ fromPosition: 0, toPosition: 54, messages })),
    ).run();
    const first = await loadAgentEventDetail(deps, "t1", "snap");
    if (first.kind !== "rp_sync") throw new Error("expected rp_sync");
    expect(first.messages).toHaveLength(50);
    expect(first.offset).toBe(0);
    expect(first.fromPosition).toBe(0);
    expect(first.toPosition).toBe(54);
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) throw new Error("expected a continuation cursor");
    const rest = await loadAgentEventDetail(deps, "t1", "snap", first.nextCursor);
    if (rest.kind !== "rp_sync") throw new Error("expected rp_sync");
    expect(rest.messages).toHaveLength(5);
    expect(rest.offset).toBe(50);
    expect(rest.nextCursor).toBeNull();
    expect(rest.messages[0]?.id).toBe("rp-50");
  });

  test("later edits never rewrite the frozen snapshot: fresh reads identical, only old cursors go stale", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([msg("u1", 0, "user"), msg("a1", 2, "assistant")]).run();
    const messages = Array.from({ length: 55 }, (_, i) => rpMessage(i));
    db.insert(agentThreadContextEvents).values(
      evt("snap", 1, "rp_sync", JSON.stringify({ fromPosition: 0, toPosition: 54, messages })),
    ).run();
    const first = await loadAgentEventDetail(deps, "t1", "snap");
    if (first.kind !== "rp_sync" || first.nextCursor === null) throw new Error("expected a first rp_sync page with a cursor");
    // A pure append keeps the epoch and the body byte-identical.
    db.insert(experienceCopilotMessages).values(msg("a2", 3, "assistant")).run();
    const afterAppend = await loadAgentEventDetail(deps, "t1", "snap");
    expect(afterAppend).toEqual(first);
    // An invalidating edit bumps the epoch: the OLD cursor is stale, but a
    // fresh first-page read still serves the exact frozen snapshot.
    editMessage(db, "u1");
    const stale = await rejects(() => loadAgentEventDetail(deps, "t1", "snap", first.nextCursor));
    expect(stale.kind).toBe("Conflict");
    expect(stale.details).toMatchObject({ code: "AGENT_EVENT_CURSOR_STALE" });
    const fresh = await loadAgentEventDetail(deps, "t1", "snap");
    if (fresh.kind !== "rp_sync") throw new Error("expected rp_sync");
    expect(fresh.messages).toEqual(first.messages);
    expect(fresh.epoch).toBeGreaterThan(first.epoch);
  });

  test("the four small kinds serve their validated frozen payloads as single pages", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([msg("u1", 0, "user")]).run();
    db.insert(agentThreadContextEvents).values([
      evt("e-va", 1, "variants_attached", JSON.stringify({ position: 4, variants: [
        { text: "v1", selected: true, number: 1, model: null, preset: null },
        { text: "v2", selected: false, number: 2, model: "m", preset: null },
      ] })),
      evt("e-sc", 2, "selection_changed", JSON.stringify({ messageId: "m4", position: 4, previous: { variantId: "v0", text: "old", model: null, preset: null }, current: { variantId: "v1", text: "new", model: null, preset: null } })),
      evt("e-bf", 3, "branch_forked", JSON.stringify({ at: 7 })),
      evt("e-pc", 4, "profile_changed", JSON.stringify({ from: { id: "p1", name: "Default" }, to: { id: "p2", name: "Sharp" } })),
    ]).run();
    const va = await loadAgentEventDetail(deps, "t1", "e-va");
    if (va.kind !== "variants_attached") throw new Error("expected variants_attached");
    expect(va).toMatchObject({ position: 4, offset: 0, nextCursor: null });
    expect(va.variants).toHaveLength(2);
    const sc = await loadAgentEventDetail(deps, "t1", "e-sc");
    if (sc.kind !== "selection_changed") throw new Error("expected selection_changed");
    expect(sc).toMatchObject({ position: 4, messageId: "m4", nextCursor: null });
    expect(sc.previous).toEqual({ variantId: "v0", text: "old", model: null, preset: null });
    const bf = await loadAgentEventDetail(deps, "t1", "e-bf");
    if (bf.kind !== "branch_forked") throw new Error("expected branch_forked");
    expect(bf).toMatchObject({ at: 7, nextCursor: null });
    const pc = await loadAgentEventDetail(deps, "t1", "e-pc");
    if (pc.kind !== "profile_changed") throw new Error("expected profile_changed");
    expect(pc.from).toEqual({ id: "p1", name: "Default" });
    expect(pc.to).toEqual({ id: "p2", name: "Sharp" });
  });

  test("corrupt and missing detail sources get explicit typed outcomes", async () => {
    const { db, deps } = await setup();
    db.insert(experienceCopilotMessages).values([msg("u1", 0, "user")]).run();
    db.insert(agentThreadContextEvents).values([
      evt("e-bad", 1, "rp_sync", '{"fromPosition": 0,'),
      evt("e-shape", 2, "rp_sync", JSON.stringify({ fromPosition: 0, toPosition: 0, messages: [{ id: "m", position: 1, role: "wizard", authorName: null, variantId: null, model: null, preset: null, text: "hi" }] })),
    ]).run();
    const bad = await rejects(() => loadAgentEventDetail(deps, "t1", "e-bad"));
    expect(bad.kind).toBe("Unprocessable");
    expect(bad.details).toMatchObject({ code: "AGENT_EVENT_CORRUPT" });
    const shape = await rejects(() => loadAgentEventDetail(deps, "t1", "e-shape"));
    expect(shape.kind).toBe("Unprocessable");
    expect(shape.details).toMatchObject({ code: "AGENT_EVENT_CORRUPT" });
    const missing = await rejects(() => loadAgentEventDetail(deps, "t1", "ghost"));
    expect(missing.kind).toBe("NotFound");
    const thread = await rejects(() => loadAgentEventDetail(deps, "nope", "e-bad"));
    expect(thread.kind).toBe("NotFound");
    const malformed = await rejects(() => loadAgentEventDetail(deps, "t1", "e-bad", "!!!"));
    expect(malformed.kind).toBe("Validation");
  });
});

describe("AFP-10 request building (policy defaults + cursor decode)", () => {
  function stubDeps() {
    const calls: { threadId: string; request: AgentFeedPageRequest }[] = [];
    let detailRequest: { threadId: string; eventId: string; request: AgentEventDetailRequest } | null = null;
    const deps: AgentFeedServiceDeps = {
      store: {
        readFeedPage: async (threadId, request): Promise<AgentFeedPageResult> => {
          calls.push({ threadId, request });
          return { status: "missing-thread" };
        },
        readEventDetail: async (threadId, eventId, request): Promise<AgentEventDetailResult> => {
          detailRequest = { threadId, eventId, request };
          return { status: "missing-event" };
        },
      },
    };
    return { deps, calls, detail: () => detailRequest };
  }
  const token = (payload: object) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  test("newest defaults to the initial target; explicit limit wins", async () => {
    const { deps, calls } = stubDeps();
    await rejects(() => loadAgentFeedPage(deps, "t1", q()));
    expect(calls[0]?.request).toEqual({ mode: "newest", limit: 100 });
    await rejects(() => loadAgentFeedPage(deps, "t1", q({ limit: "7" })));
    expect(calls[1]?.request).toEqual({ mode: "newest", limit: 7 });
  });

  test("paged modes default to the older target and decode the cursor payload", async () => {
    const { deps, calls } = stubDeps();
    await rejects(() => loadAgentFeedPage(deps, "t1", q({ before: token({ v: 1, threadId: "t1", epoch: 3, position: { record: "message", seq: 5, createdAt: NOW, id: "m5" } }) })));
    const before = calls[0];
    if (before?.request.mode !== "before") throw new Error("expected the before request");
    expect(before.request.limit).toBe(40);
    expect(before.request.cursor).toMatchObject({ threadId: "t1", epoch: 3, position: { record: "message", seq: 5, id: "m5" } });
    await rejects(() => loadAgentFeedPage(deps, "t1", q({ after: token({ v: 1, threadId: "t1", epoch: 0, position: { record: "event", seq: null, createdAt: NOW, id: "e1" } }) })));
    expect(calls[1]?.request.mode).toBe("after");
    await rejects(() => loadAgentFeedPage(deps, "t1", q({ aroundMessageId: "m9" })));
    expect(calls[2]?.request).toEqual({ mode: "around", limit: 40, messageId: "m9" });
  });

  test("detail requests carry the policy page size and a decoded continuation cursor", async () => {
    const { deps, detail } = stubDeps();
    await rejects(() => loadAgentEventDetail(deps, "t1", "e1"));
    expect(detail()?.request).toEqual({ limit: 50 });
    await rejects(() => loadAgentEventDetail(deps, "t1", "e1", token({ v: 1, threadId: "t1", eventId: "e1", epoch: 2, offset: 50 })));
    expect(detail()?.request).toMatchObject({ limit: 50, cursor: { threadId: "t1", eventId: "e1", epoch: 2, offset: 50 } });
  });
});
