/** Shared web store/lifecycle adapter over the per-thread persistence lane.
 * Both buffer hosts keep native tool targets and their established round slots. */
import {
  aggregateExperienceCopilotProposal, aggregateScriptAgentCodeProposal, captureAgentReviewProposal, captureScriptAgentReviewProposal, updateAgentReviewKeys,
  finalizeBufferReviewActivities, type AgentBufferReviewKind, type AgentReviewEnvelope, type AgentReviewRound, type AgentToolActivity,
} from "@vibe-tavern/api-contracts";
import { getExperienceCopilotReview, putExperienceCopilotReview, deleteExperienceCopilotReview, isExperienceCopilotRunning } from "../api/experience-copilot-api.js";
import { useAgentTurnStore } from "../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../stores/agent-review-store.js";
import { agentThreadKey } from "./agent-host-registry.js";
import { AgentReviewPersistence } from "./agent-review-persistence.js";
import { agentThreadRuns } from "../api/agent-run-api.js";

type Buffers = { rules: string; visual: string };

export function serializeBufferAgentReview(activities: readonly AgentToolActivity[], round: AgentReviewRound | null, kind: AgentBufferReviewKind): string | null {
  const finalized = finalizeBufferReviewActivities(activities, kind);
  if (finalized.length === 0 && round?.dangling == null) return null;
  const envelope: AgentReviewEnvelope = { _v: 2, activities: finalized, round };
  return JSON.stringify(envelope);
}

export function createBufferAgentReviewPersistence(kind: AgentBufferReviewKind, legacy?: {
  read: (threadId: string) => AgentReviewEnvelope | null;
  remove: (threadId: string) => void;
}) {
  const persistence = new AgentReviewPersistence({
    api: { get: getExperienceCopilotReview, put: putExperienceCopilotReview, delete: deleteExperienceCopilotReview, isRunning: isExperienceCopilotRunning },
    read: (threadId) => {
      const key = agentThreadKey(kind, threadId);
      const activities = useAgentTurnStore.getState().turnsByThread[key] ?? [];
      const round = useAgentReviewRoundStore.getState().roundsByThread[key] ?? null;
      const json = serializeBufferAgentReview(activities, round, kind);
      return json === null ? null : JSON.parse(json) as AgentReviewEnvelope;
    },
    apply: (threadId, envelope) => {
      const key = agentThreadKey(kind, threadId);
      useAgentTurnStore.setState((s) => ({ turnsByThread: { ...s.turnsByThread, [key]: envelope?.activities ?? [] } }));
      if (envelope?.round) {
        useAgentReviewRoundStore.setState((s) => ({ roundsByThread: { ...s.roundsByThread, [key]: envelope.round! } }));
      } else useAgentReviewRoundStore.getState().resetRound(kind, threadId);
    },
    readLegacy: (threadId) => legacy?.read(threadId) ?? null,
    removeLegacy: (threadId) => { legacy?.remove(threadId); },
  });
  const preparedBuffers = new Map<string, Buffers>();

  async function prepare(threadId: string, signal: AbortSignal, buffers: Buffers): Promise<void> {
    await persistence.ensureHydrated(threadId);
    signal.throwIfAborted();
    const key = agentThreadKey(kind, threadId);
    const activities = useAgentTurnStore.getState().turnsByThread[key] ?? [];
    const round = useAgentReviewRoundStore.getState().roundsByThread[key] ?? null;
    const capture = kind === "script"
      ? captureScriptAgentReviewProposal(activities, round, buffers.rules)
      : captureAgentReviewProposal(aggregateExperienceCopilotProposal(activities), round?.snapshots.at(-1) ?? null, buffers);
    if (capture) useAgentReviewRoundStore.getState().captureDangling(kind, threadId, capture);
    await persistence.prepare(threadId, signal);
    signal.throwIfAborted();
    preparedBuffers.set(threadId, buffers);
    signal.addEventListener("abort", () => { preparedBuffers.delete(threadId); }, { once: true });
  }

  async function run<T>(threadId: string, signal: AbortSignal | undefined, stream: () => Promise<T>): Promise<T> {
    const buffers = preparedBuffers.get(threadId);
    if (!buffers) throw new Error("Agent review turn was not prepared");
    preparedBuffers.delete(threadId);
    // After flush + clearTurn, before I/O: exactly one checkpoint even for a
    // very short stream that React batches into a single render.
    useAgentReviewRoundStore.getState().pushSnapshot(kind, threadId, buffers);
    persistence.start(threadId);
    let watched = false;
    try {
      const result = await stream();
      watched = !signal?.aborted;
      return result;
    } finally {
      // A fast SSE response can settle before the hook's key-reset effects.
      // Persist the same finalized identities/progress as the server producer.
      const key = agentThreadKey(kind, threadId);
      const activities = useAgentTurnStore.getState().turnsByThread[key] ?? [];
      const round = useAgentReviewRoundStore.getState().roundsByThread[key];
      if (round) {
        const proposal = kind === "script" ? { proposedRules: aggregateScriptAgentCodeProposal(activities) } : aggregateExperienceCopilotProposal(activities);
        const next = updateAgentReviewKeys(round, proposal, kind === "script" ? ["rules"] : undefined);
        if (next !== round) useAgentReviewRoundStore.setState((s) => ({ roundsByThread: { ...s.roundsByThread, [key]: next } }));
      }
      await persistence.finish(threadId, watched).catch((error: unknown) => {
        // Preserve the original stream outcome; the next load/sync retries
        // reconciliation rather than treating a failed read as absent data.
        console.warn("[agent-review] settlement persistence failed", error);
      });
    }
  }

  return {
    runs: {
      ...agentThreadRuns,
      subscribe: async (threadId: string, after: number, opts: Parameters<typeof agentThreadRuns.subscribe>[2]) => {
        // Replay is observation, never a new turn: no preparation, flush or
        // checkpoint. The producer owns the anchor even after browser reload.
        await persistence.hydrate(threadId);
        opts.signal?.throwIfAborted();
        persistence.start(threadId);
        useAgentTurnStore.getState().clearTurn(kind, threadId);
        try { return await agentThreadRuns.subscribe(threadId, after, opts); }
        finally { await persistence.finish(threadId, false); }
      },
    },
    hydrate: (threadId: string) => persistence.hydrate(threadId),
    sync: (threadId: string) => persistence.sync(threadId),
    prepare,
    run,
  };
}
