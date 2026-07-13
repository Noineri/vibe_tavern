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

describe("BackgroundTaskLocks.runExclusiveTrailing", () => {
  /** Build a sequence of deferred gates the test can release one at a time, so a
   *  task parks once per invocation and the test controls when each run ends. */
  function gateSequence() {
    const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const next = () => {
      const g = deferred();
      gates.push(g);
      return g.promise;
    };
    return { gates, next };
  }

  test("marks a dropped trigger as dirty and re-runs the task once before releasing", async () => {
    const locks = new BackgroundTaskLocks();
    const { gates, next } = gateSequence();
    const invocations: number[] = [];
    let n = 0;
    const task = async () => {
      n += 1;
      invocations.push(n);
      await next();
    };

    const first = locks.runExclusiveTrailing("k", task, () => {});
    await Promise.resolve(); // acquire + park on gate[0]

    // A trigger arriving mid-flight is dropped (returns false) and sets dirty.
    const dropped = await locks.runExclusiveTrailing("k", task, () => {});
    expect(dropped).toBe(false);
    expect(locks.has("k")).toBe(true);

    // Releasing gate[0] lets the run finish; the loop sees dirty → re-runs.
    gates[0].resolve();
    while (gates.length < 2) await Promise.resolve(); // wait for the re-run to park
    // No further trigger → releasing gate[1] ends the loop.
    gates[1].resolve();
    await first;

    expect(invocations).toEqual([1, 2]); // exactly one trailing re-run
    expect(locks.has("k")).toBe(false);
  });

  test("does not re-run when no trigger arrived during the run", async () => {
    const locks = new BackgroundTaskLocks();
    const { gates, next } = gateSequence();
    let n = 0;
    const task = async () => {
      n += 1;
      await next();
    };

    const first = locks.runExclusiveTrailing("k", task, () => {});
    await Promise.resolve();
    expect(gates).toHaveLength(1);

    gates[0].resolve(); // clean finish — no dirty flag set
    await first;

    expect(n).toBe(1);
    expect(locks.has("k")).toBe(false);
  });

  test("the trailing re-run re-invokes the closure, which re-reads fresh state", async () => {
    // The correctness guarantee for forward-injected tasks: the latest event is
    // evaluated, because the re-run calls the SAME closure and that closure
    // re-reads state on each invocation (it does NOT close over a snapshot).
    const locks = new BackgroundTaskLocks();
    const { gates, next } = gateSequence();
    let stateValue = "stale";
    const seen: string[] = [];
    const task = async () => {
      seen.push(stateValue);
      await next();
    };

    const first = locks.runExclusiveTrailing("k", task, () => {});
    await Promise.resolve(); // first run captured "stale"

    // Drop a trigger, THEN mutate the state the closure reads.
    await locks.runExclusiveTrailing("k", task, () => {});
    stateValue = "fresh";

    gates[0].resolve();
    while (gates.length < 2) await Promise.resolve();
    gates[1].resolve();
    await first;

    // The re-run re-read → saw the mutated (latest) value, not the stale one.
    expect(seen).toEqual(["stale", "fresh"]);
  });

  test("forwards errors to onError and still re-runs when a trigger arrived during the failed run", async () => {
    const locks = new BackgroundTaskLocks();
    const { gates, next } = gateSequence();
    const errors: unknown[] = [];
    let n = 0;
    const task = async () => {
      n += 1;
      await next();
      if (n === 1) throw new Error("boom");
    };

    const first = locks.runExclusiveTrailing("k", task, (e) => errors.push(e));
    await Promise.resolve(); // run 1 parked on gate[0]

    // Drop a trigger during the (soon-to-fail) first run.
    await locks.runExclusiveTrailing("k", task, () => {});

    gates[0].resolve(); // run 1 resumes → throws → onError; dirty set → re-run
    while (gates.length < 2) await Promise.resolve();
    gates[1].resolve(); // run 2 succeeds; no dirty → exit
    await first;

    expect(n).toBe(2);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(locks.has("k")).toBe(false);
  });

  test("coalesces a burst of dropped triggers into a single re-run", async () => {
    const locks = new BackgroundTaskLocks();
    const { gates, next } = gateSequence();
    let n = 0;
    const task = async () => {
      n += 1;
      await next();
    };

    const first = locks.runExclusiveTrailing("k", task, () => {});
    await Promise.resolve();
    // Burst of N drops — all coalesce into one dirty flag → one re-run.
    for (let i = 0; i < 5; i++) {
      expect(await locks.runExclusiveTrailing("k", task, () => {})).toBe(false);
    }

    gates[0].resolve();
    while (gates.length < 2) await Promise.resolve();
    gates[1].resolve();
    await first;

    expect(n).toBe(2); // initial run + exactly one trailing re-run
  });
});
