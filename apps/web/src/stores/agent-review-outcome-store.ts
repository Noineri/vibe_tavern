import { create } from "zustand";
import type { ReviewTargetRecord } from "@vibe-tavern/api-contracts";
import { agentThreadKey, type AgentKind } from "../lib/agent-host-registry.js";

interface StoredOutcome {
  record: ReviewTargetRecord;
  appliedHunkIds: number[];
}

interface AgentReviewOutcomeState {
  outcomesByThread: Record<string, Partial<Record<ReviewTargetRecord["target"], StoredOutcome>>>;
  record: (kind: AgentKind, threadId: string, record: ReviewTargetRecord, appliedHunkIds?: readonly number[]) => void;
  get: (kind: AgentKind, threadId: string, target: ReviewTargetRecord["target"]) => ReviewTargetRecord | undefined;
  reset: (kind: AgentKind, threadId: string) => void;
}

/** Latest authoritative application result, intentionally independent of live review rounds. */
export const useAgentReviewOutcomeStore = create<AgentReviewOutcomeState>((set, get) => ({
  outcomesByThread: {},
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
  reset: (kind, threadId) => {
    const key = agentThreadKey(kind, threadId);
    set((state) => {
      if (!(key in state.outcomesByThread)) return state;
      const outcomesByThread = { ...state.outcomesByThread };
      delete outcomesByThread[key];
      return { outcomesByThread };
    });
  },
}));
