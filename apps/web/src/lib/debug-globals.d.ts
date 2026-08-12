/**
 * Type declarations for dev-only window globals used for debugging.
 * These hooks are only assigned when typeof window !== "undefined".
 */

declare global {
  interface Window {
    __useCharacterStore: typeof import("../stores/character-store").useCharacterStore;
    __useChatStore: typeof import("../stores/chat-store").useChatStore;
    __useGenerationQueueStore: typeof import("../stores/generation-queue-store").useGenerationQueueStore;
    __useDiceStore: typeof import("../stores/dice-store").useDiceStore;
    __useModalStore: typeof import("../stores/modal-store").useModalStore;
    __useNavigationStore: typeof import("../stores/navigation-store").useNavigationStore;
    __useSnapshotStore: typeof import("../stores/snapshot-store").useSnapshotStore;
    __useCoauthorTurnStore: typeof import("../stores/coauthor-turn-store").useCoauthorTurnStore;
    __useExperienceCopilotTurnStore: typeof import("../stores/experience-copilot-turn-store").useExperienceCopilotTurnStore;
    __useSessionStore: typeof import("../stores/session-store").useSessionStore;
    __useSceneRenderStore: typeof import("../stores/scene-render-store").useSceneRenderStore;
    __useCoauthorSkillStore: typeof import("../stores/coauthor-skill-store").useCoauthorSkillStore;
    __useMessageAiEditorStore: typeof import("../stores/message-ai-editor-store").useMessageAiEditorStore;
    __setLorebookView: (view: "pick" | "list" | "editor") => void;
    __setLorebookTab: (tab: "lorebooks" | "scripts") => void;
    __getLorebookView: () => "pick" | "list" | "editor";
  }
}

export {};
