/**
 * BR-1a: request-independent execution of SSE-shaped turn generators.
 * One instance belongs to the server composition root (wired in BR-1b), never
 * to a request. A subscriber owns only its cursor and cancellation signal;
 * only stop() can abort the turn. Logs live until the key's next start.
 */
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import type { AgentStreamEvent } from "./agent-stream.js";

export type AgentRunEvent = Readonly<AgentStreamEvent> & { readonly seq: number };

export interface ActiveAgentRun<OWNER extends object = AgentThreadOwner> {
  readonly threadId: string;
  readonly owner: Readonly<OWNER>;
  readonly startedAt: number;
}

export interface AgentRunHandle<OWNER extends object = AgentThreadOwner> extends ActiveAgentRun<OWNER> {
  /** Settles after generator finalization, even on failure; subscribers receive the error. */
  readonly done: Promise<void>;
}

export interface AgentRunSubscription extends AsyncIterableIterator<AgentRunEvent, void> {
  /** Detaches immediately, including while next() is waiting for a silent turn. */
  return(): Promise<IteratorResult<AgentRunEvent, void>>;
}

export class AgentRunActiveError extends Error {
  readonly code = "AGENT_RUN_ACTIVE";
  constructor(readonly threadId: string) {
    super(`A turn is already running for "${threadId}".`);
    this.name = "AgentRunActiveError";
  }
}

interface StoredRun<OWNER extends object> {
  readonly info: ActiveAgentRun<OWNER>;
  readonly controller: AbortController;
  readonly events: AgentRunEvent[];
  readonly waiters: Set<() => void>;
  readonly complete: () => void;
  running: boolean;
  failure: { readonly error: unknown } | null;
}

type MakeTurn = (signal: AbortSignal) => AsyncIterable<AgentStreamEvent>;

export class AgentRunRegistry<OWNER extends object = AgentThreadOwner> {
  private readonly runs = new Map<string, StoredRun<OWNER>>();

  constructor(private readonly deps: { readonly nowMs?: () => number } = {}) {}

  start(threadId: string, owner: OWNER, makeTurn: MakeTurn): AgentRunHandle<OWNER> {
    if (this.runs.get(threadId)?.running) throw new AgentRunActiveError(threadId);
    const info: ActiveAgentRun<OWNER> = Object.freeze({
      threadId,
      owner: Object.freeze({ ...owner }),
      startedAt: (this.deps.nowMs ?? Date.now)(),
    });
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    const run: StoredRun<OWNER> = {
      info, controller: new AbortController(), events: [], waiters: new Set(),
      complete, running: true, failure: null,
    };
    // Reserve synchronously, BEFORE invoking user code or yielding control, so
    // concurrent/reentrant starts cannot both persist a turn in the same thread.
    this.runs.set(threadId, run);
    void this.consume(run, makeTurn);
    return Object.freeze({ ...info, done });
  }

  /** Bind to the current/last run NOW, not lazily on the subscriber's first next(). */
  subscribe(threadId: string, afterSeq = 0, signal?: AbortSignal): AgentRunSubscription | null {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new RangeError("The replay cursor must be a non-negative safe integer.");
    }
    const run = this.runs.get(threadId);
    return run ? createSubscription(run, afterSeq, signal) : null;
  }

  /** True only when this call signals a running turn to stop; finalization is cooperative. */
  stop(threadId: string): boolean {
    const run = this.runs.get(threadId);
    if (!run?.running || run.controller.signal.aborted) return false;
    run.controller.abort();
    return true;
  }

  active(): readonly ActiveAgentRun<OWNER>[] {
    return [...this.runs.values()].filter((run) => run.running).map((run) => ({ ...run.info }));
  }

  private async consume(run: StoredRun<OWNER>, makeTurn: MakeTurn): Promise<void> {
    try {
      for await (const event of makeTurn(run.controller.signal)) {
        run.events.push(Object.freeze({ seq: run.events.length + 1, event: event.event, data: event.data }));
        wakeSubscribers(run);
      }
    } catch (error) {
      // Keep failures for every current/late subscriber. The SSE writer owns
      // error-to-wire conversion; a detached task must not reject unobserved.
      run.failure = { error };
    } finally {
      // A finish/abort EVENT can precede persistence: only exhaustion releases
      // the slot, never the arrival of a terminal-looking payload in the log.
      run.running = false;
      run.complete();
      wakeSubscribers(run);
    }
  }
}

function wakeSubscribers<OWNER extends object>(run: StoredRun<OWNER>): void {
  for (const wake of run.waiters) wake();
}

function waitForUpdate<OWNER extends object>(run: StoredRun<OWNER>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const wake = () => {
      run.waiters.delete(wake);
      signal.removeEventListener("abort", wake);
      resolve();
    };
    run.waiters.add(wake);
    signal.addEventListener("abort", wake, { once: true });
    if (signal.aborted || !run.running) wake();
  });
}

function createSubscription<OWNER extends object>(
  run: StoredRun<OWNER>, afterSeq: number, signal?: AbortSignal,
): AgentRunSubscription {
  const client = new AbortController();
  const abort = () => client.abort();
  const detach = () => signal?.removeEventListener("abort", abort);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  const iterator = (async function* (): AsyncGenerator<AgentRunEvent, void> {
    let cursor = afterSeq;
    try {
      while (!client.signal.aborted) {
        const event = run.events[cursor];
        if (event) {
          cursor = event.seq;
          yield event;
        } else if (!run.running) {
          if (run.failure) throw run.failure.error;
          return;
        } else {
          // No await separates checking the log from registering the waiter,
          // so an event cannot fall into a replay-to-live subscription gap.
          await waitForUpdate(run, client.signal);
        }
      }
    } finally {
      detach();
    }
  })();

  return {
    [Symbol.asyncIterator]() { return this; },
    next: () => iterator.next(),
    return: () => {
      // AsyncGenerator.return alone queues behind a pending next(). Wake that
      // read first, otherwise a disconnected client waits for the model forever.
      abort();
      detach();
      return iterator.return();
    },
    throw: (error) => {
      abort();
      detach();
      return iterator.throw(error);
    },
  };
}
