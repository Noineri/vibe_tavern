import { create } from "zustand";
import type { ReviewTargetRecord } from "@vibe-tavern/api-contracts";
import { agentThreadKey, type AgentKind } from "../lib/agent-host-registry.js";

interface StoredOutcome {
  record: ReviewTargetRecord;
  appliedHunkIds: number[];
}

interface AgentReviewOutcomeState {
  outcomesByThread: Record<string, Partial<Record<ReviewTargetRecord["target"], StoredOutcome>>>;
  supersededByThread: Record<string, ReviewTargetRecord[]>;
  record: (kind: AgentKind, threadId: string, record: ReviewTargetRecord, appliedHunkIds?: readonly number[]) => void;
  get: (kind: AgentKind, threadId: string, target: ReviewTargetRecord["target"]) => ReviewTargetRecord | undefined;
  reset: (kind: AgentKind, threadId: string) => void;
  supersede: (kind: AgentKind, threadId: string, target: ReviewTargetRecord["target"], roundId: string) => void;
}

/** Latest authoritative application result, intentionally independent of live review rounds. */
export const useAgentReviewOutcomeStore = create<AgentReviewOutcomeState>((set, get) => ({
  outcomesByThread: {},
  supersededByThread: {},
  record: (kind, threadId, record, appliedHunkIds = []) => {
    const key = agentThreadKey(kind, threadId);
    set((state) => ({
      outcomesByThread: {
        ...state.outcomesByThread,
        [key]: { ...state.outcomesByThread[key], [record.target]: { record, appliedHunkIds: [...appliedHunkIds] } },
      },
    }));
  },
  get: (kind, threadId, target) => get().outcomesByThread[agentThreadKey(kind, threadId)]?.[target]?.record,
  supersede: (kind, threadId, target, roundId) => {
    const key = agentThreadKey(kind, threadId);
    set((state) => {
      const prior = state.outcomesByThread[key]?.[target];
      if (!prior || prior.record.roundId === roundId) return state;
      const superseded = { ...prior.record, outcome: "superseded" as const, supersededByRound: roundId };
      return {
        outcomesByThread: { ...state.outcomesByThread, [key]: { ...state.outcomesByThread[key], [target]: { record: { target, roundId, outcome: "awaiting" }, appliedHunkIds: [] } } },
        supersededByThread: { ...state.supersededByThread, [key]: [...(state.supersededByThread[key] ?? []).filter((record) => record.target !== target), superseded] },
      };
    });
  },
  reset: (kind, threadId) => {
    const key = agentThreadKey(kind, threadId);
    set((state) => {
      if (!(key in state.outcomesByThread)) return state;
      const outcomesByThread = { ...state.outcomesByThread };
      const supersededByThread = { ...state.supersededByThread };
      delete outcomesByThread[key];
      delete supersededByThread[key];
      return { outcomesByThread, supersededByThread };
    });
  },
}));
