/**
 * Type declarations for dev-only window globals used for debugging.
 * These hooks are only assigned when typeof window !== "undefined".
 */

declare global {
  interface Window {
    __useCharacterStore: typeof import("../stores/character-store").useCharacterStore;
    __useChatStore: typeof import("../stores/chat-store").useChatStore;
    __useModalStore: typeof import("../stores/modal-store").useModalStore;
    __useNavigationStore: typeof import("../stores/navigation-store").useNavigationStore;
    __useSnapshotStore: typeof import("../stores/snapshot-store").useSnapshotStore;
    __setLorebookView: (view: "pick" | "list" | "editor") => void;
    __setLorebookTab: (tab: "lorebooks" | "scripts") => void;
    __getLorebookView: () => "pick" | "list" | "editor";
  }
}

export {};
