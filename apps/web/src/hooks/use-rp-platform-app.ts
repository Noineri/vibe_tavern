import type { ChangeEvent, DragEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ChatBranchId, ChatId } from "@rp-platform/domain";
import {
  activateBranch,
  activateProviderProfile,
  bootstrapApp,
  connectProviderProfile,
  deleteChatMessage,
  deleteProviderProfile,
  editChatMessage,
  fetchChat,
  fetchProviderProfile,
  fetchProviderProfileModels,
  forkBranch,
  listProviderProfiles,
  regenerateChatMessage,
  saveProviderProfile,
  selectMessageVariant,
  sendChatMessage,
  updateCharacter,
  updatePersona,
  updateProviderProfile,
  type AppMessage,
  type AppSnapshot,
  type ProviderProfileRecord,
} from "../app-client.js";
import type {
  AppMode,
  CharacterTab,
  ConnectionState,
  SavedConnectionState,
  ThemeMode,
} from "../components/app-shell-types.js";
import type { BuildCharacterDraft, BuildPersonaDraft, BuildTab } from "../components/BuildMode.js";
import { normalizeOpenAiCompatibleBaseUrl, type OpenAiModelOption } from "../openai-compatible.js";
import { useCharacterImport } from "./use-character-import.js";

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
  const [connection, setConnection] = useState<ConnectionState>(() => createInitialConnectionState());
  const [isImportDragActive, setIsImportDragActive] = useState(false);
  const [importNotice, setImportNotice] = useState("");
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfileRecord[]>([]);
  const [selectedProviderProfileId, setSelectedProviderProfileId] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [messageActionId, setMessageActionId] = useState<string | null>(null);
  const [pendingUserMessageContent, setPendingUserMessageContent] = useState<string | null>(null);
  const [chatNotice, setChatNotice] = useState("");
  const [isSavingCharacter, setIsSavingCharacter] = useState(false);
  const [characterSaveNotice, setCharacterSaveNotice] = useState("");
  const { importFile, isImporting } = useCharacterImport();

  const [personas, setPersonas] = useState<import("../app-client.js").PersonaRecord[]>([]);

  async function loadPersonas(): Promise<void> {
    try {
      setPersonas(await (await import("../app-client.js")).listPersonas());
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void loadPersonas();
  }, []);

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
  const canConnect = Boolean(connection.providerLabel.trim() && connection.baseUrl.trim());
  const canRefreshModels = Boolean(connection.activeProviderProfileId || selectedProviderProfileId);
  const canUseLiveApi = connection.status === "connected" && Boolean(connection.model);
  const activeProviderProfile = useMemo(
    () => providerProfiles.find((profile) => profile.isActive) ?? null,
    [providerProfiles],
  );
  const canSendViaActiveProfile = activeProviderProfile !== null && Boolean(activeProviderProfile.defaultModel);
  const characterTabs = useMemo(() => (snapshot ? buildCharacterTabs(snapshot) : []), [snapshot]);

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
    void loadProviderProfiles();
  }, []);

  useEffect(() => {
    setSelectedTraceId((current) => {
      if (current && snapshot?.promptTraceHistory.some((trace) => trace.id === current)) {
        return current;
      }

      return snapshot?.promptTrace?.id ?? snapshot?.promptTraceHistory[0]?.id ?? null;
    });
  }, [snapshot]);

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
    setSelectedProviderProfileId((current) => {
      if (current && providerProfiles.some((profile) => profile.id === current)) {
        return current;
      }
      return providerProfiles[0]?.id ?? "";
    });
  }, [providerProfiles]);

  useEffect(() => {
    setCharacterSaveNotice("");
  }, [snapshot?.character.id]);

  useEffect(() => {
    setChatNotice("");
  }, [activeChatId]);

  async function loadBootstrap(): Promise<void> {
    setIsLoading(true);
    setLoadError("");

    try {
      const boot = await bootstrapApp();
      setActiveChatId(boot.initialChatId);
      setSnapshot(boot.snapshot);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load application state.");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadProviderProfiles(): Promise<void> {
    try {
      setProviderProfiles(await listProviderProfiles());
    } catch (error) {
      setConnection((current) => ({
        ...current,
        error:
          error instanceof Error ? error.message : "Could not load saved provider profiles.",
      }));
    }
  }

  function refresh(nextChatId: ChatId, nextSnapshot: AppSnapshot): void {
    setActiveChatId(nextChatId);
    setSnapshot(nextSnapshot);
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

  async function handleSend(): Promise<void> {
    const trimmed = draft.trim();
    if (!trimmed || isSending || !activeChatId) {
      return;
    }

    if (!canSendViaActiveProfile) {
      setChatNotice(
        "Message sending is unavailable until a provider profile is activated and its default model is set. Open Provider settings, pick a model, press Save profile, then Set as active.",
      );
      return;
    }

    setDraft("");
    setPendingUserMessageContent(trimmed);
    setChatNotice("");
    setIsSending(true);

    try {
      refresh(activeChatId, await sendChatMessage(activeChatId, {
        content: trimmed,
      }));
    } catch (error) {
      refresh(activeChatId, await fetchChat(activeChatId));
      setChatNotice(error instanceof Error && error.message ? error.message : "Message sending failed.");
    } finally {
      setPendingUserMessageContent(null);
      setIsSending(false);
    }
  }

  async function handleConnect(): Promise<void> {
    if (!canConnect) {
      return;
    }

    const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(connection.baseUrl);
    setConnection((current) => ({
      ...current,
      baseUrl: normalizedBaseUrl,
      status: "connecting",
      error: "",
    }));

    try {
      const saved = await saveProviderProfile({
        id: selectedProviderProfileId || connection.activeProviderProfileId || undefined,
        name: connection.providerLabel.trim(),
        type: "openai_compat",
        endpoint: normalizedBaseUrl,
        apiKey: connection.apiKey.trim() || undefined,
        defaultModel: connection.model.trim() || null,
        contextBudget: 8192,
      });

      await loadProviderProfiles();
      setSelectedProviderProfileId(saved.id);
      patchConnection({
        providerLabel: saved.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(saved.endpoint),
        apiKey: "",
        model: saved.defaultModel ?? connection.model,
        activeProviderProfileId: saved.id,
        hasStoredApiKey: saved.hasStoredApiKey,
        error: "",
      });

      await handleConnectSavedProfileById(saved.id);
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not save and connect provider profile.",
      });
    }
  }

  async function handleLoadProviderProfile(): Promise<void> {
    if (!selectedProviderProfileId) {
      return;
    }

    try {
      const profile = await fetchProviderProfile(selectedProviderProfileId);
      patchConnection({
        providerLabel: profile.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(profile.endpoint),
        apiKey: "",
        model: profile.defaultModel ?? "",
        activeProviderProfileId: profile.id,
        hasStoredApiKey: profile.hasStoredApiKey,
        models: [],
        status: "idle",
        error: "",
      });
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not load saved profile.",
      });
    }
  }

  async function handleSaveProviderProfile(): Promise<void> {
    const name = connection.providerLabel.trim();
    const endpoint = normalizeOpenAiCompatibleBaseUrl(connection.baseUrl);

    if (!name || !endpoint) {
      patchConnection({
        status: "error",
        error: "Provider name and base URL are required to save a profile.",
      });
      return;
    }

    const existingId = selectedProviderProfileId && providerProfiles.some((profile) => profile.id === selectedProviderProfileId)
      ? selectedProviderProfileId
      : "";

    try {
      const apiKeyInput = connection.apiKey.trim();
      const saved = existingId
        ? await updateProviderProfile(existingId, {
            name,
            type: "openai_compat",
            endpoint,
            apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
            defaultModel: connection.model.trim() || null,
            contextBudget: 8192,
          })
        : await saveProviderProfile({
            name,
            type: "openai_compat",
            endpoint,
            apiKey: apiKeyInput || undefined,
            defaultModel: connection.model.trim() || null,
            contextBudget: 8192,
          });

      await loadProviderProfiles();
      setSelectedProviderProfileId(saved.id);
      patchConnection({
        providerLabel: saved.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(saved.endpoint),
        apiKey: "",
        model: saved.defaultModel ?? connection.model,
        activeProviderProfileId: saved.id,
        hasStoredApiKey: saved.hasStoredApiKey,
        error: "",
      });
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not save provider profile.",
      });
    }
  }

  async function handleActivateProviderProfile(providerProfileId: string): Promise<void> {
    if (!providerProfileId) {
      return;
    }
    try {
      await activateProviderProfile(providerProfileId);
      await loadProviderProfiles();
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not activate provider profile.",
      });
    }
  }

  async function handleDeleteProviderProfile(): Promise<void> {
    if (!selectedProviderProfileId) {
      return;
    }

    try {
      await deleteProviderProfile(selectedProviderProfileId);
      await loadProviderProfiles();
      if (connection.activeProviderProfileId === selectedProviderProfileId) {
        patchConnection({
          activeProviderProfileId: null,
          hasStoredApiKey: false,
          status: "idle",
          models: [],
        });
      }
      setSelectedProviderProfileId("");
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not delete provider profile.",
      });
    }
  }

  async function handleConnectSavedProfile(): Promise<void> {
    if (!selectedProviderProfileId) {
      return;
    }

    await handleConnectSavedProfileById(selectedProviderProfileId);
  }

  async function handleConnectSavedProfileById(providerProfileId: string): Promise<void> {
    if (!providerProfileId) {
      return;
    }

    setConnection((current) => ({
      ...current,
      status: "connecting",
      error: "",
    }));

    try {
      const [profile, result] = await Promise.all([
        fetchProviderProfile(providerProfileId),
        connectProviderProfile(providerProfileId),
      ]);
      if (!result.success) {
        throw new Error(result.error || "Provider connection failed.");
      }

      const models = normalizeConnectedModels(result.models);
      setConnection((current) => ({
        ...current,
        providerLabel: profile.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(profile.endpoint),
        apiKey: "",
        activeProviderProfileId: profile.id,
        hasStoredApiKey: profile.hasStoredApiKey,
        status: "connected",
        error: "",
        models: models.length > 0 ? models : current.models,
        model:
          current.model && models.some((entry) => entry.id === current.model)
            ? current.model
            : profile.defaultModel && models.some((entry) => entry.id === profile.defaultModel)
            ? profile.defaultModel
            : profile.defaultModel ?? models[0]?.id ?? current.model,
      }));
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not connect saved profile.",
      });
    }
  }

  async function handleRefreshProviderModels(): Promise<void> {
    const providerProfileId = connection.activeProviderProfileId || selectedProviderProfileId;
    if (!providerProfileId) {
      return;
    }

    setConnection((current) => ({
      ...current,
      status: "connecting",
      error: "",
    }));

    try {
      const [profile, result] = await Promise.all([
        fetchProviderProfile(providerProfileId),
        fetchProviderProfileModels(providerProfileId),
      ]);
      const models = result.models;
      setConnection((current) => ({
        ...current,
        providerLabel: profile.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(profile.endpoint),
        apiKey: "",
        activeProviderProfileId: profile.id,
        hasStoredApiKey: profile.hasStoredApiKey,
        status: "connected",
        error: "",
        models,
        model:
          current.model && models.some((entry) => entry.id === current.model)
            ? current.model
            : profile.defaultModel && models.some((entry) => entry.id === profile.defaultModel)
            ? profile.defaultModel
            : models[0]?.id ?? current.model,
      }));
    } catch (error) {
      patchConnection({
        status: connection.activeProviderProfileId ? "connected" : "error",
        error: error instanceof Error ? error.message : "Could not refresh model list.",
      });
    }
  }

  async function handleSwitchChat(chatId: ChatId): Promise<void> {
    refresh(chatId, await fetchChat(chatId));
  }

  async function handleSaveCharacter(draftInput: BuildCharacterDraft): Promise<void> {
    if (!activeChatId || !snapshot) {
      return;
    }

    setIsSavingCharacter(true);
    setCharacterSaveNotice("");

    try {
      const nextSnapshot = await updateCharacter(snapshot.character.id, {
        chatId: activeChatId,
        name: draftInput.name,
        description: draftInput.description,
        scenario: draftInput.scenario,
        systemPrompt: draftInput.systemPrompt,
        mesExample: draftInput.mesExample,
        alternateGreetings: draftInput.alternateGreetings,
        postHistoryInstructions: draftInput.postHistoryInstructions,
        creatorNotes: draftInput.creatorNotes,
      });
      refresh(activeChatId, nextSnapshot);
      setCharacterSaveNotice("Character card saved.");
    } catch (error) {
      setCharacterSaveNotice(error instanceof Error ? error.message : "Could not save character.");
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleSavePersona(draftInput: BuildPersonaDraft): Promise<void> {
    if (!activeChatId || !snapshot?.persona?.id) {
      return;
    }

    setIsSavingCharacter(true);
    setCharacterSaveNotice("");

    try {
      const nextSnapshot = await updatePersona(snapshot.persona.id, {
        chatId: activeChatId,
        name: draftInput.name,
        description: draftInput.description,
      });
      refresh(activeChatId, nextSnapshot);
      await loadPersonas();
      setCharacterSaveNotice("Persona saved.");
    } catch (error) {
      setCharacterSaveNotice(error instanceof Error ? error.message : "Could not save persona.");
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleSetChatPersona(personaId: string): Promise<void> {
    if (!activeChatId) return;
    try {
      refresh(activeChatId, await (await import("../app-client.js")).setChatPersona(activeChatId, personaId));
    } catch (err) {
      setChatNotice(err instanceof Error ? err.message : "Failed to switch persona.");
    }
  }

  async function handleFork(): Promise<void> {
    if (!activeChatId) {
      return;
    }
    refresh(activeChatId, await forkBranch(activeChatId));
  }

  async function handleActivateBranch(branchId: ChatBranchId): Promise<void> {
    if (!activeChatId) {
      return;
    }
    refresh(activeChatId, await activateBranch(activeChatId, branchId));
  }

  function handleStartEdit(message: AppMessage): void {
    setEditingMessageId(message.id);
    setEditingDraft(message.content);
  }

  function handleCancelEdit(): void {
    setEditingMessageId(null);
    setEditingDraft("");
  }

  async function handleSaveMessageEdit(messageId: string): Promise<void> {
    if (!activeChatId) {
      return;
    }

    const trimmed = editingDraft.trim();
    if (!trimmed) {
      return;
    }

    setMessageActionId(messageId);
    try {
      refresh(activeChatId, await editChatMessage(activeChatId, messageId, trimmed));
      setEditingMessageId(null);
      setEditingDraft("");
      setChatNotice("");
    } finally {
      setMessageActionId(null);
    }
  }

  async function handleDeleteMessage(messageId: string): Promise<void> {
    if (!activeChatId || !window.confirm("Delete this message?")) {
      return;
    }

    setMessageActionId(messageId);
    try {
      refresh(activeChatId, await deleteChatMessage(activeChatId, messageId));
      if (editingMessageId === messageId) {
        setEditingMessageId(null);
        setEditingDraft("");
      }
      setChatNotice("");
    } finally {
      setMessageActionId(null);
    }
  }

  async function handleRegenerateMessage(messageId: string): Promise<void> {
    if (!activeChatId) {
      return;
    }

    if (!canSendViaActiveProfile) {
      setChatNotice(
        "Regeneration is unavailable until a provider profile is activated and its default model is set.",
      );
      return;
    }

    setIsSending(true);
    setMessageActionId(messageId);
    setChatNotice("");
    try {
      refresh(activeChatId, await regenerateChatMessage(activeChatId, messageId));
    } catch (error) {
      refresh(activeChatId, await fetchChat(activeChatId));
      setChatNotice(error instanceof Error ? error.message : "Regeneration failed.");
    } finally {
      setIsSending(false);
      setMessageActionId(null);
    }
  }

  async function handleSelectMessageVariant(messageId: string, variantIndex: number): Promise<void> {
    if (!activeChatId || variantIndex < 0) {
      return;
    }

    refresh(activeChatId, await selectMessageVariant(activeChatId, messageId, variantIndex));
  }

  async function handleImportFiles(files: FileList | File[]): Promise<void> {
    const firstFile = Array.from(files)[0];
    if (!firstFile) {
      return;
    }

    setImportNotice("");

    try {
      const imported = await importFile(firstFile, { chatId: activeChatId ?? undefined });

      refresh(imported.activeChatId, imported.snapshot);

      if (imported.imported.kind === "character") {
        setMode("play");
        setImportNotice(
          `Imported character: ${imported.imported.name}${formatImportWarnings(imported.imported.warningCount)}`,
        );
      } else {
        setImportNotice(
          `Attached lorebook: ${imported.imported.name} -> ${imported.imported.attachedToCharacterName ?? "current character"}${formatImportWarnings(imported.imported.warningCount)}`,
        );
      }
    } catch (error) {
      setImportNotice(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsImportDragActive(false);
    }
  }

  function handleImportDragOver(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setIsImportDragActive(true);
  }

  function handleImportDragLeave(): void {
    setIsImportDragActive(false);
  }

  function handleImportDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setIsImportDragActive(false);
    if (event.dataTransfer.files.length > 0) {
      void handleImportFiles(event.dataTransfer.files);
    }
  }

  function handleImportInputChange(event: ChangeEvent<HTMLInputElement>): void {
    if (event.target.files && event.target.files.length > 0) {
      void handleImportFiles(event.target.files);
      event.target.value = "";
    }
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
    connection,
    patchConnection,
    isImportDragActive,
    importNotice,
    providerProfiles,
    selectedProviderProfileId,
    setSelectedProviderProfileId,
    editingMessageId,
    editingDraft,
    setEditingDraft,
    messageActionId,
    pendingUserMessageContent,
    chatNotice,
    isSavingCharacter,
    characterSaveNotice,
    isImporting,
    characterTabs,
    canConnect,
    canRefreshModels,
    canUseLiveApi,
    canSendViaActiveProfile,
    activeProviderProfile,
    handleActivateProviderProfile,
    personas,
    renderConnectionStatus,
    renderSendLabel,
    renderConnectionHint,
    handleSend,
    handleConnect,
    handleLoadProviderProfile,
    handleSaveProviderProfile,
    handleDeleteProviderProfile,
    handleConnectSavedProfile,
    handleRefreshProviderModels,
    handleSwitchChat,
    handleSaveCharacter,
    handleSavePersona,
    handleSetChatPersona,
    handleFork,
    handleActivateBranch,
    handleStartEdit,
    handleCancelEdit,
    handleSaveMessageEdit,
    handleDeleteMessage,
    handleRegenerateMessage,
    handleSelectMessageVariant,
    handleImportDragOver,
    handleImportDragLeave,
    handleImportDrop,
    handleImportInputChange,
  };
}

function buildCharacterTabs(snapshot: AppSnapshot): CharacterTab[] {
  const seen = new Set<string>();
  const result: CharacterTab[] = [];

  for (const chat of snapshot.chats) {
    if (seen.has(chat.characterName)) {
      continue;
    }

    seen.add(chat.characterName);
    result.push({
      id: chat.characterName,
      name: chat.characterName,
      subtitle: chat.subtitle,
      chatId: chat.id,
    });
  }

  return result;
}

function formatImportWarnings(count: number): string {
  return count > 0 ? ` (${count} warning${count === 1 ? "" : "s"})` : "";
}

function normalizeConnectedModels(
  models: Array<{
    id: string;
    name?: string;
    context_length?: number;
    owned_by?: string;
  }>,
): OpenAiModelOption[] {
  return models.map((model) => ({
    id: model.id,
    label: model.name?.trim() || model.owned_by?.trim()
      ? [model.id, model.name || model.owned_by].filter(Boolean).join(" - ")
      : model.id,
  }));
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
