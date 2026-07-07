import { create } from "zustand";

export interface SessionState {
  revoked: boolean;
}

export interface SessionActions {
  markRevoked: () => void;
  reset: () => void;
}

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>()((set) => ({
  revoked: false,
  markRevoked: () => set({ revoked: true }),
  reset: () => set({ revoked: false }),
}));

if (typeof window !== "undefined") window.__useSessionStore = useSessionStore;
