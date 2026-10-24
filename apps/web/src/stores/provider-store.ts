import { type SetStateAction } from "react";
import { create } from "zustand";
import { PROVIDER_PROFILE_GENERATION_DEFAULTS as D } from "@vibe-tavern/domain";
import type { ConnectionState } from "../components/layout/app-shell-types.js";

export interface ProviderState {
  connection: ConnectionState;
}

export interface ProviderActions {
  setConnection: (action: SetStateAction<ConnectionState>) => void;
  patchConnection: (patch: Partial<ConnectionState>) => void;
}

export type ProviderStore = ProviderState & ProviderActions;

export const useProviderStore = create<ProviderStore>()((set) => ({
  connection: {
    providerLabel: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    visionModel: "",
    activeProviderProfileId: null,
    hasStoredApiKey: false,
    status: "idle",
    error: "",
    models: [],
    providerType: "",
    providerPreset: "",
    temperature: D.temperature,
    topP: D.topP,
    minP: D.minP,
    topK: D.topK,
    topA: D.topA,
    frequencyPenalty: D.frequencyPenalty,
    presencePenalty: D.presencePenalty,
    repetitionPenalty: D.repetitionPenalty,
    maxTokens: D.maxTokens,
    stopSequences: [...D.stopSequences],
    seed: D.seed,
    reasoningEffort: D.reasoningEffort,
    showReasoning: D.showReasoning,
    streamResponse: D.streamResponse,
    customSamplers: D.customSamplers,
  },

  setConnection: (action) => set((state) => ({
    connection: typeof action === "function" ? action(state.connection) : action,
  })),
  patchConnection: (patch) =>
    set((state) => ({
      connection: {
        ...state.connection,
        ...patch,
        status: patch.status ?? state.connection.status,
      },
    })),
}));
