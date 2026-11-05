import { describe, expect, it } from "bun:test";
import type { AgentEventDetailResponse } from "@vibe-tavern/api-contracts";
import { createAgentEventDetailCache, type AgentEventDetailKey } from "./agent-event-detail-cache.js";
// L1: relative imports; no globals/env/registries to restore; terminal cache
// notifications, no sleeps; no platform/discovery assumptions; T1 loader DI,
// no module mocks; stable ready/error snapshots; no DB or heavy setup.
const key: AgentEventDetailKey = { threadId: "T", eventId: "E", epoch: 1 };
function page(eventId = "E", epoch = 1): AgentEventDetailResponse {
  return { threadId: "T", eventId, epoch, kind: "rp_sync", fromPosition: 0, toPosition: 1, offset: 0,
    messages: [{ id: "rp", position: 0, role: "user", authorName: null, variantId: null, model: null, preset: null, text: "Frozen byte-for-byte" }], nextCursor: null };
}
function parked<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function watch(cache: ReturnType<typeof createAgentEventDetailCache>, k = key, loader = async () => page(k.eventId, k.epoch)) {
  const done = parked<void>();
  const release = cache.subscribe(k, loader, () => { if (cache.getSnapshot(k).status !== "loading") done.resolve(); });
  if (cache.getSnapshot(k).status !== "loading") done.resolve();
  return { release, done: done.promise };
}

describe("AFP-16 shared event detail cache", () => {
  it("coalesces simultaneous observers and retains the exact same page object", async () => {
    const cache = createAgentEventDetailCache();
    const pending = parked<AgentEventDetailResponse>();
    let calls = 0;
    const load = () => { calls++; return pending.promise; };
    const a = watch(cache, key, load), b = watch(cache, key, load);
    const frozen = page();
    pending.resolve(frozen);
    await Promise.all([a.done, b.done]);
    expect(calls).toBe(1);
    expect(cache.getSnapshot(key).page).toBe(frozen);
    a.release(); b.release();
    const c = watch(cache, key, load);
    await c.done;
    expect(calls).toBe(1);
    c.release();
  });
  it("bounds unobserved entries and exact UTF-8 serialized bytes", async () => {
    const cache = createAgentEventDetailCache({ maxEntries: 1, maxBytes: 10000 });
    const a = watch(cache); await a.done; a.release();
    const other = { ...key, eventId: "second" };
    const b = watch(cache, other); await b.done; b.release();
    expect(cache.stats().retainedEntries).toBe(1);
    expect(cache.stats().retainedBytes).toBe(new TextEncoder().encode(JSON.stringify(page("second"))).byteLength);
    expect(cache.getSnapshot(key).status).toBe("loading");
  });
  it("renders an oversized active page but drops it on its last observer release", async () => {
    const cache = createAgentEventDetailCache({ maxBytes: 1 });
    const a = watch(cache); await a.done;
    expect(cache.getSnapshot(key).page).toBeDefined();
    a.release();
    expect(cache.stats().entries).toBe(0);
  });
  it.each(["thread", "event", "epoch"] as const)("rejects a foreign %s response rather than mixing identities", async (field) => {
    const cache = createAgentEventDetailCache();
    const wrong = { ...page(), ...(field === "thread" ? { threadId: "other" } : field === "event" ? { eventId: "other" } : { epoch: 2 }) };
    const a = watch(cache, key, async () => wrong); await a.done;
    expect(cache.getSnapshot(key).status).toBe("error");
    expect(cache.getSnapshot(key).page).toBeUndefined();
    a.release();
  });
  it("retries errors and keeps a continuation cursor in a separate cache identity", async () => {
    const cache = createAgentEventDetailCache();
    const a = watch(cache, key, async () => { throw new Error("offline"); }); await a.done;
    expect(cache.getSnapshot(key).status).toBe("error");
    const done = parked<void>();
    const stop = cache.subscribe(key, async () => page(), () => {
      if (cache.getSnapshot(key).status === "ready") done.resolve();
    });
    cache.retry(key, async () => page()); await done.promise;
    expect(cache.getSnapshot(key).status).toBe("ready");
    const next = { ...key, cursor: "opaque-next" };
    const b = watch(cache, next); await b.done;
    expect(cache.stats().entries).toBe(2);
    stop(); a.release(); b.release();
  });
  it("does not resurrect an in-flight body after its last observer unmounts", async () => {
    const cache = createAgentEventDetailCache();
    const pending = parked<AgentEventDetailResponse>();
    const a = watch(cache, key, () => pending.promise);
    a.release(); pending.resolve(page());
    await pending.promise;
    expect(cache.stats().entries).toBe(0);
  });
});
