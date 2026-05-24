import { createSelector } from "reselect";
import { useShallow } from "zustand/react/shallow";
import { useMemo } from "react";
import type { AppMessage } from "../app-client.js";
import { replaceUiMacros } from "../lib/macros.js";
import { countTokens } from "../utils/tokenizer.js";
import type { MacroContext, ChatDataStore } from "./chat-data-store.js";
import { useChatDataStore } from "./chat-data-store.js";

// ---------------------------------------------------------------------------
// Input selectors (simple state slices)
// ---------------------------------------------------------------------------

const selectMessageOrder = (state: ChatDataStore) => state.messageOrder;
const selectMacroContext = (state: ChatDataStore) => state.macroContext;
const selectChatMeta = (state: ChatDataStore) => state.chatMeta;
const selectPromptTrace = (state: ChatDataStore) => state.promptTrace;
const selectPromptTraceHistory = (state: ChatDataStore) => state.promptTraceHistory;
const selectContextPreview = (state: ChatDataStore) => state.contextPreview;

// ---------------------------------------------------------------------------
// Combined display message selector & types
// ---------------------------------------------------------------------------

export interface DisplayMessage extends AppMessage {
  displayContent: string;
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// React hook wrappers — subscribe to minimal state slice
// ---------------------------------------------------------------------------

/** Subscribe to a single message's display data. Returns null if not found. */
export function useDisplayMessage(id: string): DisplayMessage | null {
  const selector = useMemo(
    () =>
      createSelector(
        [
          (state: ChatDataStore) => state.messagesById[id],
          (state: ChatDataStore) => state.macroContext,
        ],
        (message, macroContext): DisplayMessage | null => {
          if (!message) return null;
          const displayContent = macroContext
            ? replaceUiMacros(message.content, macroContext)
            : message.content;
          return {
            ...message,
            displayContent,
            tokenCount: countTokens(displayContent),
          };
        }
      ),
    [id]
  );
  return useChatDataStore(selector);
}

/** Subscribe to the ordered list of message IDs. */
export function useMessageOrder(): string[] {
  return useChatDataStore(selectMessageOrder);
}

/** Subscribe to chat metadata (character, persona, branches, summaries). */
export function useChatMeta() {
  return useChatDataStore(selectChatMeta);
}

/** Subscribe to macro context. */
export function useMacroContext() {
  return useChatDataStore(selectMacroContext);
}

/**
 * Subscribe to the active prompt trace.
 * Derives from promptTraceHistory, promptTrace, contextPreview, selectedTraceId.
 */
export function useActiveTrace(
  selectedTraceId: string | null,
): import("@rp-platform/domain").PromptTraceRecordDto | import("@rp-platform/domain").AssemblePromptResponse | null {
  return useChatDataStore(
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
