import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AppMessage } from "../app-client.js";
import { replaceUiMacros } from "../lib/macros.js";
import { countTokens } from "../utils/tokenizer.js";
import type { MacroContext } from "./snapshot-store.js";
import { useChatList, useSnapshotStore } from "./snapshot-store.js";

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

/** @deprecated Use focused snapshot-store selectors directly */
export function useChatMeta() {
  const character = useSnapshotStore((s) => s.character);
  const persona = useSnapshotStore((s) => s.persona);
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranch = useSnapshotStore((s) => s.activeBranch);
  const branches = useSnapshotStore((s) => s.branches);
  const summaries = useSnapshotStore((s) => s.summaries);
  const chats = useChatList();
  const allCharacters = useSnapshotStore((s) => s.allCharacters);

  return useMemo(() => {
    if (!character || !activeChat) return null;
    return {
      character,
      persona,
      activeChat,
      activeBranch,
      branches,
      summaries,
      chats,
      allCharacters,
    };
  }, [character, persona, activeChat, activeBranch, branches, summaries, chats, allCharacters]);
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
