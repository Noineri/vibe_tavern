import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ChatId, PromptPresetDto } from "@rp-platform/domain";
import { PROVIDER_TYPE } from "@rp-platform/domain";
import {
  bootstrapApp,
  listPersonas,
  listPromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
  setChatPromptPreset,
  type AppSnapshot,
  type PersonaRecord,
} from "../app-client.js";
import type {
  AppMode,
  CharacterTab,
  ConnectionState,
  SavedConnectionState,
  ThemeMode,
} from "../components/app-shell-types.js";
import type { BuildTab } from "../components/BuildMode.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { useCharacterImport } from "./use-character-import.js";
import { useProviderProfiles } from "./use-provider-profiles.js";
import { useChatController } from "./use-chat-controller.js";
import { useCharacterController } from "./use-character-controller.js";

function replaceUiMacros(
  text: string,
  context: { characterName: string; personaName?: string | null; personaDescription?: string | null },
): string {
  if (!text) return text;
  const userName = context.personaName?.trim() || "User";
  return text
    .replace(/\{\{\s*char\s*\}\}/gi, context.characterName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*persona\s*\}\}/gi, context.personaDescription ?? "")
    .replace(/<USER>/gi, userName)
    .replace(/<BOT>/gi, context.characterName)
    .replace(/<CHAR>/gi, context.characterName);
}

