import { create } from "zustand";
import type { AppMode, ThemeMode } from "../components/layout/app-shell-types.js";

export interface NavigationState {
  mode: AppMode;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  railForceOpen: number;
}

export interface NavigationActions {
  setMode: (mode: AppMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  triggerRailOpen: () => void;
}

export type NavigationStore = NavigationState & NavigationActions;

export const useNavigationStore = create<NavigationStore>()((set) => ({
  mode: "play",
  theme: "dark",
  sidebarCollapsed: false,
  railForceOpen: 0,
  setMode: (mode) => set({ mode }),
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  triggerRailOpen: () => set(s => ({ railForceOpen: s.railForceOpen + 1 })),
}));

if (typeof window !== "undefined") window.__useNavigationStore = useNavigationStore;
