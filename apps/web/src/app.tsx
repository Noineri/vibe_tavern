import type { ChangeEvent, DragEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import type { ChatBranchId, ChatId, Message } from "@rp-platform/domain";
import {
  activateBranch,
  assembleCurrentPrompt,
  appendMessageVariant,
  bootstrapApp,
  connectProviderProfile,
  deleteChatMessage,
  deleteProviderProfile,
  editChatMessage,
  fetchChat,
  fetchProviderProfile,
  fetchProviderProfileModels,
  forkBranch,
  generateProviderProfileReply,
  listProviderProfiles,
  saveProviderProfile,
  selectMessageVariant,
  sendChatMessage,
  updateCharacter,
  type AppSnapshot,
  type ProviderProfileRecord,
} from "./app-client.js";
import { BuildMode, type BuildCharacterDraft, type BuildTab } from "./components/BuildMode.js";
import { ImportSurface } from "./components/ImportSurface.js";
import { PlayMode } from "./components/PlayMode.js";
import { ProviderModal } from "./components/ProviderModal.js";
import { SidePanel } from "./components/SidePanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopBar } from "./components/TopBar.js";
import type {
  AppMode,
  CharacterTab,
  ConnectionState,
  SavedConnectionState,
  SidePanel as SidePanelState,
  ThemeMode,
} from "./components/app-shell-types.js";
import { normalizeOpenAiCompatibleBaseUrl, type OpenAiModelOption } from "./openai-compatible.js";
import { useCharacterImport } from "./hooks/use-character-import.js";

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

export function App() {
  const [activeChatId, setActiveChatId] = useState<ChatId | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<AppMode>("play");
  const [theme, setTheme] = useState<ThemeMode>(() => readSavedTheme());
  const [buildTab, setBuildTab] = useState<BuildTab>("character");
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [panel, setPanel] = useState<SidePanelState>("closed");
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
  const [isSavingCharacter, setIsSavingCharacter] = useState(false);
  const [characterSaveNotice, setCharacterSaveNotice] = useState("");
  const { importFile, isImporting } = useCharacterImport();

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

  function openConnectionPanel(): void {
    setIsProviderModalOpen(true);
  }

  async function handleSend(): Promise<void> {
    const trimmed = draft.trim();
    if (!trimmed || isSending || !activeChatId) {
      return;
    }

    if (!canUseLiveApi || !connection.activeProviderProfileId) {
      setConnection((current) => ({
        ...current,
        error: "Message sending is unavailable because no saved provider profile is currently active.",
      }));
      return;
    }

    setDraft("");
    setPendingUserMessageContent(trimmed);

    setIsSending(true);

    try {
      refresh(activeChatId, await sendChatMessage(activeChatId, {
        content: trimmed,
        providerProfileId: connection.activeProviderProfileId,
        model: connection.model,
      }));
    } catch (error) {
      if (activeChatId) {
        refresh(activeChatId, await fetchChat(activeChatId));
      }
      if (error instanceof Error && error.message) {
        setConnection((current) => ({
          ...current,
          status: "error",
          error: error.message,
        }));
      }
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

    try {
      const saved = await saveProviderProfile({
        id: selectedProviderProfileId || undefined,
        name,
        type: "openai_compat",
        endpoint,
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
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not save provider profile.",
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
        status: "error",
        error: error instanceof Error ? error.message : "Could not refresh model list.",
      });
    }
  }

  async function handleSwitchChat(chatId: ChatId): Promise<void> {
    refresh(chatId, await fetchChat(chatId));
  }

  async function handleSaveCharacter(draft: BuildCharacterDraft): Promise<void> {
    if (!activeChatId || !snapshot) {
      return;
    }

    setIsSavingCharacter(true);
    setCharacterSaveNotice("");

    try {
      const nextSnapshot = await updateCharacter(snapshot.character.id, {
        chatId: activeChatId,
        name: draft.name,
        description: draft.description,
        scenario: draft.scenario,
      });
      refresh(activeChatId, nextSnapshot);
      setCharacterSaveNotice("Character card saved.");
    } catch (error) {
      setCharacterSaveNotice(error instanceof Error ? error.message : "Could not save character.");
    } finally {
      setIsSavingCharacter(false);
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
    } finally {
      setMessageActionId(null);
    }
  }

  async function handleRegenerateMessage(messageId: string): Promise<void> {
    if (!activeChatId) {
      return;
    }

    setIsSending(true);
    setMessageActionId(messageId);
    try {
      const prompt = await assembleCurrentPrompt(activeChatId, {
        excludeMessageId: messageId,
      });
      const reply = await generateReplyFromPrompt(prompt);
      refresh(activeChatId, await appendMessageVariant(activeChatId, messageId, { content: reply }));
    } catch (error) {
      refresh(activeChatId, await fetchChat(activeChatId));
      setConnection((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "Regeneration failed.",
      }));
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

  function patchConnection(patch: Partial<ConnectionState>): void {
    setConnection((current) => ({
      ...current,
      ...patch,
      status: patch.status ?? current.status,
    }));
  }

  function renderConnectionStatus(): string {
    if (connection.status === "connecting") {
      return "connecting...";
    }
    if (connection.status === "connected") {
      return connection.model
        ? `connected - ${connection.model}`
        : "connected";
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
  if (canUseLiveApi) {
    return "Send message";
  }
  return "Model unavailable";
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

  async function generateReplyFromPrompt(prompt: AssemblePromptResponse): Promise<string> {
    if (!connection.activeProviderProfileId) {
      throw new Error("No active provider profile is connected.");
    }

    const reply = await generateProviderProfileReply(connection.activeProviderProfileId, {
      model: connection.model,
      prompt,
    });

    setConnection((current) => ({
      ...current,
      status: "connected",
      error: "",
    }));
    return reply;
  }

  if (isLoading) {
    return (
      <div className="app-shell">
        <main className="main-shell">
          <section className="build-content">
            <div className="build-title">Loading RP Platform</div>
            <div className="build-copy">
              {loadError || "Restoring the local application state."}
            </div>
            {loadError && (
              <button className="pill-btn active" onClick={() => void loadBootstrap()}>
                Retry
              </button>
            )}
          </section>
        </main>
      </div>
    );
  }

  if (!snapshot || !activeChatId) {
    return (
      <div className="app-shell">
        <main className="main-shell">
          <section className="build-content">
            <div className="build-title">No chats yet</div>
            <div className="build-copy">
              The app starts empty. Import a character card PNG or JSON to create the first chat.
            </div>
            <ImportSurface
              isImportDragActive={isImportDragActive}
              isImporting={isImporting}
              importNotice={importNotice}
              onDragOver={handleImportDragOver}
              onDragLeave={handleImportDragLeave}
              onDrop={handleImportDrop}
              onFileChange={handleImportInputChange}
            />
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        sidebarCollapsed={sidebarCollapsed}
        activeChatId={activeChatId}
        characterTabs={characterTabs}
        chats={snapshot.chats}
        personaName={snapshot.persona?.name ?? "No persona"}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        onSwitchChat={(chatId) => void handleSwitchChat(chatId)}
      />

      <main className="main-shell">
        <TopBar
          characterName={snapshot.character.name}
          characterSubtitle={snapshot.character.subtitle}
          activatedLoreCount={snapshot.promptTrace?.activatedLoreEntries.length ?? 0}
          retrievedMemoryCount={snapshot.promptTrace?.retrievedMemories.length ?? 0}
          providerLabel={connection.providerLabel || "Provider"}
          providerModelLabel={summarizeModelLabel(connection)}
          providerConnected={canUseLiveApi}
          mode={mode}
          theme={theme}
          onOpenProviderSettings={openConnectionPanel}
          onOpenTracePanel={() => {
            setIsProviderModalOpen(false);
            setPanel("trace");
          }}
          onToggleMode={() => setMode((value) => (value === "play" ? "build" : "play"))}
          onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        />

        {mode === "build" ? (
          <BuildMode
            activeTab={buildTab}
            characterId={snapshot.character.id}
            characterName={snapshot.character.name}
            description={snapshot.character.description}
            scenario={snapshot.character.scenario}
            personaName={snapshot.persona?.name ?? "No persona"}
            personaDescription={snapshot.persona?.description ?? "No persona is attached to this chat yet."}
            promptTraceCount={snapshot.promptTraceHistory.length}
            providerLabel={connection.providerLabel}
            connectionStatus={renderConnectionStatus()}
            isSaving={isSavingCharacter}
            saveNotice={characterSaveNotice}
            connectionSettings={{
              connection,
              connectionHint: renderConnectionHint(),
              connectionStatus: renderConnectionStatus(),
              providerProfiles,
              selectedProviderProfileId,
              canConnect,
              canRefreshModels,
              onSelectedProviderProfileChange: setSelectedProviderProfileId,
              onLoadProviderProfile: () => void handleLoadProviderProfile(),
              onConnectSavedProfile: () => void handleConnectSavedProfile(),
              onDeleteProviderProfile: () => void handleDeleteProviderProfile(),
              onPatchConnection: patchConnection,
              onConnect: () => void handleConnect(),
              onRefreshModels: () => void handleRefreshProviderModels(),
              onSaveProviderProfile: () => void handleSaveProviderProfile(),
            }}
            importSurface={
              <ImportSurface
                isImportDragActive={isImportDragActive}
                isImporting={isImporting}
                importNotice={importNotice}
                onDragOver={handleImportDragOver}
                onDragLeave={handleImportDragLeave}
                onDrop={handleImportDrop}
                onFileChange={handleImportInputChange}
              />
            }
            onTabChange={setBuildTab}
            onSave={(draft) => void handleSaveCharacter(draft)}
          />
        ) : (
          <PlayMode
            messageList={{
              characterName: snapshot.character.name,
              scenario: snapshot.character.scenario,
              branches: snapshot.branches,
              activeBranchId: snapshot.activeBranch.id,
              messages: snapshot.messages,
              pendingUserMessageContent,
              editingMessageId,
              editingDraft,
              isSending,
              messageActionId,
              onActivateBranch: (branchId) => void handleActivateBranch(branchId),
              onFork: () => void handleFork(),
              onStartEdit: (message) => {
                setEditingMessageId(message.id);
                setEditingDraft(message.content);
              },
              onEditingDraftChange: setEditingDraft,
              onCancelEdit: () => {
                setEditingMessageId(null);
                setEditingDraft("");
              },
              onSaveEdit: (messageId) => void handleSaveMessageEdit(messageId),
              onDelete: (messageId) => void handleDeleteMessage(messageId),
              onRegenerate: (messageId) => void handleRegenerateMessage(messageId),
              onSelectVariant: (messageId, variantIndex) =>
                void handleSelectMessageVariant(messageId, variantIndex),
            }}
            inputArea={{
              characterName: snapshot.character.name,
              draft,
              tokenCount: activePromptTrace?.tokenAccounting.total ?? 0,
              sendLabel: renderSendLabel(),
              isSending,
              onDraftChange: setDraft,
              onSend: () => void handleSend(),
            }}
          />
        )}
      </main>

      <SidePanel
        panel={panel}
        activePromptTrace={activePromptTrace}
        promptTraceHistory={snapshot.promptTraceHistory}
        promptPayloadText={promptPayloadText}
        onClose={() => setPanel("closed")}
        onSelectTrace={setSelectedTraceId}
      />
      <ProviderModal
        isOpen={isProviderModalOpen}
        connection={connection}
        connectionHint={renderConnectionHint()}
        connectionStatus={renderConnectionStatus()}
        providerProfiles={providerProfiles}
        selectedProviderProfileId={selectedProviderProfileId}
        canConnect={canConnect}
        canRefreshModels={canRefreshModels}
        onClose={() => setIsProviderModalOpen(false)}
        onSelectedProviderProfileChange={setSelectedProviderProfileId}
        onLoadProviderProfile={() => void handleLoadProviderProfile()}
        onConnectSavedProfile={() => void handleConnectSavedProfile()}
        onDeleteProviderProfile={() => void handleDeleteProviderProfile()}
        onPatchConnection={patchConnection}
        onConnect={() => void handleConnect()}
        onRefreshModels={() => void handleRefreshProviderModels()}
        onSaveProviderProfile={() => void handleSaveProviderProfile()}
      />
    </div>
  );
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

function summarizeModelLabel(connection: ConnectionState): string {
  if (!connection.model) {
    return connection.status === "connected" ? "model not selected" : "not connected";
  }

  return connection.model;
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