const STORAGE_KEY = "rp-platform.connection-settings";
const THEME_STORAGE_KEY = "rp-platform.theme";

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
  const [activeChatId, setActiveChatId] = useState<ChatId | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<AppMode>("play");
  const [theme, setTheme] = useState<ThemeMode>(() => readSavedTheme());
  const [buildTab, setBuildTab] = useState<BuildTab>("character");
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [isProviderModalOpen, setIsProviderModalOpen] = useState(false);
  const [isPromptManagerOpen, setPromptManagerOpen] = useState(false);
  const [isPersonaModalOpen, setPersonaModalOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>(() => createInitialConnectionState());
  const [isImportDragActive, setIsImportDragActive] = useState(false);
  const [importNotice, setImportNotice] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [messageActionId, setMessageActionId] = useState<string | null>(null);
  const [pendingUserMessageContent, setPendingUserMessageContent] = useState<string | null>(null);
  const [chatNotice, setChatNotice] = useState("");
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState<{
    title: string;
    body: ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [isSavingCharacter, setIsSavingCharacter] = useState(false);
  const [characterSaveNotice, setCharacterSaveNotice] = useState("");
  const { importFile, isImporting } = useCharacterImport();

  const [personas, setPersonas] = useState<PersonaRecord[]>([]);
  const [promptPresets, setPromptPresets] = useState<PromptPresetDto[]>([]);
  const [activePromptPresetId, setActivePromptPresetId] = useState<string | null>(null);

  // --- Derived state ---

  const activePromptTrace = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    return (
      snapshot.promptTraceHistory.find((trace) => trace.id === selectedTraceId) ??
      snapshot.promptTrace ??
      snapshot.promptTraceHistory[0] ??
      null
    );
  }, [selectedTraceId, snapshot]);

  const promptPayloadText = useMemo(
    () => JSON.stringify(activePromptTrace?.finalPayload ?? {}, null, 2),
    [activePromptTrace],
  );
  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);

  // --- Provider hook ---

  const provider = useProviderProfiles({
    connection,
    patchConnection,
    setConnection,
    setChatNotice,
  });

  // --- Character/chat tabs ---

  const characterTabs = useMemo(() => (snapshot ? buildCharacterTabs(snapshot) : []), [snapshot]);
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
      ? snapshot.messages.map((message) => ({
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

  // --- Effects ---

  useEffect(() => {
    persistConnectionState(connection);
  }, [connection]);

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
      setEditingMessageId(null);
      setEditingDraft("");
    }
  }, [editingMessageId, snapshot]);

  useEffect(() => {
    setCharacterSaveNotice("");
  }, [snapshot?.character.id]);

  useEffect(() => {
    setChatNotice("");
  }, [activeChatId]);

  useEffect(() => {
    void loadPersonas();
  }, []);

  useEffect(() => {
    if (snapshot?.activeChat.promptPresetId) {
      setActivePromptPresetId(snapshot.activeChat.promptPresetId);
    }
  }, [snapshot?.activeChat.promptPresetId]);

  // --- Controllers ---

  function snapshotRefresh(chatId: ChatId, next: AppSnapshot): void {
    setActiveChatId(chatId);
    setSnapshot(next);
  }

  const chat = useChatController({
    getActiveChatId: () => activeChatId,
    getSnapshot: () => snapshot,
    getDraft: () => draft,
    getIsSending: () => isSending,
    getCanSendViaActiveProfile: () => provider.canSendViaActiveProfile,
    getEditingDraft: () => editingDraft,
    getEditingMessageId: () => editingMessageId,
    setSnapshot: snapshotRefresh,
    setDraft,
    setIsSending,
    setChatNotice,
    setPendingUserMessageContent,
    setMessageActionId,
    setEditingMessageId,
    setEditingDraft,
    setSelectedTraceId,
  });

  const character = useCharacterController({
    getActiveChatId: () => activeChatId,
    getSnapshot: () => snapshot,
    setSnapshot: snapshotRefresh,
    setChatNotice,
    setIsFirstRun,
    setMode,
    setIsImportDragActive,
    setImportNotice,
    setIsSavingCharacter,
    setCharacterSaveNotice,
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

  async function loadPromptPresets(): Promise<void> {
    try {
      const list = await listPromptPresets();
      setPromptPresets(list);
      if (list.length > 0 && !list.find((p) => p.id === activePromptPresetId)) {
        setActivePromptPresetId(list[0].id);
      } else if (list.length === 0) {
        setActivePromptPresetId(null);
      }
    } catch {
      // ignore
    }
  }

  async function handleSetActivePromptPresetId(presetId: string | null): Promise<void> {
    setActivePromptPresetId(presetId);
    if (!activeChatId || !presetId) return;
    try {
      const nextSnapshot = await setChatPromptPreset(activeChatId, presetId);
      snapshotRefresh(activeChatId, nextSnapshot);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to set prompt preset.");
    }
  }

  async function handleCreatePromptPreset(input: { name: string; bindModel?: string; system?: string; jailbreak?: string; summary?: string; tools?: string }): Promise<{ id: string } | null> {
    try {
      const created = await createPromptPreset(input);
      await loadPromptPresets();
      await handleSetActivePromptPresetId(created.id);
      return { id: created.id };
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create preset.");
      return null;
    }
  }

  async function handleUpdatePromptPreset(presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>): Promise<boolean> {
    try {
      const updated = await updatePromptPreset(presetId, patch);
      setPromptPresets((current) => current.map((p) => p.id === presetId ? updated : p));
      return true;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to save preset.");
      return false;
    }
  }

  async function handleDeletePromptPreset(presetId: string): Promise<boolean> {
    try {
      await deletePromptPreset(presetId);
      await loadPromptPresets();
      return true;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to delete preset.");
      return false;
    }
  }

  async function loadBootstrap(): Promise<void> {
    setIsLoading(true);
    setLoadError("");

    try {
      const boot = await bootstrapApp();
      setActiveChatId(boot.initialChatId);
      setSnapshot(boot.snapshot);
      setIsFirstRun(boot.isFirstRun || import.meta.env.VITE_FORCE_FIRST_RUN === 'true');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load application state.");
    } finally {
      setIsLoading(false);
    }
  }

  function patchConnection(patch: Partial<ConnectionState>): void {
    setConnection((current) => ({
      ...current,
      ...patch,
      status: patch.status ?? current.status,
    }));
  }

  function openConnectionPanel(): void {
    setIsProviderModalOpen(true);
  }

  function closeConnectionPanel(): void {
    setIsProviderModalOpen(false);
  }

  function openPromptManager(): void {
    setPromptManagerOpen(true);
    void loadPromptPresets();
  }

  function closePromptManager(): void {
    setPromptManagerOpen(false);
  }

  function openPersonaModal(): void {
    setPersonaModalOpen(true);
  }

  function closePersonaModal(): void {
    setPersonaModalOpen(false);
  }

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
    if (canUseLiveApi && draft.trim()) {
      return "Send message";
    }
    if (!canUseLiveApi) {
      return "Model unavailable";
    }
    return "Type a message";
  }

  function renderConnectionHint(): string {
    if (connection.error) {
      return connection.error;
    }
    if (canUseLiveApi) {
      return "Model selected. The chat is using a saved local provider profile.";
    }
    return "Save or select a provider profile, connect it, then choose a model.";
  }

  return {
    activeChatId,
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
    activePromptTrace,
    promptPayloadText,
    isProviderModalOpen,
    openConnectionPanel,
    closeConnectionPanel,
    isPromptManagerOpen,
    openPromptManager,
    closePromptManager,
    isPersonaModalOpen,
    openPersonaModal,
    closePersonaModal,
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
    displayPendingUserMessageContent,
    displayMessages,
    displayScenario,
    chatNotice,
    isSavingCharacter,
    characterSaveNotice,
    isImporting,
    characterTabs,
    canConnect: provider.canConnect,
    canRefreshModels: provider.canRefreshModels,
    canUseLiveApi,
    canSendViaActiveProfile: provider.canSendViaActiveProfile,
    activeProviderProfile: provider.activeProviderProfile,
    handleActivateProviderProfile: provider.handleActivateProviderProfile,
    handleCreateProviderProfile: provider.handleCreateProviderProfile,
    handleDuplicateProviderProfile: provider.handleDuplicateProviderProfile,
    handleTestDraftConnection: provider.handleTestDraftConnection,
    handleTestChat: provider.handleTestChat,
    handleFetchModelsForProfile: provider.handleFetchModelsForProfile,
    handleFetchModelsByEndpoint: provider.handleFetchModelsByEndpoint,
    handleRefreshProfiles: provider.handleRefreshProfiles,
    handleSaveProviderProfileFromForm: provider.handleSaveProviderProfileFromForm,
    personas,
    renderSendLabel,
    handleSend: chat.handleSend,
    handleCancelGeneration: chat.handleCancelGeneration,
    handleConnect: provider.handleConnect,
    handleLoadProviderProfile: provider.handleLoadProviderProfile,
    handleSaveProviderProfile: provider.handleSaveProviderProfile,
    handleDeleteProviderProfile: provider.handleDeleteProviderProfile,
    handleConnectSavedProfile: provider.handleConnectSavedProfile,
    handleRefreshProviderModels: provider.handleRefreshProviderModels,
    handleSwitchChat: chat.handleSwitchChat,
    handleSaveCharacter: character.handleSaveCharacter,
    handleSavePersona: character.handleSavePersona,
    handleSetChatPersona: character.handleSetChatPersona,
    handleCreatePersona: character.handleCreatePersona,
    handleDeletePersona: character.handleDeletePersona,
    handleSetPersonalLorebook: character.handleSetPersonalLorebook,
    promptPresets,
    activePromptPresetId,
    setActivePromptPresetId: handleSetActivePromptPresetId,
    handleCreatePromptPreset,
    handleUpdatePromptPreset,
    handleDeletePromptPreset,
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
    activePromptTraceId: activePromptTrace?.id ?? null,
    isFirstRun,
    handleCreateCharacter: character.handleCreateCharacter,
    handleFreeChat: character.handleFreeChat,
    onCreateChat: character.handleCreateChat,
    onCloneChat: character.handleCloneChat,
    onExportCharacter: character.handleExportCharacter,
    onExportChatJsonl: character.handleExportChatJsonl,
    onExportPromptTrace: character.handleExportPromptTrace,
  };
}

function buildCharacterTabs(snapshot: AppSnapshot): CharacterTab[] {
  const seen = new Set<string>();
  const result: CharacterTab[] = [];

  for (const chat of snapshot.chats) {
    if (seen.has(chat.characterId)) {
      continue;
    }

    seen.add(chat.characterId);
    result.push({
      id: chat.characterId,
      name: chat.characterName,
      subtitle: chat.subtitle,
      chatId: chat.id,
    });
  }

  return result;
}

function readSavedConnectionState(): SavedConnectionState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as SavedConnectionState;
  } catch {
    return null;
  }
}

function persistConnectionState(state: ConnectionState): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        providerLabel: state.providerLabel,
        baseUrl: state.baseUrl,
        model: state.model,
      }),
    );
  } catch {
    // Ignore local persistence failures in the UI shell.
  }
}

function readSavedTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function persistTheme(theme: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore theme persistence failures in the UI shell.
  }
}
