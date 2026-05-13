import { create } from "zustand";
import type { AppMode, ThemeMode } from "../components/app-shell-types.js";

export interface NavigationState {
  mode: AppMode;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
}

export interface NavigationActions {
  setMode: (mode: AppMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export type NavigationStore = NavigationState & NavigationActions;

export const useNavigationStore = create<NavigationStore>()((set) => ({
  mode: "play",
  theme: "dark",
  sidebarCollapsed: false,
  setMode: (mode) => set({ mode }),
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
