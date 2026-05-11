import { useMemo } from "react";
import type { AppMessage, AppSnapshot } from "../app-client.js";
import { useChatStore, useNavigationStore } from "../stores/index.js";
import { replaceUiMacros } from "../lib/macros.js";
import { buildCharacterTabs } from "../lib/character-tabs.js";

export interface DisplayHelpers {
  activePromptTrace: ReturnType<typeof deriveActivePromptTrace>;
  promptPayloadText: string;
  displayScenario: string;
  displayMessages: AppMessage[];
  displayPendingUserMessageContent: string | null;
  displayAlternateGreetings: string[];
  characterTabs: ReturnType<typeof buildCharacterTabs>;
  canUseLiveApi: boolean;
}

function deriveActivePromptTrace(
  snapshot: AppSnapshot | null,
  selectedTraceId: string | null,
) {
  if (!snapshot) return null;
  return (
    snapshot.promptTraceHistory.find((trace) => trace.id === selectedTraceId) ??
    snapshot.promptTrace ??
    snapshot.promptTraceHistory[0] ??
    null
  );
}

export function useDisplayHelpers(
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>,
): DisplayHelpers {
  const snapshot = useChatStore((s) => s.snapshot);
  const selectedTraceId = useChatStore((s) => s.selectedTraceId);
  const pendingUserMessageContent = useChatStore((s) => s.pendingUserMessageContent);
  const connection = useNavigationStore((s) => s.connection);

  const activePromptTrace = useMemo(
    () => deriveActivePromptTrace(snapshot, selectedTraceId),
    [selectedTraceId, snapshot],
  );

  const promptPayloadText = useMemo(
    () => JSON.stringify(activePromptTrace?.finalPayload ?? {}, null, 2),
    [activePromptTrace],
  );

  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);

  const characterTabs = useMemo(
    () => buildCharacterTabs(allCharacters, snapshot?.chats ?? []),
    [allCharacters, snapshot],
  );

  const macroContext = useMemo(
    () => snapshot ? {
      characterName: snapshot.character.name,
      personaName: snapshot.persona?.name ?? null,
      personaDescription: snapshot.persona?.description ?? null,
    } : null,
    [snapshot],
  );

  const displayScenario = useMemo(
    () => snapshot && macroContext ? replaceUiMacros(snapshot.character.scenario, macroContext) : "",
    [macroContext, snapshot],
  );

  const displayMessages = useMemo(
    () => snapshot && macroContext
      ? snapshot.messages.map((message): AppMessage => ({
        ...message,
        content: replaceUiMacros(message.content, macroContext),
      }))
      : [],
    [macroContext, snapshot],
  );

  const displayPendingUserMessageContent = useMemo(
    () => pendingUserMessageContent && macroContext
      ? replaceUiMacros(pendingUserMessageContent, macroContext)
      : pendingUserMessageContent,
    [macroContext, pendingUserMessageContent],
  );

  const displayAlternateGreetings = useMemo(
    () => snapshot && macroContext
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
