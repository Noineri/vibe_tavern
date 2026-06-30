import { create } from "zustand";
import type { AppMode, ThemeMode } from "../components/layout/app-shell-types.js";

/** Sidebar list sort modes (characters + chats are independent). */
export type ListSortMode = "alphabetical" | "recent";

export interface NavigationState {
  mode: AppMode;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  railForceOpen: number;
  characterSortMode: ListSortMode;
  chatSortMode: ListSortMode;
}

export interface NavigationActions {
  setMode: (mode: AppMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  triggerRailOpen: () => void;
  setCharacterSortMode: (mode: ListSortMode) => void;
  setChatSortMode: (mode: ListSortMode) => void;
}

export type NavigationStore = NavigationState & NavigationActions;

export const useNavigationStore = create<NavigationStore>()((set) => ({
  mode: "play",
  theme: "coffee",
  sidebarCollapsed: false,
  railForceOpen: 0,
  characterSortMode: "recent",
  chatSortMode: "recent",
  setMode: (mode) => set({ mode }),
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  triggerRailOpen: () => set(s => ({ railForceOpen: s.railForceOpen + 1 })),
  setCharacterSortMode: (mode) => set({ characterSortMode: mode }),
  setChatSortMode: (mode) => set({ chatSortMode: mode }),
}));

if (typeof window !== "undefined") window.__useNavigationStore = useNavigationStore;
