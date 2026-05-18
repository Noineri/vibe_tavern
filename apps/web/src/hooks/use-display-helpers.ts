import { useMemo } from "react";
import type { AssemblePromptResponse, PromptTraceRecordDto } from "@rp-platform/domain";
import type { AppMessage, AppSnapshot } from "../app-client.js";
import { useChatStore, useProviderStore, useChatDataStore, useMessageOrder, useChatMeta, useMacroContext, useActiveTrace } from "../stores/index.js";
import { replaceUiMacros } from "../lib/macros.js";
import { buildCharacterTabs } from "../lib/character-tabs.js";

type ActiveTraceLike = PromptTraceRecordDto | AssemblePromptResponse;

export interface DisplayHelpers {
  activePromptTrace: ActiveTraceLike | null;
  promptPayloadText: string;
  displayScenario: string;
  displayMessages: AppMessage[];
  displayPendingUserMessageContent: string | null;
  displayAlternateGreetings: string[];
  characterTabs: ReturnType<typeof buildCharacterTabs>;
  canUseLiveApi: boolean;
}

export function useDisplayHelpers(
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>,
  snapshot: AppSnapshot | null,
): DisplayHelpers {
  const selectedTraceId = useChatStore((s) => s.selectedTraceId);
  const pendingUserMessageContent = useChatStore((s) => s.pendingUserMessageContent);
  const connection = useProviderStore((s) => s.connection);

  // Read from normalized store
  const messageOrder = useMessageOrder();
  const macroContext = useMacroContext();
  const activePromptTrace = useActiveTrace(selectedTraceId);

  const promptPayloadText = useMemo(
    () => JSON.stringify(activePromptTrace?.finalPayload ?? {}, null, 2),
    [activePromptTrace],
  );

  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);

  const characterTabs = useMemo(
    () => buildCharacterTabs(allCharacters, snapshot?.chats ?? []),
    [allCharacters, snapshot],
  );

  const displayScenario = useMemo(
    () => macroContext && snapshot
      ? replaceUiMacros(snapshot.character.scenario, macroContext)
      : "",
    [macroContext, snapshot],
  );

  // Build displayMessages from normalized store.
  // Reads raw messages from messagesById, applies macro resolution.
  // In Wave B, MessageBlock will use useDisplayMessage(id) directly and this becomes unused.
  const displayMessages = useMemo(() => {
    if (!macroContext) return [];
    const state = useChatDataStore.getState();
    return messageOrder
      .map((id) => state.messagesById[id])
      .filter((msg): msg is AppMessage => Boolean(msg))
      .map((message): AppMessage => ({
        ...message,
        content: replaceUiMacros(message.content, macroContext),
      }));
  }, [messageOrder, macroContext]);

  const displayPendingUserMessageContent = useMemo(
    () => pendingUserMessageContent && macroContext
      ? replaceUiMacros(pendingUserMessageContent, macroContext)
      : pendingUserMessageContent,
    [macroContext, pendingUserMessageContent],
  );

  const displayAlternateGreetings = useMemo(
    () => macroContext && snapshot
      ? snapshot.character.alternateGreetings.map((g) => replaceUiMacros(g, macroContext))
      : [],
    [macroContext, snapshot],
  );

  return {
    activePromptTrace,
    promptPayloadText,
    displayScenario,
    displayMessages,
    displayPendingUserMessageContent,
    displayAlternateGreetings,
    characterTabs,
    canUseLiveApi,
  };
}
