import { useEffect, useLayoutEffect, useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import { getT } from "../i18n/context.js";
import type { ConnectionState } from "../components/app-shell-types.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { useNavigationStore, useProviderStore, useChatStore, useModalStore } from "../stores/index.js";
import { useBootstrapStore, fetchBootstrapAction, fetchPersonasAction } from "../stores/api-actions/bootstrap-actions.js";
import { useChatList, useSnapshotStore } from "../stores/snapshot-store.js";
import type { AppMessage } from "../app-client.js";
import {
  readSavedTheme,
  persistTheme,
  persistTweaks,
  readSavedTweaks,
  type TweaksSettings,
  MESSAGE_WIDTH_MAP,
} from "../lib/local-storage.js";
import { extractTokenFromHash, saveMobileToken, clearMobileToken } from "../lib/mobile-token.js";

function createInitialConnectionState(): ConnectionState {
  const envDefaults = {
    providerLabel: import.meta.env.VITE_RP_DEFAULT_PROVIDER_LABEL || "OpenAI-compatible",
    baseUrl: import.meta.env.VITE_RP_DEFAULT_BASE_URL || "",
    model: import.meta.env.VITE_RP_DEFAULT_MODEL || "",
  };
  const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(envDefaults.baseUrl);

  return {
    providerLabel: envDefaults.providerLabel,
    baseUrl: normalizedBaseUrl,
    apiKey: "",
    model: envDefaults.model,
    activeProviderProfileId: null,
    hasStoredApiKey: false,
    status: "idle",
    error: "",
    models: [],
    providerType: PROVIDER_TYPE.openaiCompat,
    providerPreset: "",
    temperature: 1.0,
    topP: 1.0,
    minP: 0,
    topK: 0,
    topA: 0,
    frequencyPenalty: 0.0,
    presencePenalty: 0.0,
    repetitionPenalty: 1.0,
    maxTokens: 2000,
    stopSequences: [],
    seed: null,
    reasoningEffort: "auto",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
  };
}

/**
 * Thin bootstrap hook: loads persisted state, runs theme/CSS effects,
 * provides bootstrap query data for App.tsx loading/error screens.
 *
 * All business logic lives in sub-hooks:
 *   useChatController, useCharacterController, useProviderProfiles, usePresetController
 * Components import sub-hooks directly — not through this hook.
 */
export function useRpPlatformApp() {
  const [loadError, setLoadError] = useState("");

  const isLoading = useBootstrapStore((s) => s.isLoading);
  const bootstrapData = useBootstrapStore((s) => s.data);

  // Initial load
  useEffect(() => {
    async function load() {
      try {
        // Extract mobile token from URL hash if present
        const hashToken = extractTokenFromHash();
        if (hashToken) {
          saveMobileToken(hashToken);
        }

        await Promise.all([
          fetchBootstrapAction(),
          fetchPersonasAction(),
        ]);
      } catch (err) {
        // If 401 and we have a stored token, it's invalid — clear it
        if (err instanceof Error && (err.message.includes("401") || err.message.includes("Unauthorized"))) {
          clearMobileToken();
        }
        setLoadError(err instanceof Error ? err.message : getT()("could_not_load_app_state"));
      }
    }
    void load();
  }, []);

  // Reactive snapshot for AppShell effects
  const activeChatId = useChatStore((s) => s.activeChatId);
  const snapshotRaw = useSnapshotStore(
    useShallow((s) => ({
      character: s.character,
      persona: s.persona,
      activeChat: s.activeChat,
      activeBranch: s.activeBranch,
      branches: s.branches,
      summaries: s.summaries,
      allCharacters: s.allCharacters,
    })),
  );
  const chats = useChatList();
  const messagesById = useSnapshotStore((s) => s.messagesById);
  const messageOrder = useSnapshotStore((s) => s.messageOrder);
  const promptTrace = useSnapshotStore((s) => s.promptTrace);
  const promptTraceHistory = useSnapshotStore((s) => s.promptTraceHistory);
  const contextPreview = useSnapshotStore((s) => s.contextPreview);

  const snapshot = useMemo(() => {
    if (!activeChatId || !snapshotRaw.activeChat || !snapshotRaw.character || !snapshotRaw.activeBranch) return null;
    if (snapshotRaw.activeChat.id !== activeChatId) return null; // Avoid returning old snapshot for new activeChatId until loaded
    return {
      character: snapshotRaw.character,
      persona: snapshotRaw.persona,
      activeChat: snapshotRaw.activeChat,
      activeBranch: snapshotRaw.activeBranch,
      branches: snapshotRaw.branches,
      summaries: snapshotRaw.summaries,
      messages: messageOrder
        .map((id) => messagesById[id])
        .filter((message): message is AppMessage => Boolean(message)),
      chats, // chats list is in snapshot!
      allCharacters: snapshotRaw.allCharacters,
      promptTrace,
      promptTraceHistory,
      contextPreview,
    };
  }, [activeChatId, snapshotRaw, messagesById, messageOrder, chats, promptTrace, promptTraceHistory, contextPreview]);

  const editingMessageId = useChatStore((s) => s.editingMessageId);

  const theme = useNavigationStore((s) => s.theme);

  // Local tweak state (not in a store — only needed by AppShell/TweaksPanel)
  const [tweaksSettings, setTweaksSettings] = useState<TweaksSettings>(() => readSavedTweaks());

  // --- Bootstrap: load persisted theme and connection defaults ---
  useLayoutEffect(() => {
    useNavigationStore.getState().setTheme(readSavedTheme());
    useProviderStore.getState().setConnection(createInitialConnectionState());
  }, []);

  // --- Theme + CSS effects ---
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--mfs', `${tweaksSettings.fontSize}px`);
    root.style.setProperty('--ui-fs', `${tweaksSettings.uiFontSize}px`);
    root.style.setProperty('--mw', MESSAGE_WIDTH_MAP[tweaksSettings.messageWidth]);
    persistTweaks(tweaksSettings);
    root.classList.toggle("light", theme === "light");
    persistTheme(theme);
  }, [tweaksSettings, theme]);

  const promptTraceId = promptTrace?.id ?? null;
  const firstPromptTraceHistoryId = promptTraceHistory[0]?.id ?? null;

  // --- Keep selectedTraceId/editing state in sync with primitive snapshot facts ---
  useEffect(() => {
    const nextSelectedTraceId = promptTraceId ?? firstPromptTraceHistoryId ?? null;
    const chatState = useChatStore.getState();
    if (chatState.selectedTraceId !== nextSelectedTraceId) {
      chatState.setSelectedTraceId(nextSelectedTraceId);
    }

    if (!editingMessageId) return;
    const stillExists = messageOrder.includes(editingMessageId);
    if (!stillExists) {
      chatState.setEditingMessageId(null);
      if (chatState.editingDraft !== "") {
        chatState.setEditingDraft("");
      }
    }
  }, [promptTraceId, firstPromptTraceHistoryId, editingMessageId, messageOrder]);

  return {
    isLoading,
    loadError,
    snapshot,
    tweaksSettings,
    setTweaksSettings,
  };
}
