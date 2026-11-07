import { create } from "zustand";

/**
 * The story curtain's tab choice (DIRECTOR_DECK_CALENDAR_PLAN DK-6, mockup
 * §1/§7) — which of the three tabs (events / deck / calendar, the i18n keys
 * story_deck_tab_*) the story plan's curtain body shows, remembered per chat
 * so reopening the curtain lands on where the user left off. Default events
 * (the events body — today's curtain content, byte-identical).
 *
 * Keyed by CHAT (not branch): the tab row lives on the curtain of the
 * active branch, and a branch switch keeping the chosen tab is the
 * remembered-per-chat behavior the mockup note pins ("remembered per chat;
 * default events").
 *
 * Plain zustand store (UI state, not canonical data).
 */
export const STORY_CURTAIN_TABS = {
  events: "events",
  deck: "deck",
  calendar: "calendar",
} as const;

export type StoryCurtainTab = (typeof STORY_CURTAIN_TABS)[keyof typeof STORY_CURTAIN_TABS];

/** The tab a chat without a stored choice shows (§1: default events). */
export const DEFAULT_STORY_CURTAIN_TAB: StoryCurtainTab = STORY_CURTAIN_TABS.events;

interface StoryCurtainTabState {
  /** The chosen tab per chat id — absence reads as the default. */
  tabsByChat: Record<string, StoryCurtainTab>;
  setTab: (chatId: string, tab: StoryCurtainTab) => void;
}

export const useStoryCurtainTabStore = create<StoryCurtainTabState>((set) => ({
  tabsByChat: {},
  setTab: (chatId, tab) =>
    set((s) => ({ tabsByChat: { ...s.tabsByChat, [chatId]: tab } })),
}));

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores (diagnosing "the deck tab reset itself" reports).
if (typeof window !== "undefined") {
  (window as unknown as { __useStoryCurtainTabStore?: unknown }).__useStoryCurtainTabStore =
    useStoryCurtainTabStore;
}
