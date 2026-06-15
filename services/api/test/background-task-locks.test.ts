import { describe, expect, test } from "bun:test";
import { BackgroundTaskLocks } from "../src/shared/background-task-locks.js";

/** A promise the test can resolve on demand, to keep a task "in flight". */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("BackgroundTaskLocks", () => {
  test("runs the task and reports it ran", async () => {
    const locks = new BackgroundTaskLocks();
    let ran = false;
    const ranFlag = await locks.runExclusive("k", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(ranFlag).toBe(true);
  });

  test("holds the lock while the task is in flight, then releases it", async () => {
    const locks = new BackgroundTaskLocks();
    const gate = deferred();

    const promise = locks.runExclusive("chat-1:branch-A", () => gate.promise);
    // Let the microtask queue drain so runExclusive has added the lock.
    await Promise.resolve();
    expect(locks.has("chat-1:branch-A")).toBe(true);

    gate.resolve();
    await promise;
    expect(locks.has("chat-1:branch-A")).toBe(false);
  });

  test("skips a concurrent call for the same key and reports it was skipped", async () => {
    const locks = new BackgroundTaskLocks();
    const gate = deferred();
    let count = 0;

    const first = locks.runExclusive("k", async () => {
      count += 1;
      await gate.promise;
    });
    await Promise.resolve(); // let first acquire

    const secondRan = await locks.runExclusive("k", async () => {
      count += 1;
    });

    expect(secondRan).toBe(false);
    expect(count).toBe(1);

    gate.resolve();
    await first;
    expect(count).toBe(1);
  });

  test("forwards task errors to onError, swallows them, and releases the lock", async () => {
    const locks = new BackgroundTaskLocks();
    const captured: unknown[] = [];

    const ranFlag = await locks.runExclusive(
      "k",
      async () => {
        throw new Error("boom");
      },
      (err) => {
        captured.push(err);
      },
    );

    // Error does not propagate to the caller.
    expect(ranFlag).toBe(true);
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe("boom");
    // Lock released despite the error, so a subsequent run proceeds.
    expect(locks.has("k")).toBe(false);
    let secondRan = false;
    const ok = await locks.runExclusive("k", async () => {
      secondRan = true;
    });
    expect(ok).toBe(true);
    expect(secondRan).toBe(true);
  });

  test("allows different keys to run in parallel", async () => {
    const locks = new BackgroundTaskLocks();
    const gate = deferred();
    const order: string[] = [];

    const a = locks.runExclusive("a", async () => {
      order.push("a-start");
      await gate.promise;
      order.push("a-end");
    });
    const b = locks.runExclusive("b", async () => {
      order.push("b");
    });
    await b;

    expect(order).toContain("b");
    expect(locks.has("a")).toBe(true);
    expect(locks.has("b")).toBe(false);

    gate.resolve();
    await a;
    expect(order).toEqual(["a-start", "b", "a-end"]);
  });

  test("re-runs after the previous run completes", async () => {
    const locks = new BackgroundTaskLocks();
    let calls = 0;

    expect(await locks.runExclusive("k", async () => { calls += 1; })).toBe(true);
    expect(await locks.runExclusive("k", async () => { calls += 1; })).toBe(true);

    expect(calls).toBe(2);
  });
});
