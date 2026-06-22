/**
 * TL-B2 — trace-history cache store.
 *
 * Pins the branch-scoped cache that replaced promptTraceHistory: fetch +
 * dedup, per-chat / per-entry invalidation, and the optimistic post-generation
 * upsert. The cache key is `${chatId}::${branchId}` — switching branches
 * changes the key, which is what fixes the branch-vanish defects.
 *
 * `fetchTraceHistory` (the network call) is mocked via the spread-real-then-
 * override pattern so the rest of chat-api stays genuine (see AGENTS gotcha on
 * mock.module being process-global).
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { PromptTraceRecordDto } from "@vibe-tavern/domain";
import { useTraceHistoryStore } from "./trace-history-store.js";

// Capture the genuine chat-api module BEFORE registering the mock, then spread
// it so every export except fetchTraceHistory stays real for the whole run.
const real = await import("../api/chat-api.js");
type FetchImpl = (chatId: string, opts?: { messageId?: string; branchId?: string }) => Promise<PromptTraceRecordDto[]>;
let mockFetch: FetchImpl | null = null;
mock.module("../api/chat-api.js", () => ({
  ...real,
  fetchTraceHistory: ((chatId: string, opts?: { messageId?: string; branchId?: string }) =>
    mockFetch ? mockFetch(chatId, opts) : real.fetchTraceHistory(chatId as never, opts)) as FetchImpl,
}));

function makeTrace(id: string, branchId: string): PromptTraceRecordDto {
  return {
    id, chatId: "chat-1" as never, branchId: branchId as never, messageId: "m" as never,
    createdAt: "2026-01-01T00:00:00Z", model: "m", presetName: "p", latencyMs: 1,
    tokenAccounting: { total: 1 } as never, layers: [], finalPayload: null as never,
    activatedLoreEntries: [], activatedLoreDetail: [], retrievedMemories: [], scriptInjections: [],
  } as unknown as PromptTraceRecordDto;
}

const entry = (branchId: string) =>
  useTraceHistoryStore.getState().entries[`chat-1::${branchId}`];

describe("trace-history cache — fetch + dedup", () => {
  beforeEach(() => {
    useTraceHistoryStore.setState({ entries: {} });
    mockFetch = null;
  });

  test("fetch transitions idle → loading → success and stores branch-scoped traces", async () => {
    const tA = makeTrace("t1", "brA");
    mockFetch = async (_chatId, opts) => (opts?.branchId === "brA" ? [tA] : []);

    await useTraceHistoryStore.getState().fetch("chat-1", "brA");
    expect(entry("brA")?.status).toBe("success");
    expect(entry("brA")?.traces).toEqual([tA]);
  });

  test("fetch is a no-op once an entry is already success (dedup)", async () => {
    let calls = 0;
    mockFetch = async () => { calls++; return [makeTrace("t1", "brA")]; };

    await useTraceHistoryStore.getState().fetch("chat-1", "brA");
    await useTraceHistoryStore.getState().fetch("chat-1", "brA"); // skipped
    expect(calls).toBe(1);
  });

  test("fetch records the error message on failure", async () => {
    mockFetch = async () => { throw new Error("network down"); };
    await useTraceHistoryStore.getState().fetch("chat-1", "brA");
    expect(entry("brA")?.status).toBe("error");
    expect(entry("brA")?.error).toBe("network down");
    // A failed entry is neither success nor loading, so a retry refetches.
    let calls = 0;
    mockFetch = async () => { calls++; return []; };
    await useTraceHistoryStore.getState().fetch("chat-1", "brA");
    expect(calls).toBe(1);
  });
});

describe("trace-history cache — invalidation", () => {
  beforeEach(() => {
    useTraceHistoryStore.setState({ entries: {} });
    mockFetch = null;
  });

  test("invalidateEntry drops one branch's entry, forcing a refetch", async () => {
    let calls = 0;
    mockFetch = async () => { calls++; return [makeTrace("t1", "brA")]; };
    await useTraceHistoryStore.getState().fetch("chat-1", "brA");
    expect(calls).toBe(1);

    useTraceHistoryStore.getState().invalidateEntry("chat-1", "brA");
    expect(entry("brA")).toBeUndefined();

    await useTraceHistoryStore.getState().fetch("chat-1", "brA");
    expect(calls).toBe(2); // refetched after invalidation
  });

  test("invalidateChat drops every branch entry for that chat, leaving other chats alone", async () => {
    mockFetch = async (_c, opts) => [makeTrace("t1", opts!.branchId!)];
    await useTraceHistoryStore.getState().fetch("chat-1", "brA");
    await useTraceHistoryStore.getState().fetch("chat-2", "brX");

    useTraceHistoryStore.getState().invalidateChat("chat-1");
    expect(entry("brA")).toBeUndefined();
    // Other chat untouched.
    expect(useTraceHistoryStore.getState().entries[`chat-2::brX`]).toBeDefined();
  });
});

describe("trace-history cache — optimistic post-generation upsert", () => {
  beforeEach(() => {
    useTraceHistoryStore.setState({ entries: {} });
    mockFetch = null;
  });

  test("upsertLatest prepends a fresh trace to a populated (success) entry", async () => {
    const old = makeTrace("old", "brA");
    mockFetch = async () => [old];
    await useTraceHistoryStore.getState().fetch("chat-1", "brA");

    const fresh = makeTrace("fresh", "brA");
    useTraceHistoryStore.getState().upsertLatest("chat-1", "brA", fresh);
    expect(entry("brA")?.traces.map((t) => t.id)).toEqual(["fresh", "old"]);
  });

  test("upsertLatest is a no-op when the cache entry does not exist (tab was never opened)", () => {
    useTraceHistoryStore.getState().upsertLatest("chat-1", "brA", makeTrace("fresh", "brA"));
    expect(entry("brA")).toBeUndefined();
  });

  test("upsertLatest is a no-op when the trace is already present (no duplicate)", async () => {
    const t = makeTrace("t1", "brA");
    mockFetch = async () => [t];
    await useTraceHistoryStore.getState().fetch("chat-1", "brA");

    useTraceHistoryStore.getState().upsertLatest("chat-1", "brA", t);
    expect(entry("brA")?.traces).toHaveLength(1);
  });
});
