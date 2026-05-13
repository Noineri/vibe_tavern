import { create } from "zustand";
import type { AppMode, ThemeMode } from "../components/app-shell-types.js";

export interface NavigationState {
  mode: AppMode;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  isProviderModalOpen: boolean;
  isPromptManagerOpen: boolean;
  isPersonaModalOpen: boolean;
}

export interface NavigationActions {
  setMode: (mode: AppMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setIsProviderModalOpen: (open: boolean) => void;
  setIsPromptManagerOpen: (open: boolean) => void;
  setIsPersonaModalOpen: (open: boolean) => void;
}

export type NavigationStore = NavigationState & NavigationActions;

export const useNavigationStore = create<NavigationStore>()((set) => ({
  mode: "play",
  theme: "dark",
  sidebarCollapsed: false,
  isProviderModalOpen: false,
  isPromptManagerOpen: false,
  isPersonaModalOpen: false,

  setMode: (mode) => set({ mode }),
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setIsProviderModalOpen: (open) => set({ isProviderModalOpen: open }),
  setIsPromptManagerOpen: (open) => set({ isPromptManagerOpen: open }),
  setIsPersonaModalOpen: (open) => set({ isPersonaModalOpen: open }),
}));
