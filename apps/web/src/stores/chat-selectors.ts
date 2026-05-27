import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AppMessage } from "../app-client.js";
import { replaceUiMacros } from "../lib/macros.js";
import { countTokens } from "../utils/tokenizer.js";
import type { MacroContext } from "./snapshot-store.js";
import { useSnapshotStore } from "./snapshot-store.js";

// ---------------------------------------------------------------------------
// Backward-compatible selectors — now delegate to snapshot-store
// for reference stability via Immer. Remove after full migration.
// ---------------------------------------------------------------------------

/** @deprecated Use useSnapshotStore(s => s.messagesById[id]) directly */
export function useDisplayMessage(id: string): DisplayMessage | null {
  const message = useSnapshotStore((s) => s.messagesById[id]);
  const macroContext = useMacroContext();
  return useMemo((): DisplayMessage | null => {
    if (!message) return null;
    const displayContent = macroContext
      ? replaceUiMacros(message.content, macroContext)
      : message.content;
    return {
      ...message,
      displayContent,
      tokenCount: countTokens(displayContent),
    };
  }, [message, macroContext]);
}

/** @deprecated Use useSnapshotStore(s => s.messageOrder) directly */
export function useMessageOrder(): string[] {
  return useSnapshotStore((s) => s.messageOrder);
}

/** @deprecated Use useSnapshotStore directly */
export function useChatMeta() {
  return useSnapshotStore(
    useShallow((s) => {
      if (!s.character || !s.activeChat) return null;
      return {
        character: s.character,
        persona: s.persona,
        activeChat: s.activeChat,
        activeBranch: s.activeBranch,
        branches: s.branches,
        summaries: s.summaries,
        chats: s.chatIds.map((id) => s.chatsById[id]).filter(Boolean),
        allCharacters: s.allCharacters,
      };
    }),
  );
}

/** @deprecated Use useSnapshotStore selectors for macro context */
export function useMacroContext(): MacroContext | null {
  return useSnapshotStore(
    useShallow((s) => {
      if (!s.character) return null;
      return {
        characterName: s.character.name,
        personaName: s.persona?.name ?? null,
        personaDescription: s.persona?.description ?? null,
      };
    }),
  );
}

/**
 * Subscribe to the active prompt trace.
 * Derives from snapshot-store.
 */
export function useActiveTrace(
  selectedTraceId: string | null,
): import("@vibe-tavern/domain").PromptTraceRecordDto | import("@vibe-tavern/domain").AssemblePromptResponse | null {
  return useSnapshotStore(
    useShallow((state) => {
      const fromHistory =
        state.promptTraceHistory.find((trace) => trace.id === selectedTraceId) ??
        state.promptTrace ??
        state.promptTraceHistory[0];
      if (fromHistory) return fromHistory;
      if (state.contextPreview) return state.contextPreview;
      return null;
    }),
  );
}

// ---------------------------------------------------------------------------
// Types (unchanged)
// ---------------------------------------------------------------------------

export interface DisplayMessage extends AppMessage {
  displayContent: string;
  tokenCount: number;
}
