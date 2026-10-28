/** BR-1a: detached execution and replay, exercised with real parked generators. */
import { describe, expect, test } from "bun:test";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import type { AgentStreamEvent } from "../src/domain/agent/agent-stream.js";
import { AgentRunActiveError, AgentRunRegistry } from "../src/domain/agent/agent-run-registry.js";

const OWNER: AgentThreadOwner = { kind: "script", scriptId: "script-1" };
const FIRST: AgentStreamEvent = { event: "text-delta", data: '{"delta":"first"}' };
const LAST: AgentStreamEvent = { event: "finish", data: '{"finishReason":"stop"}' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("AgentRunRegistry", () => {
  test("a turn finishes without subscribers and its entire log remains available for late replay", async () => {
    const registry = new AgentRunRegistry();
    let persisted = false;
    const run = registry.start("thread", OWNER, async function* () {
      yield FIRST;
      persisted = true;
      yield LAST;
    });
    await run.done;

    expect(persisted).toBe(true);
    expect(registry.active()).toEqual([]);
    expect(await collect(registry.subscribe("thread", 0)!)).toEqual([
      { ...FIRST, seq: 1 }, { ...LAST, seq: 2 },
    ]);
    expect(await collect(registry.subscribe("thread", 1)!)).toEqual([{ ...LAST, seq: 2 }]);
    expect(await collect(registry.subscribe("thread", 2)!)).toEqual([]);
  });

  test("a resumed subscription replays its prefix and then tails live events without gaps", async () => {
    const registry = new AgentRunRegistry();
    const parked = deferred<void>();
    const release = deferred<void>();
    const run = registry.start("thread", OWNER, async function* () {
      yield FIRST;
      parked.resolve();
      await release.promise;
      yield LAST;
    });
    await parked.promise;
    const subscription = registry.subscribe("thread", 0)!;
    const first = await subscription.next();
    const pendingLast = subscription.next();
    release.resolve();
    const last = await pendingLast;
    await run.done;

    expect(first).toEqual({ done: false, value: { ...FIRST, seq: 1 } });
    expect(last).toEqual({ done: false, value: { ...LAST, seq: 2 } });
    expect(await subscription.next()).toMatchObject({ done: true });
  });

  test("slow and fast subscribers receive identical sequence numbers and payloads", async () => {
    const registry = new AgentRunRegistry();
    const release = deferred<void>();
    const run = registry.start("thread", OWNER, async function* () {
      yield FIRST;
      await release.promise;
      yield LAST;
    });
    const slow = registry.subscribe("thread", 0)!;
    const fast = collect(registry.subscribe("thread", 0)!);
    release.resolve();
    await run.done;
    expect(await collect(slow)).toEqual(await fast);
  });

  test("return interrupts a pending subscriber read without aborting or stalling the turn", async () => {
    const registry = new AgentRunRegistry();
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    let persisted = false;
    const run = registry.start("thread", OWNER, async function* (runSignal) {
      signal = runSignal;
      entered.resolve();
      await release.promise;
      persisted = true;
      yield LAST;
    });
    await entered.promise;
    const subscription = registry.subscribe("thread", 0)!;
    const read = subscription.next();
    const returned = subscription.return();
    expect(await read).toMatchObject({ done: true });
    expect(await returned).toMatchObject({ done: true });
    expect(signal?.aborted).toBe(false);
    expect(registry.active()).toHaveLength(1);

    release.resolve();
    await run.done;
    expect(persisted).toBe(true);
    expect(await collect(registry.subscribe("thread", 0)!)).toEqual([{ ...LAST, seq: 1 }]);
  });

  test("a subscriber abort signal only detaches that subscriber", async () => {
    const registry = new AgentRunRegistry();
    const release = deferred<void>();
    let runSignal: AbortSignal | undefined;
    const run = registry.start("thread", OWNER, async function* (signal) {
      runSignal = signal;
      await release.promise;
      yield LAST;
    });
    const client = new AbortController();
    const subscription = registry.subscribe("thread", 0, client.signal)!;
    const read = subscription.next();
    client.abort();
    expect(await read).toMatchObject({ done: true });
    expect(runSignal?.aborted).toBe(false);
    release.resolve();
    await run.done;
    expect(await collect(registry.subscribe("thread", 0)!)).toEqual([{ ...LAST, seq: 1 }]);
  });

  test("stop preserves the generator's abort event and waits for its persistence to finish", async () => {
    const registry = new AgentRunRegistry();
    const entered = deferred<void>();
    const persist = deferred<void>();
    const abortEvent = { event: "abort", data: '{"partialLength":7}' };
    let signal: AbortSignal | undefined;
    const run = registry.start("thread", OWNER, async function* (runSignal) {
      signal = runSignal;
      await new Promise<void>((resolve) => {
        if (runSignal.aborted) resolve();
        else runSignal.addEventListener("abort", () => resolve(), { once: true });
        entered.resolve();
      });
      yield abortEvent;
      await persist.promise;
    });
    await entered.promise;
    const subscription = registry.subscribe("thread", 0)!;
    expect(registry.stop("thread")).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(await subscription.next()).toEqual({ done: false, value: { ...abortEvent, seq: 1 } });
    expect(registry.active()).toHaveLength(1);
    expect(() => registry.start("thread", OWNER, async function* () { yield LAST; })).toThrow(AgentRunActiveError);
    persist.resolve();
    await run.done;
    expect(await subscription.next()).toMatchObject({ done: true });
    expect(registry.stop("thread")).toBe(false);
  });

  test("the same thread is reserved before a second factory can run", async () => {
    const registry = new AgentRunRegistry();
    const release = deferred<void>();
    let duplicateCalled = false;
    const run = registry.start("thread", OWNER, async function* () { await release.promise; yield LAST; });
    let caught: unknown;
    try {
      registry.start("thread", OWNER, () => { duplicateCalled = true; throw new Error("Must not run"); });
    } catch (error) {
      caught = error;
    }
    release.resolve();
    await run.done;
    expect(caught).toBeInstanceOf(AgentRunActiveError);
    expect(caught).toMatchObject({ code: "AGENT_RUN_ACTIVE", threadId: "thread" });
    expect(duplicateCalled).toBe(false);
  });

  test("different threads run concurrently and active lists their owners and start times", async () => {
    let now = 10;
    const registry = new AgentRunRegistry({ nowMs: () => now });
    const releaseA = deferred<void>();
    const releaseB = deferred<void>();
    const other: AgentThreadOwner = { kind: "chat", chatId: "chat", branchId: "branch", agentKind: "sidechat-ooc" };
    const a = registry.start("a", OWNER, async function* () { await releaseA.promise; yield LAST; });
    now = 20;
    const b = registry.start("b", other, async function* () { await releaseB.promise; yield LAST; });
    expect(registry.active()).toEqual([
      { threadId: "a", owner: OWNER, startedAt: 10 },
      { threadId: "b", owner: other, startedAt: 20 },
    ]);
    releaseB.resolve();
    await b.done;
    expect(registry.active().map((run) => run.threadId)).toEqual(["a"]);
    releaseA.resolve();
    await a.done;
    expect(registry.active()).toEqual([]);
  });

  test("the next run replaces replay but an already-created subscriber remains bound to the old run", async () => {
    const registry = new AgentRunRegistry();
    await registry.start("thread", OWNER, async function* () { yield FIRST; }).done;
    const old = registry.subscribe("thread", 0)!;
    await registry.start("thread", OWNER, async function* () { yield LAST; }).done;
    expect(await collect(old)).toEqual([{ ...FIRST, seq: 1 }]);
    expect(await collect(registry.subscribe("thread", 0)!)).toEqual([{ ...LAST, seq: 1 }]);
  });

  test("a thrown generator failure is handled by the runner and replayed to every subscriber", async () => {
    const registry = new AgentRunRegistry();
    const error = new Error("Turn failed during persistence");
    const run = registry.start("thread", OWNER, async function* () { yield FIRST; throw error; });
    const first = registry.subscribe("thread", 0)!;
    await run.done;
    const late = registry.subscribe("thread", 0)!;
    for (const subscription of [first, late]) {
      expect(await subscription.next()).toEqual({ done: false, value: { ...FIRST, seq: 1 } });
      await expect(subscription.next()).rejects.toBe(error);
    }
    expect(registry.active()).toEqual([]);
    await registry.start("thread", OWNER, async function* () { yield LAST; }).done;
    expect(await collect(registry.subscribe("thread", 0)!)).toEqual([{ ...LAST, seq: 1 }]);
  });

  test("a synchronously throwing factory also releases its slot without an unhandled rejection", async () => {
    const registry = new AgentRunRegistry();
    const error = new Error("Cannot create generator");
    const run = registry.start("thread", OWNER, () => { throw error; });
    await run.done;
    expect(registry.active()).toEqual([]);
    await expect(registry.subscribe("thread", 0)!.next()).rejects.toBe(error);
  });

  test("published events are stable copies, not mutable generator objects", async () => {
    const registry = new AgentRunRegistry();
    const original = { ...FIRST };
    await registry.start("thread", OWNER, async function* () {
      yield original;
      original.data = "changed after yield";
    }).done;
    const events = await collect(registry.subscribe("thread", 0)!);
    expect(events).toEqual([{ ...FIRST, seq: 1 }]);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  test("missing runs and fresh registry instances have nothing to replay or stop", async () => {
    const registry = new AgentRunRegistry();
    expect(registry.subscribe("missing", 0)).toBeNull();
    expect(registry.stop("missing")).toBe(false);
    await registry.start("thread", OWNER, async function* () { yield LAST; }).done;
    expect(new AgentRunRegistry().subscribe("thread", 0)).toBeNull();
  });

  test("a pre-aborted client receives no replay, and invalid cursors are refused", async () => {
    const registry = new AgentRunRegistry();
    await registry.start("thread", OWNER, async function* () { yield LAST; }).done;
    const client = new AbortController();
    client.abort();
    expect(await collect(registry.subscribe("thread", 0, client.signal)!)).toEqual([]);
    for (const after of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => registry.subscribe("thread", after)).toThrow(RangeError);
    }
    expect(await collect(registry.subscribe("thread", 100)!)).toEqual([]);
  });
});
