import { createSelector } from "reselect";
import { useShallow } from "zustand/react/shallow";
import type { AppMessage } from "../app-client.js";
import { replaceUiMacros } from "../lib/macros.js";
import { countTokens } from "../utils/tokenizer.js";
import type { MacroContext, ChatDataStore } from "./chat-data-store.js";
import { useChatDataStore } from "./chat-data-store.js";

// ---------------------------------------------------------------------------
// Input selectors (simple state slices)
// ---------------------------------------------------------------------------

const selectMessagesById = (state: ChatDataStore) => state.messagesById;
const selectMessageOrder = (state: ChatDataStore) => state.messageOrder;
const selectMacroContext = (state: ChatDataStore) => state.macroContext;
const selectChatMeta = (state: ChatDataStore) => state.chatMeta;
const selectPromptTrace = (state: ChatDataStore) => state.promptTrace;
const selectPromptTraceHistory = (state: ChatDataStore) => state.promptTraceHistory;
const selectContextPreview = (state: ChatDataStore) => state.contextPreview;

// ---------------------------------------------------------------------------
// Memoized per-message selectors via reselect
// ---------------------------------------------------------------------------

/**
 * Create a memoized selector for a single message's raw data.
 * Returns null if message ID not found.
 */
const selectMessageById = createSelector(
  [selectMessagesById, (_state: ChatDataStore, id: string) => id],
  (messagesById, id): AppMessage | null => messagesById[id] ?? null,
);

/**
 * Create a memoized selector for a message's display content (macros resolved).
 * Recomputes only when the message content or macro context changes.
 */
const selectDisplayContent = createSelector(
  [
    (state: ChatDataStore, id: string) => selectMessageById(state, id),
    selectMacroContext,
  ],
  (message, macroContext): string => {
    if (!message) return "";
    if (!macroContext) return message.content;
    return replaceUiMacros(message.content, macroContext);
  },
);

/**
 * Create a memoized selector for a message's token count.
 * Depends on display content — cache hit when content unchanged.
 */
const selectTokenCount = createSelector(
  [(state: ChatDataStore, id: string) => selectDisplayContent(state, id)],
  (displayContent): number => countTokens(displayContent),
);

// ---------------------------------------------------------------------------
// Combined display message selector
// ---------------------------------------------------------------------------

export interface DisplayMessage extends AppMessage {
  displayContent: string;
  tokenCount: number;
}

const selectDisplayMessage = createSelector(
  [
    (state: ChatDataStore, id: string) => selectMessageById(state, id),
    (state: ChatDataStore, id: string) => selectDisplayContent(state, id),
    (state: ChatDataStore, id: string) => selectTokenCount(state, id),
  ],
  (message, displayContent, tokenCount): DisplayMessage | null => {
    if (!message) return null;
    return { ...message, displayContent, tokenCount };
  },
);

// ---------------------------------------------------------------------------
// React hook wrappers — subscribe to minimal state slice
// ---------------------------------------------------------------------------

/** Subscribe to a single message's display data. Returns null if not found. */
export function useDisplayMessage(id: string): DisplayMessage | null {
  return useChatDataStore((state) => selectDisplayMessage(state, id));
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
