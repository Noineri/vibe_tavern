import { create } from "zustand";
import type { ConnectionState } from "../components/app-shell-types.js";

export interface ProviderState {
  connection: ConnectionState;
}

export interface ProviderActions {
  setConnection: (connection: ConnectionState) => void;
  patchConnection: (patch: Partial<ConnectionState>) => void;
}

export type ProviderStore = ProviderState & ProviderActions;

export const useProviderStore = create<ProviderStore>()((set) => ({
  connection: {
    providerLabel: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    activeProviderProfileId: null,
    hasStoredApiKey: false,
    status: "idle",
    error: "",
    models: [],
    providerType: "",
    providerPreset: "",
    temperature: 1.0,
    topP: 1.0,
    minP: 0,
    topK: 0,
    topA: 0,
    frequencyPenalty: 0.0,
    presencePenalty: 0.0,
    repetitionPenalty: 1.0,
    maxTokens: 2000,
    stopSequences: [],
    seed: null,
    reasoningEffort: "auto",
    streamResponse: true,
    customSamplers: false,
  },

  setConnection: (connection) => set({ connection }),
  patchConnection: (patch) =>
    set((state) => ({
      connection: {
        ...state.connection,
        ...patch,
        status: patch.status ?? state.connection.status,
      },
    })),
}));
