import { create } from "zustand";

/**
 * The sidechat's mobile tab (SIDECHAT_PLAN, Wave 4 / SC-15) — which pane the
 * RP mobile surface shows while the sidechat is open (`"chat"` | `"sidechat"`).
 *
 * A tiny shared UI store (not `PlayMode` local state) so SC-16 can switch the
 * tab from inside the sidechat (the copy-to-composer entry returns to `Chat`).
 * Ephemeral: defaults to `"chat"`, never persisted. The OPEN state stays where
 * SC-14 put it (the per-chat `vt.sidechat.open.<chatId>` localStorage key) —
 * this store only picks the visible pane while open.
 */
export type SidechatMobileTab = "chat" | "sidechat";

interface SidechatMobileState {
  tab: SidechatMobileTab;
  setTab: (tab: SidechatMobileTab) => void;
}

export const useSidechatMobileStore = create<SidechatMobileState>((set) => ({
  tab: "chat",
  setTab: (tab) =>
    set((s) => {
      // No-op when the value already matches — avoids a spurious re-render of
      // every subscriber (the PlayMode mobile branch and SC-16's entry).
      if (s.tab === tab) return s;
      return { tab };
    }),
}));

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores. Lets a live Playwright / dev-console session inspect the
// mobile tab to diagnose "wrong pane after handle tap".
if (typeof window !== "undefined") {
  (window as unknown as { __useSidechatMobileStore?: unknown }).__useSidechatMobileStore =
    useSidechatMobileStore;
}
