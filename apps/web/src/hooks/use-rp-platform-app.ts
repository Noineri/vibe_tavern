import { type SetStateAction, useEffect, useRef, useState } from "react";
import type { ChatId } from "@rp-platform/domain";
import { PROVIDER_TYPE } from "@rp-platform/domain";
import {
  bootstrapApp,
  listPersonas,
  summarizeChat,
  saveChatSummary,
  type AppSnapshot,
} from "../app-client.js";
import type { ConnectionState } from "../components/app-shell-types.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { useCharacterImport } from "./use-character-import.js";
import { useProviderProfiles } from "./use-provider-profiles.js";
import { useChatController } from "./use-chat-controller.js";
import { useCharacterController } from "./use-character-controller.js";
import { usePresetController } from "./use-preset-controller.js";
import { useDisplayHelpers } from "./use-display-helpers.js";
import { useChatStore, useNavigationStore, useCharacterStore } from "../stores/index.js";
import {
  readSavedTheme,
  persistTheme,
  readSavedConnectionState,
  persistConnectionState,
  persistTweaks,
  readSavedTweaks,
  type TweaksSettings,
  MESSAGE_WIDTH_MAP,
} from "../lib/local-storage.js";

function createInitialConnectionState(): ConnectionState {
  const envDefaults = {
    providerLabel: import.meta.env.VITE_RP_DEFAULT_PROVIDER_LABEL || "OpenAI-compatible",
    baseUrl: import.meta.env.VITE_RP_DEFAULT_BASE_URL || "",
    model: import.meta.env.VITE_RP_DEFAULT_MODEL || "",
  };
  const saved = readSavedConnectionState();
  const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(saved?.baseUrl || envDefaults.baseUrl);

  return {
    providerLabel: saved?.providerLabel || envDefaults.providerLabel,
    baseUrl: normalizedBaseUrl,
    apiKey: "",
    model: saved?.model || envDefaults.model,
    activeProviderProfileId: null,
    hasStoredApiKey: false,
    status: "idle",
    error: "",
    models: [],
    providerType: PROVIDER_TYPE.openaiCompat,
    providerPreset: "",
    temperature: 0.9,
    topP: 1.0,
    minP: 0.05,
    topK: 40,
    typicalP: 1.0,
    repPen: 1.1,
    freqPen: 0.0,
    presPen: 0.0,
    maxTokens: 8192,
    stopSeq: "",
    seed: null,
    reasoningEffort: "medium",
    streamResponse: true,
  };
}

