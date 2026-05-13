import { create } from "zustand";
import type { ConnectionState } from "../components/app-shell-types.js";
import type { AppMode, ThemeMode } from "../components/app-shell-types.js";

export interface NavigationState {
  mode: AppMode;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  isProviderModalOpen: boolean;
  isPromptManagerOpen: boolean;
  isPersonaModalOpen: boolean;
  connection: ConnectionState;
}

export interface NavigationActions {
  setMode: (mode: AppMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setIsProviderModalOpen: (open: boolean) => void;
  setIsPromptManagerOpen: (open: boolean) => void;
  setIsPersonaModalOpen: (open: boolean) => void;
  setConnection: (connection: ConnectionState) => void;
  patchConnection: (patch: Partial<ConnectionState>) => void;
}

export type NavigationStore = NavigationState & NavigationActions;

export const useNavigationStore = create<NavigationStore>()((set) => ({
  mode: "play",
  theme: "dark",
  sidebarCollapsed: false,
  isProviderModalOpen: false,
  isPromptManagerOpen: false,
  isPersonaModalOpen: false,
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
    temperature: 0.9,
    topP: 1.0,
    minP: 0.05,
    topK: 40,
    topA: 0,
    frequencyPenalty: 0.0,
    presencePenalty: 0.0,
    repetitionPenalty: 1.1,
    maxTokens: 8192,
    stopSequences: [],
    seed: null,
    reasoningEffort: "medium",
    streamResponse: true,
  },

  setMode: (mode) => set({ mode }),
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setIsProviderModalOpen: (open) => set({ isProviderModalOpen: open }),
  setIsPromptManagerOpen: (open) => set({ isPromptManagerOpen: open }),
  setIsPersonaModalOpen: (open) => set({ isPersonaModalOpen: open }),
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
