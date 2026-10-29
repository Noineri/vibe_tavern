import { create } from "zustand";

/**
 * Agent streaming mirror (DIRECTOR_MODE_PLAN DR-11) — which agent-shell
 * owners currently have a turn STREAMING, keyed by `agentOwnerKey` (the
 * shell's owner identity: `chat:<chatId>:<branchId>:<agentKind>` /
 * `script:<scriptId>`).
 *
 * `useAgentController`'s `isSending` is LOCAL hook state — correct for the
 * shell that owns the turn, unreadable from outside it. The controller
 * PUBLISHES a one-way derived copy here (a WRITE from its existing state
 * machine; the controller stays the only truth — nothing ever writes back).
 * Readers outside the shell subscribe by owner key: the story strip's
 * «Позвать режиссёра» disables while the sidechat of the same chat+branch
 * streams (mock §4).
 *
 * A tiny shared UI store (canon: plain store for UI state — the
 * `sidechat-mobile-store` pattern): ephemeral, never persisted, no Immer.
 */
interface AgentStreamingState {
  streaming: Readonly<Record<string, boolean>>;
  setStreaming: (key: string, streaming: boolean) => void;
}

export const useAgentStreamingStore = create<AgentStreamingState>((set) => ({
  streaming: {},
  // No-op writes keep subscribers from re-rendering on unchanged flags; a
  // `false` for an absent key deletes nothing (same discipline as
  // sidechat-mobile-store's tab guard).
  setStreaming: (key, streaming) =>
    set((s) => {
      if (Boolean(s.streaming[key]) === streaming) return s;
      if (!streaming) {
        if (s.streaming[key] === undefined) return s;
        const next = { ...s.streaming };
        delete next[key];
        return { streaming: next };
      }
      return { streaming: { ...s.streaming, [key]: true } };
    }),
}));

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores (a live Playwright / dev-console session can inspect who
// is streaming to diagnose a stuck disable).
if (typeof window !== "undefined") {
  (window as unknown as { __useAgentStreamingStore?: unknown }).__useAgentStreamingStore =
    useAgentStreamingStore;
}