export function useRpPlatformApp() {
  // --- Chat store subscriptions ---
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const snapshot = useChatStore((s) => s.snapshot);
  const draft = useChatStore((s) => s.draft);
  const isSending = useChatStore((s) => s.isSending);
  const selectedTraceId = useChatStore((s) => s.selectedTraceId);
  const editingMessageId = useChatStore((s) => s.editingMessageId);
  const editingDraft = useChatStore((s) => s.editingDraft);
  const messageActionId = useChatStore((s) => s.messageActionId);
  const pendingUserMessageContent = useChatStore((s) => s.pendingUserMessageContent);
  const chatNotice = useChatStore((s) => s.chatNotice);
  const setDraft = useChatStore((s) => s.setDraft);
  const setEditingDraft = useChatStore((s) => s.setEditingDraft);
  const setSelectedTraceId = useChatStore((s) => s.setSelectedTraceId);

  // --- Navigation store subscriptions ---
  const mode = useNavigationStore((s) => s.mode);
  const setMode = useNavigationStore((s) => s.setMode);
  const theme = useNavigationStore((s) => s.theme);
  const setTheme = useNavigationStore((s) => s.setTheme);
  const isLoading = useNavigationStore((s) => s.isLoading);
  const setIsLoading = useNavigationStore((s) => s.setIsLoading);
  const loadError = useNavigationStore((s) => s.loadError);
  const setLoadError = useNavigationStore((s) => s.setLoadError);
  const sidebarCollapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useNavigationStore((s) => s.setSidebarCollapsed);
  const isProviderModalOpen = useNavigationStore((s) => s.isProviderModalOpen);
  const setIsProviderModalOpen = useNavigationStore((s) => s.setIsProviderModalOpen);
  const isPromptManagerOpen = useNavigationStore((s) => s.isPromptManagerOpen);
  const setIsPromptManagerOpen = useNavigationStore((s) => s.setIsPromptManagerOpen);
  const isPersonaModalOpen = useNavigationStore((s) => s.isPersonaModalOpen);
  const setIsPersonaModalOpen = useNavigationStore((s) => s.setIsPersonaModalOpen);
  const connection = useNavigationStore((s) => s.connection);
  const setConnection = useNavigationStore((s) => s.setConnection);
  const patchConnection = useNavigationStore((s) => s.patchConnection);

  // --- Character store subscriptions ---
  const buildTab = useCharacterStore((s) => s.buildTab);
  const setBuildTab = useCharacterStore((s) => s.setBuildTab);
  const isImportDragActive = useCharacterStore((s) => s.isImportDragActive);
  const setIsImportDragActive = useCharacterStore((s) => s.setIsImportDragActive);
  const importNotice = useCharacterStore((s) => s.importNotice);
  const setImportNotice = useCharacterStore((s) => s.setImportNotice);
  const isFirstRun = useCharacterStore((s) => s.isFirstRun);
  const setIsFirstRun = useCharacterStore((s) => s.setIsFirstRun);
  const confirmDestroy = useCharacterStore((s) => s.confirmDestroy);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);
  const renamingChatId = useCharacterStore((s) => s.renamingChatId);
  const setRenamingChatId = useCharacterStore((s) => s.setRenamingChatId);
  const renameDraft = useCharacterStore((s) => s.renameDraft);
  const setRenameDraft = useCharacterStore((s) => s.setRenameDraft);
  const isSavingCharacter = useCharacterStore((s) => s.isSavingCharacter);
  const setIsSavingCharacter = useCharacterStore((s) => s.setIsSavingCharacter);
  const characterSaveNotice = useCharacterStore((s) => s.characterSaveNotice);
  const setCharacterSaveNotice = useCharacterStore((s) => s.setCharacterSaveNotice);
  const personas = useCharacterStore((s) => s.personas);
  const setPersonas = useCharacterStore((s) => s.setPersonas);
  const promptPresets = useCharacterStore((s) => s.promptPresets);
  const activePromptPresetId = useCharacterStore((s) => s.activePromptPresetId);

  // --- Local state (no store equivalent) ---
  const [isCreateCharacterModalOpen, setCreateCharacterModalOpen] = useState(false);
  const [isContextMemoryOpen, setContextMemoryOpen] = useState(false);
  const [tweaksSettings, setTweaksSettings] = useState<TweaksSettings>(() => readSavedTweaks());
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [allCharacters, setAllCharacters] = useState<Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>>([]);

  // --- Display helpers (extracted) ---
  const display = useDisplayHelpers(allCharacters);
  const { importFile, isImporting } = useCharacterImport();

  // --- Provider hook ---
  const provider = useProviderProfiles({
    connection,
    patchConnection,
    setConnection: (action: SetStateAction<ConnectionState>) => {
      if (typeof action === "function") {
        const next = action(useNavigationStore.getState().connection);
        useNavigationStore.getState().setConnection(next);
      } else {
        useNavigationStore.getState().setConnection(action);
      }
    },
    setChatNotice: useChatStore.getState().setChatNotice,
  });

  // --- Preset controller (extracted) ---
  const preset = usePresetController();

  // --- Sync allCharacters from snapshot ---
  useEffect(() => {
    if (snapshot?.allCharacters) {
      setAllCharacters(snapshot.allCharacters);
    }
  }, [snapshot?.allCharacters]);

  // --- Bootstrap: load persisted theme and connection into stores ---
  useEffect(() => {
    useNavigationStore.getState().setTheme(readSavedTheme());
    useNavigationStore.getState().setConnection(createInitialConnectionState());
  }, []);

  // --- Effects ---

  useEffect(() => {
    persistConnectionState(connection);
  }, [connection]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--mfs', `${tweaksSettings.fontSize}px`);
    root.style.setProperty('--ui-fs', `${tweaksSettings.uiFontSize}px`);
    root.style.setProperty('--mw', MESSAGE_WIDTH_MAP[tweaksSettings.messageWidth]);
    persistTweaks(tweaksSettings);
  }, [tweaksSettings]);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    persistTheme(theme);
  }, [theme]);

  useEffect(() => {
    void loadBootstrap();
  }, []);

  useEffect(() => {
    setSelectedTraceId(
      snapshot?.promptTrace?.id ?? snapshot?.promptTraceHistory[0]?.id ?? null,
    );
  }, [snapshot?.promptTrace?.id, snapshot?.promptTraceHistory]);

  useEffect(() => {
    if (!editingMessageId || !snapshot) {
      return;
    }
    const stillExists = snapshot.messages.some((message) => message.id === editingMessageId);
    if (!stillExists) {
      useChatStore.getState().setEditingMessageId(null);
      setEditingDraft("");
    }
  }, [editingMessageId, snapshot]);

  useEffect(() => {
    setCharacterSaveNotice("");
  }, [snapshot?.character.id]);

  useEffect(() => {
    useChatStore.getState().setChatNotice("");
  }, [activeChatId]);

  useEffect(() => {
    void loadPersonas();
  }, []);

  useEffect(() => {
    if (snapshot?.activeChat.promptPresetId) {
      useCharacterStore.getState().setActivePromptPresetId(snapshot.activeChat.promptPresetId);
    }
  }, [snapshot?.activeChat.promptPresetId]);

  // --- Controllers ---

  const canSendViaActiveProfileRef = useRef(provider.canSendViaActiveProfile);
  canSendViaActiveProfileRef.current = provider.canSendViaActiveProfile;

  const streamResponseRef = useRef(provider.activeProviderProfile?.streamResponse ?? connection.streamResponse);
  streamResponseRef.current = provider.activeProviderProfile?.streamResponse ?? connection.streamResponse;

  function snapshotRefresh(chatId: ChatId, next: AppSnapshot): void {
    useChatStore.getState().setSnapshotForChat(chatId, next);
  }

  const chat = useChatController({
    getActiveChatId: () => useChatStore.getState().activeChatId,
    getSnapshot: () => useChatStore.getState().snapshot,
    getDraft: () => useChatStore.getState().draft,
    getIsSending: () => useChatStore.getState().isSending,
    getCanSendViaActiveProfile: () => canSendViaActiveProfileRef.current,
    getEditingDraft: () => useChatStore.getState().editingDraft,
    getEditingMessageId: () => useChatStore.getState().editingMessageId,
    setSnapshot: (chatId, next) => useChatStore.getState().setSnapshotForChat(chatId, next),
    setDraft: useChatStore.getState().setDraft,
    setIsSending: useChatStore.getState().setIsSending,
    setChatNotice: useChatStore.getState().setChatNotice,
    setPendingUserMessageContent: useChatStore.getState().setPendingUserMessageContent,
    setMessageActionId: useChatStore.getState().setMessageActionId,
    setEditingMessageId: useChatStore.getState().setEditingMessageId,
    setEditingDraft: useChatStore.getState().setEditingDraft,
    setSelectedTraceId: useChatStore.getState().setSelectedTraceId,
    getGenerationStatus: () => useChatStore.getState().generationStatus,
    getStreamResponse: () => streamResponseRef.current,
    setGenerationStatus: useChatStore.getState().setGenerationStatus,
  });

  const character = useCharacterController({
    getActiveChatId: () => useChatStore.getState().activeChatId,
    getSnapshot: () => useChatStore.getState().snapshot,
    setSnapshot: snapshotRefresh,
    patchSnapshot: (updater) => {
      const current = useChatStore.getState().snapshot;
      if (current) useChatStore.getState().setSnapshot(updater(current));
    },
    setChatNotice: useChatStore.getState().setChatNotice,
    setIsFirstRun,
    setMode,
    setIsImportDragActive,
    setImportNotice,
    setIsSavingCharacter,
    setCharacterSaveNotice,
    setPersonas: (updater) => useCharacterStore.getState().setPersonas(updater(useCharacterStore.getState().personas)),
    loadBootstrap,
    loadPersonas,
    importFile,
  });

  // --- Internal functions ---

  async function loadPersonas(): Promise<void> {
    try {
      setPersonas(await listPersonas());
    } catch {
      // ignore
    }
  }

  async function loadBootstrap(): Promise<void> {
    setIsLoading(true);
    setLoadError("");

    try {
      const boot = await bootstrapApp();
      useChatStore.getState().setActiveChatId(boot.initialChatId);
      useChatStore.getState().setSnapshot(boot.snapshot);
      setAllCharacters(boot.allCharacters);
      setIsFirstRun(boot.isFirstRun || import.meta.env.VITE_FORCE_FIRST_RUN === 'true');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load application state.");
    } finally {
      setIsLoading(false);
    }
  }

  // --- Modal toggles ---

  function openConnectionPanel(): void { setIsProviderModalOpen(true); }
  function closeConnectionPanel(): void { setIsProviderModalOpen(false); }
  function openPromptManager(): void { setIsPromptManagerOpen(true); void preset.loadPromptPresets(); }
  function closePromptManager(): void { setIsPromptManagerOpen(false); }
  function openPersonaModal(): void { setIsPersonaModalOpen(true); }
  function closePersonaModal(): void { setIsPersonaModalOpen(false); }
  function openContextMemory(): void { setContextMemoryOpen(true); }
  function closeContextMemory(): void { setContextMemoryOpen(false); }
  function openCreateCharacterModal(): void { setCreateCharacterModalOpen(true); }
  function closeCreateCharacterModal(): void { setCreateCharacterModalOpen(false); }

  // --- Chat summary handlers ---

  async function handleSummarizeChat(input: { providerProfileId: string; maxMessages: number }): Promise<string> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId) throw new Error("No active chat.");
    const result = await summarizeChat(chatId, input);
    snapshotRefresh(chatId, result.snapshot);
    return result.summary;
  }

  async function handleSaveChatSummary(summary: string): Promise<string> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId) throw new Error("No active chat.");
    const result = await saveChatSummary(chatId, summary);
    snapshotRefresh(chatId, result.snapshot);
    return result.summary;
  }

  // --- Tweak helpers ---

  function updateTweak<K extends keyof TweaksSettings>(key: K, value: TweaksSettings[K]): void {
    setTweaksSettings(prev => ({ ...prev, [key]: value }));
  }

  // --- Render helpers ---

  function renderConnectionStatus(): string {
    if (connection.status === "connecting") {
      return "connecting...";
    }
    if (connection.status === "connected") {
      return connection.model ? `connected - ${connection.model}` : "connected";
    }
    if (connection.status === "error") {
      return "error";
    }
    return "not connected";
  }

  function renderSendLabel(): string {
    if (isSending) {
      return "Sending...";
    }
    if (display.canUseLiveApi && draft.trim()) {
      return "Send message";
    }
    if (!display.canUseLiveApi) {
      return "Model unavailable";
    }
    return "Type a message";
  }

  function renderConnectionHint(): string {
    if (connection.error) {
      return connection.error;
    }
    if (display.canUseLiveApi) {
      return "Model selected. The chat is using a saved local provider profile.";
    }
    return "Save or select a provider profile, connect it, then choose a model.";
  }

  return {
    activeChatId,
    selectedCharacterId,
    setSelectedCharacterId: useChatStore.getState().setSelectedCharacterId,
    snapshot,
    draft,
    setDraft,
    mode,
    setMode,
    theme,
    setTheme,
    buildTab,
    setBuildTab,
    isSending,
    isLoading,
    loadError,
    loadBootstrap,
    sidebarCollapsed,
    setSidebarCollapsed,
    selectedTraceId,
    setSelectedTraceId,
    activePromptTrace: display.activePromptTrace,
    promptPayloadText: display.promptPayloadText,
    isProviderModalOpen,
    openConnectionPanel,
    closeConnectionPanel,
    isPromptManagerOpen,
    openPromptManager,
    closePromptManager,
    isPersonaModalOpen,
    openPersonaModal,
    closePersonaModal,
    isCreateCharacterModalOpen,
    openCreateCharacterModal,
    closeCreateCharacterModal,
    isContextMemoryOpen,
    openContextMemory,
    closeContextMemory,
    handleSummarizeChat,
    handleSaveChatSummary,
    connection,
    patchConnection,
    isImportDragActive,
    importNotice,
    providerProfiles: provider.providerProfiles,
    selectedProviderProfileId: provider.selectedProviderProfileId,
    setSelectedProviderProfileId: provider.setSelectedProviderProfileId,
    editingMessageId,
    editingDraft,
    setEditingDraft,
    messageActionId,
    pendingUserMessageContent,
    displayPendingUserMessageContent: display.displayPendingUserMessageContent,
    displayMessages: display.displayMessages,
    displayScenario: display.displayScenario,
    chatNotice,
    isSavingCharacter,
    characterSaveNotice,
    isImporting,
    characterTabs: display.characterTabs,
    canConnect: provider.canConnect,
    canRefreshModels: provider.canRefreshModels,
    canUseLiveApi: display.canUseLiveApi,
    canSendViaActiveProfile: provider.canSendViaActiveProfile,
    activeProviderProfile: provider.activeProviderProfile,
    handleActivateProviderProfile: provider.handleActivateProviderProfile,
    handleCreateProviderProfile: provider.handleCreateProviderProfile,
    handleDuplicateProviderProfile: provider.handleDuplicateProviderProfile,
    handleTestDraftConnection: provider.handleTestDraftConnection,
    handleTestProfileConnection: provider.handleTestProfileConnection,
    handleTestChat: provider.handleTestChat,
    handleFetchModelsForProfile: provider.handleFetchModelsForProfile,
    handleFetchModelsByEndpoint: provider.handleFetchModelsByEndpoint,
    handleRefreshProfiles: provider.handleRefreshProfiles,
    handleSaveProviderProfileFromForm: provider.handleSaveProviderProfileFromForm,
    personas,
    renderSendLabel,
    handleSend: chat.handleSend,
    handleResend: chat.handleResend,
    handleCancelGeneration: chat.handleCancelGeneration,
    handleConnect: provider.handleConnect,
    handleLoadProviderProfile: provider.handleLoadProviderProfile,
    handleSaveProviderProfile: provider.handleSaveProviderProfile,
    handleDeleteProviderProfile: provider.handleDeleteProviderProfile,
    handleConnectSavedProfile: provider.handleConnectSavedProfile,
    handleRefreshProviderModels: provider.handleRefreshProviderModels,
    handleSwitchChat: chat.handleSwitchChat,
    handleSaveCharacter: character.handleSaveCharacter,
    handleAvatarUpload: character.handleAvatarUpload,
    handleSavePersona: character.handleSavePersona,
    handleSetChatPersona: character.handleSetChatPersona,
    handleCreatePersona: character.handleCreatePersona,
    handleDeletePersona: character.handleDeletePersona,
    handleSetPersonalLorebook: character.handleSetPersonalLorebook,
    promptPresets,
    activePromptPresetId,
    setActivePromptPresetId: preset.handleSetActivePromptPresetId,
    handleCreatePromptPreset: preset.handleCreatePromptPreset,
    handleUpdatePromptPreset: preset.handleUpdatePromptPreset,
    handleDeletePromptPreset: preset.handleDeletePromptPreset,
    handleFork: chat.handleFork,
    handleActivateBranch: chat.handleActivateBranch,
    handleDeleteActiveBranch: chat.handleDeleteActiveBranch,
    handleStartEdit: chat.handleStartEdit,
    handleCancelEdit: chat.handleCancelEdit,
    handleSaveMessageEdit: chat.handleSaveMessageEdit,
    handleDeleteMessage: chat.handleDeleteMessage,
    handleRegenerateMessage: chat.handleRegenerateMessage,
    handleSelectMessageVariant: chat.handleSelectMessageVariant,
    handleImportDragOver: character.handleImportDragOver,
    handleImportDragLeave: character.handleImportDragLeave,
    handleImportDrop: character.handleImportDrop,
    handleImportInputChange: character.handleImportInputChange,
    handleImportFiles: character.handleImportFiles,
    confirmDestroy,
    setConfirmDestroy,
    renamingChatId,
    renameDraft,
    setRenamingChatId,
    setRenameDraft,
    handleArchiveCharacter: character.handleArchiveCharacter,
    handleUnarchiveCharacter: character.handleUnarchiveCharacter,
    handleDeleteCharacter: character.handleDeleteCharacter,
    handleDeleteChat: character.handleDeleteChat,
    handleRenameChat: character.handleRenameChat,
    isFirstRun,
    handleCreateCharacter: character.handleCreateCharacter,
    handleFreeChat: character.handleFreeChat,
    onCreateChat: character.handleCreateChat,
    onCloneChat: character.handleCloneChat,
    onExportCharacter: character.handleExportCharacter,
    onExportChatJsonl: character.handleExportChatJsonl,
    allCharacters,
    tweaksSettings,
    updateTweak,
    tweaksOpen,
    setTweaksOpen,
    avatarOpen,
    setAvatarOpen,
  };
}
