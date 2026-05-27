import { useEffect, useLayoutEffect, useState, useMemo } from "react";
import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import { getT } from "../i18n/context.js";
import type { ConnectionState } from "../components/app-shell-types.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { useNavigationStore, useProviderStore, useChatStore, useModalStore } from "../stores/index.js";
import { useBootstrapStore, fetchBootstrapAction, fetchPersonasAction } from "../stores/api-actions/bootstrap-actions.js";
import { useChatDataStore } from "../stores/chat-data-store.js";
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
  const snapshotRaw = useChatDataStore((s) => s.chatMeta);
  const messagesById = useChatDataStore((s) => s.messagesById);
  const promptTrace = useChatDataStore((s) => s.promptTrace);
  const promptTraceHistory = useChatDataStore((s) => s.promptTraceHistory);
  const contextPreview = useChatDataStore((s) => s.contextPreview);

  const snapshot = useMemo(() => {
    if (!activeChatId || !snapshotRaw) return null;
    if (snapshotRaw.activeChat.id !== activeChatId) return null; // Avoid returning old snapshot for new activeChatId until loaded
    return {
      character: snapshotRaw.character,
      persona: snapshotRaw.persona,
      activeChat: snapshotRaw.activeChat,
      activeBranch: snapshotRaw.activeBranch,
      branches: snapshotRaw.branches,
      summaries: snapshotRaw.summaries,
      messages: Object.values(messagesById),
      chats: snapshotRaw.chats, // chats list is in snapshot!
      allCharacters: snapshotRaw.allCharacters,
      promptTrace,
      promptTraceHistory,
      contextPreview,
    };
  }, [activeChatId, snapshotRaw, messagesById, promptTrace, promptTraceHistory, contextPreview]);

  const selectedTraceId = useChatStore((s) => s.selectedTraceId);
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

  // --- Keep selectedTraceId in sync with snapshot ---
  useEffect(() => {
    useChatStore.getState().setSelectedTraceId(
      snapshot?.promptTrace?.id ?? snapshot?.promptTraceHistory[0]?.id ?? null,
    );
    if (!editingMessageId || !snapshot) return;
    const stillExists = snapshot.messages.some((message: AppMessage) => message.id === editingMessageId);
    if (!stillExists) {
      useChatStore.getState().setEditingMessageId(null);
      useChatStore.getState().setEditingDraft("");
    }
  }, [snapshot?.promptTrace?.id, snapshot?.promptTraceHistory, editingMessageId, snapshot]);

  return {
    isLoading,
    loadError,
    snapshot,
    tweaksSettings,
    setTweaksSettings,
  };
}
