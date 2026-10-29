import { agentReviewEnvelopeSchema, type AgentReviewEnvelope } from "@vibe-tavern/api-contracts";

export interface AgentReviewPersistenceDeps {
  api: {
    get: (threadId: string) => Promise<AgentReviewEnvelope | null>;
    put: (threadId: string, envelope: AgentReviewEnvelope) => Promise<AgentReviewEnvelope>;
    delete: (threadId: string) => Promise<unknown>;
    isRunning: (threadId: string) => Promise<boolean>;
  };
  read: (threadId: string) => AgentReviewEnvelope | null;
  apply: (threadId: string, envelope: AgentReviewEnvelope | null) => void;
  readLegacy: (threadId: string) => AgentReviewEnvelope | null;
  removeLegacy: (threadId: string) => void;
}

interface ThreadPersistence {
  tail: Promise<unknown>;
  ready: boolean;
  expected: string | null;
  phase: "idle" | "prepared" | "streaming" | "detached";
  watched: boolean;
}

/** One ordered lane per thread, independent of React mount lifetimes. Browser
 * writes never race THIS client's turn POST. A changed server predecessor wins
 * over stale memory (including a run completed while the editor was absent).
 * Cross-client compare-and-swap is not provided by the review CRUD protocol. */
export class AgentReviewPersistence {
  private readonly threads = new Map<string, ThreadPersistence>();

  constructor(private readonly deps: AgentReviewPersistenceDeps) {}

  private thread(id: string): ThreadPersistence {
    let state = this.threads.get(id);
    if (!state) {
      state = { tail: Promise.resolve(), ready: false, expected: null, phase: "idle", watched: false };
      this.threads.set(id, state);
    }
    return state;
  }

  private enqueue<T>(id: string, work: (state: ThreadPersistence) => Promise<T>): Promise<T> {
    const state = this.thread(id);
    const result = state.tail.then(() => work(state));
    // Failures are returned to the caller, but cannot poison the next retry.
    state.tail = result.catch(() => undefined);
    return result;
  }

  private encode(envelope: AgentReviewEnvelope | null): string | null {
    return envelope === null ? null : JSON.stringify(agentReviewEnvelopeSchema.parse(envelope));
  }

  private async load(id: string, state: ThreadPersistence): Promise<void> {
    if (state.phase === "prepared" || state.phase === "streaming") return;
    const before = this.encode(this.deps.read(id));
    const running = await this.deps.api.isRunning(id);
    let envelope = await this.deps.api.get(id);
    if (!running) {
      const legacy = this.deps.readLegacy(id);
      if (envelope === null && legacy !== null) {
        // A failed upload MUST retain the old key. Normalize V1/degraded input
        // to V2 without inventing an anchor or silently rebasing its proposal.
        envelope = await this.deps.api.put(id, agentReviewEnvelopeSchema.parse(legacy));
      }
      this.deps.removeLegacy(id);
    }
    const encoded = this.encode(envelope);
    if (this.encode(this.deps.read(id)) !== before) throw new Error("Agent review changed during hydration; retry before sending");
    if ((envelope !== null && encoded !== before) || (state.ready && encoded !== state.expected)) {
      this.deps.apply(id, envelope);
    }
    state.expected = encoded;
    state.ready = true;
    if (running) {
      state.phase = "detached";
      state.watched = false;
    }
  }

  hydrate(id: string): Promise<void> {
    return this.enqueue(id, (state) => this.load(id, state));
  }

  /** Preparation must not reload an already-ready predecessor: a click can
   * arrive before the effect that queues its latest hunk progress. */
  ensureHydrated(id: string): Promise<void> {
    return this.enqueue(id, async (state) => { if (!state.ready) await this.load(id, state); });
  }

  private async write(id: string, state: ThreadPersistence): Promise<void> {
    const envelope = this.deps.read(id);
    const encoded = this.encode(envelope);
    if (encoded === state.expected) return;
    if (envelope === null) await this.deps.api.delete(id);
    else await this.deps.api.put(id, agentReviewEnvelopeSchema.parse(envelope));
    state.expected = encoded;
  }

  private async synchronize(id: string, state: ThreadPersistence): Promise<void> {
    if (!state.ready || state.phase === "prepared" || state.phase === "streaming") return;
    if (await this.deps.api.isRunning(id)) {
      state.phase = "detached";
      return;
    }
    const envelope = await this.deps.api.get(id);
    const encoded = this.encode(envelope);
    if (state.phase === "detached" && !state.watched) {
      // A broken/aborted subscription is not proof of server completion. Once
      // idle, recover what the producer saved, never upload its partial replay.
      this.deps.apply(id, envelope);
      state.expected = encoded;
      state.phase = "idle";
      return;
    }
    if (state.phase === "detached" && state.watched) {
      // The parser may return at a clean EOF without having seen the producer's
      // final tool result. Even a seemingly watched turn must not replace a
      // different finalized proposal set committed by the server.
      const current = this.deps.read(id);
      const remoteActivities = envelope === null ? [] : agentReviewEnvelopeSchema.parse(envelope).activities;
      const currentActivities = current === null ? [] : agentReviewEnvelopeSchema.parse(current).activities;
      if (encoded !== state.expected && JSON.stringify(remoteActivities) !== JSON.stringify(currentActivities)) {
        this.deps.apply(id, envelope);
        state.expected = encoded;
        state.phase = "idle";
        state.watched = false;
        return;
      }
      state.expected = encoded;
    }
    else if (encoded !== state.expected) {
      this.deps.apply(id, envelope);
      state.expected = encoded;
      return;
    }
    state.phase = "idle";
    state.watched = false;
    await this.write(id, state);
  }

  sync(id: string): Promise<void> {
    return this.enqueue(id, (state) => this.synchronize(id, state));
  }

  /** Await this BEFORE clearTurn and BEFORE appending the new snapshot. */
  prepare(id: string, signal: AbortSignal): Promise<void> {
    return this.enqueue(id, async (state) => {
      signal.throwIfAborted();
      if (!state.ready) await this.load(id, state);
      await this.synchronize(id, state);
      signal.throwIfAborted();
      if (state.phase !== "idle") throw new Error("Agent run already owns this review");
      state.phase = "prepared";
      signal.addEventListener("abort", () => {
        // Cancelling preparation is safe to release. Cancelling an attached
        // stream is only a detach: the server may still be writing proposals.
        if (state.phase === "prepared") state.phase = "idle";
      }, { once: true });
    });
  }

  start(id: string): void {
    this.thread(id).phase = "streaming";
  }

  finish(id: string, watched: boolean): Promise<void> {
    return this.enqueue(id, async (state) => {
      state.phase = "detached";
      state.watched = watched;
      await this.synchronize(id, state);
    });
  }
}
