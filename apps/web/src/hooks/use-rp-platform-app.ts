import type { ChangeEvent, DragEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatBranchId, ChatId } from "@rp-platform/domain";
import type { ProviderProbeResponse } from "@rp-platform/api-contracts";
import {
  activateBranch,
  activateProviderProfile,
  archiveCharacter,
  bootstrapApp,
  cloneChat,
  createCharacter,
  createChat,
  deleteBranch,
  deleteChatMessage,
  deleteCharacter,
  deleteChat,
  deleteProviderProfile,
  editChatMessage,
  exportCharacter,
  exportChatJsonl,
  exportPromptTrace,
  fetchChat,
  fetchModelsByEndpoint as fetchModelsByEndpointClient,
  fetchProviderProfile,
  fetchProviderProfileModels as fetchModelsForProviderProfile,
  testProfileChat as testProfileChatClient,
  testProviderChat as testProviderChatClient,
  forkBranch,
  listProviderProfiles,
  regenerateChatMessage,
  renameChat,
  saveProviderProfile,
  selectMessageVariant,
  sendChatMessage,
  testProviderDraft,
  testProviderProfile,
  unarchiveCharacter,
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
import type { BuildCharacterDraft, BuildTab } from "../components/BuildMode.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import { useCharacterImport } from "./use-character-import.js";

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
    providerType: "openai_compat",
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
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfileRecord[]>([]);
  const [selectedProviderProfileId, setSelectedProviderProfileId] = useState("");
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
  const modelsCache = useRef<Map<string, { models: Array<{ id: string; label: string }>; ts: number }>>(new Map());

  const [personas, setPersonas] = useState<import("../app-client.js").PersonaRecord[]>([]);
  const [promptPresets, setPromptPresets] = useState<import("@rp-platform/api-contracts").PromptPresetDto[]>([]);
  const [activePromptPresetId, setActivePromptPresetId] = useState<string | null>(null);

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

  async function loadPromptPresets(): Promise<void> {
    try {
      const list = await (await import("../app-client.js")).listPromptPresets();
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

  async function handleCreatePromptPreset(input: { name: string; bindModel?: string; system?: string; jailbreak?: string; summary?: string; tools?: string }): Promise<{ id: string } | null> {
    try {
      const created = await (await import("../app-client.js")).createPromptPreset(input);
      await loadPromptPresets();
      setActivePromptPresetId(created.id);
      return { id: created.id };
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create preset.");
      return null;
    }
  }

  async function handleUpdatePromptPreset(presetId: string, patch: Partial<Omit<import("@rp-platform/api-contracts").PromptPresetDto, "id" | "createdAt" | "updatedAt">>): Promise<boolean> {
    try {
      const updated = await (await import("../app-client.js")).updatePromptPreset(presetId, patch);
      setPromptPresets((current) => current.map((p) => p.id === presetId ? updated : p));
      return true;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to save preset.");
      return false;
    }
  }

  async function handleDeletePromptPreset(presetId: string): Promise<boolean> {
    try {
      await (await import("../app-client.js")).deletePromptPreset(presetId);
      await loadPromptPresets();
      return true;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to delete preset.");
      return false;
    }
  }

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
      setIsFirstRun(boot.isFirstRun || import.meta.env.VITE_FORCE_FIRST_RUN === 'true');
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
        type: connection.providerType || "openai_compat",
        endpoint: normalizedBaseUrl,
        apiKey: connection.apiKey.trim() || undefined,
        defaultModel: connection.model.trim() || null,
        contextBudget: connection.maxTokens || 8192,
        temperature: connection.temperature,
        topP: connection.topP,
        minP: connection.minP,
        topK: connection.topK,
        typicalP: connection.typicalP,
        repPen: connection.repPen,
        freqPen: connection.freqPen,
        presPen: connection.presPen,
        maxTokens: connection.maxTokens,
        stopSeq: connection.stopSeq,
        seed: connection.seed,
        reasoningEffort: connection.reasoningEffort,
        streamResponse: connection.streamResponse,
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

      await handleTestSavedProviderProfile(saved.id);
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
        providerType: profile.type || "openai_compat",
        providerPreset: "",
        temperature: profile.temperature ?? 0.9,
        topP: profile.topP ?? 1.0,
        minP: profile.minP ?? 0.05,
        topK: profile.topK ?? 40,
        typicalP: profile.typicalP ?? 1.0,
        repPen: profile.repPen ?? 1.1,
        freqPen: profile.freqPen ?? 0.0,
        presPen: profile.presPen ?? 0.0,
        maxTokens: profile.maxTokens ?? 8192,
        stopSeq: profile.stopSeq ?? "",
        seed: profile.seed ?? null,
        reasoningEffort: profile.reasoningEffort ?? "medium",
        streamResponse: profile.streamResponse ?? true,
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
            type: connection.providerType || "openai_compat",
            endpoint,
            apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
            defaultModel: connection.model.trim() || null,
            contextBudget: connection.maxTokens || 8192,
            temperature: connection.temperature,
            topP: connection.topP,
            minP: connection.minP,
            topK: connection.topK,
            typicalP: connection.typicalP,
            repPen: connection.repPen,
            freqPen: connection.freqPen,
            presPen: connection.presPen,
            maxTokens: connection.maxTokens,
            stopSeq: connection.stopSeq,
            seed: connection.seed,
            reasoningEffort: connection.reasoningEffort,
            streamResponse: connection.streamResponse,
          })
        : await saveProviderProfile({
            name,
            type: connection.providerType || "openai_compat",
            endpoint,
            apiKey: apiKeyInput || undefined,
            defaultModel: connection.model.trim() || null,
            contextBudget: connection.maxTokens || 8192,
            temperature: connection.temperature,
            topP: connection.topP,
            minP: connection.minP,
            topK: connection.topK,
            typicalP: connection.typicalP,
            repPen: connection.repPen,
            freqPen: connection.freqPen,
            presPen: connection.presPen,
            maxTokens: connection.maxTokens,
            stopSeq: connection.stopSeq,
            seed: connection.seed,
            reasoningEffort: connection.reasoningEffort,
            streamResponse: connection.streamResponse,
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
      const profile = await fetchProviderProfile(providerProfileId);
      patchConnection({
        providerLabel: profile.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(profile.endpoint),
        apiKey: "",
        model: profile.defaultModel ?? "",
        activeProviderProfileId: profile.id,
        hasStoredApiKey: profile.hasStoredApiKey,
        status: "connected",
        error: "",
      });
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not activate provider profile.",
      });
    }
  }

  async function handleDeleteProviderProfile(providerProfileId?: string): Promise<void> {
    const targetId = providerProfileId || selectedProviderProfileId;
    if (!targetId) {
      return;
    }

    try {
      await deleteProviderProfile(targetId);
      await loadProviderProfiles();
      if (connection.activeProviderProfileId === targetId) {
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

  async function handleCreateProviderProfile(): Promise<ProviderProfileRecord | null> {
    try {
      const saved = await saveProviderProfile({
        name: "Новый профиль",
        type: "openai_compat",
        endpoint: "",
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
      });
      await loadProviderProfiles();
      return saved;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create provider profile.");
      return null;
    }
  }

  async function handleDuplicateProviderProfile(id: string): Promise<ProviderProfileRecord | null> {
    const existing = providerProfiles.find((p) => p.id === id);
    if (!existing) return null;
    try {
      const saved = await saveProviderProfile({
        name: `${existing.name} (copy)`,
        type: existing.type,
        endpoint: existing.endpoint,
        defaultModel: existing.defaultModel,
        temperature: existing.temperature ?? 0.9,
        topP: existing.topP ?? 1.0,
        minP: existing.minP ?? 0.05,
        topK: existing.topK ?? 40,
        typicalP: existing.typicalP ?? 1.0,
        repPen: existing.repPen ?? 1.1,
        freqPen: existing.freqPen ?? 0.0,
        presPen: existing.presPen ?? 0.0,
        maxTokens: existing.maxTokens ?? 8192,
        stopSeq: existing.stopSeq ?? "",
        seed: existing.seed ?? null,
        reasoningEffort: existing.reasoningEffort ?? "medium",
        streamResponse: existing.streamResponse ?? true,
      });
      await loadProviderProfiles();
      return saved;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to duplicate provider profile.");
      return null;
    }
  }

  async function handleTestDraftConnection(endpoint: string, apiKey: string): Promise<ProviderProbeResponse> {
    return testProviderDraft({ endpoint, apiKey });
  }

  async function handleTestChat(
    profileId: string | null,
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<import("../app-client.js").TestChatResponse> {
    if (profileId) {
      return testProfileChatClient(profileId, model);
    }
    return testProviderChatClient(baseUrl, apiKey, model);
  }

  async function handleFetchModelsForProfile(providerProfileId: string): Promise<Array<{ id: string; label: string }>> {
    const response = await fetchModelsForProviderProfile(providerProfileId);
    return response.models;
  }

  async function handleFetchModelsByEndpoint(
    baseUrl: string,
    apiKey?: string,
    useCache = true,
  ): Promise<Array<{ id: string; label: string }>> {
    const cacheKey = `${baseUrl}::${apiKey ?? ""}`;
    if (useCache) {
      const cached = modelsCache.current.get(cacheKey);
      if (cached && Date.now() - cached.ts < 5 * 60_000) {
        return cached.models;
      }
    }
    const response = await fetchModelsByEndpointClient(baseUrl, apiKey);
    modelsCache.current.set(cacheKey, { models: response.models, ts: Date.now() });
    return response.models;
  }

  async function handleRefreshProfiles(): Promise<void> {
    await loadProviderProfiles();
  }

  async function handleSaveProviderProfileFromForm(
    form: import("../components/ProviderModal.js").FormState,
  ): Promise<ProviderProfileRecord | null> {
    const name = form.name.trim();
    const endpoint = form.baseUrl.trim();
    if (!name || !endpoint) return null;
    const apiKeyInput = form.apiKey.trim();
    const patch = {
      name,
      type: form.type || "openai_compat",
      endpoint,
      apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
      defaultModel: form.model.trim() || null,
      contextBudget: form.maxTokens || 8192,
      temperature: form.temperature,
      topP: form.topP,
      minP: form.minP,
      topK: form.topK,
      typicalP: form.typicalP,
      repPen: form.repPen,
      freqPen: form.freqPen,
      presPen: form.presPen,
      maxTokens: form.maxTokens,
      stopSeq: form.stopSeq,
      seed: form.seed,
      reasoningEffort: form.reasoningEffort,
      streamResponse: form.streamResponse,
    };
    try {
      const saved = await updateProviderProfile(form.id, patch);
      await loadProviderProfiles();
      return saved;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Could not save provider profile.");
      return null;
    }
  }

  async function handleConnectSavedProfile(): Promise<void> {
    if (!selectedProviderProfileId) {
      return;
    }

    await handleTestSavedProviderProfile(selectedProviderProfileId);
  }

  async function handleTestSavedProviderProfile(providerProfileId: string): Promise<void> {
    if (!providerProfileId) {
      return;
    }

    setChatNotice("");

    try {
      const result = await testProviderProfile(providerProfileId);
      if (result.success) {
        const countHint = typeof result.modelCount === "number"
          ? ` Provider advertises ${result.modelCount} models — press Refresh models to load them.`
          : "";
        setChatNotice(`Connection verified.${countHint}`);
      } else {
        setChatNotice(result.error ?? "Connection probe failed.");
      }
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Connection probe failed.");
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
      const [profile, response] = await Promise.all([
        fetchProviderProfile(providerProfileId),
        fetchModelsForProviderProfile(providerProfileId),
      ]);
      const models = response.models;
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
        subtitle: draftInput.personalitySummary,
        firstMessage: draftInput.firstMessage,
        scenario: draftInput.scenario,
        systemPrompt: draftInput.systemPrompt,
        mesExample: draftInput.mesExample,
        alternateGreetings: draftInput.alternateGreetings,
        postHistoryInstructions: draftInput.postHistoryInstructions,
        creatorNotes: draftInput.creatorNotes,
        characterBook: draftInput.characterBook,
        depthPrompt: draftInput.depthPrompt,
        depthPromptDepth: draftInput.depthPromptDepth,
        depthPromptRole: draftInput.depthPromptRole,
        extensions: draftInput.extensions,
        tags: draftInput.tags,
      });
      refresh(activeChatId, nextSnapshot);
      setCharacterSaveNotice("Character card saved.");
    } catch (error) {
      setCharacterSaveNotice(error instanceof Error ? error.message : "Could not save character.");
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleSavePersona(personaId: string, draftInput: { name: string; description: string }): Promise<void> {
    if (!activeChatId) {
      return;
    }

    setIsSavingCharacter(true);
    setCharacterSaveNotice("");

    try {
      const nextSnapshot = await updatePersona(personaId, {
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

  async function handleCreatePersona(input: { name: string; description: string }): Promise<{ id: string } | null> {
    try {
      const created = await (await import("../app-client.js")).createPersona({
        name: input.name.trim(),
        description: input.description.trim(),
      });
      await loadPersonas();
      return { id: created.id };
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create persona.");
      return null;
    }
  }

  async function handleDeletePersona(personaId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await (await import("../app-client.js")).deletePersona(personaId);
      await loadPersonas();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Failed to delete persona." };
    }
  }

  async function handleSetPersonalLorebook(personaId: string, enabled: boolean): Promise<{ enabled: boolean; lorebookId: string | null } | null> {
    try {
      return await (await import("../app-client.js")).setPersonalLorebookEnabled(personaId, enabled);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to update personal lorebook.");
      return null;
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

  async function handleDeleteActiveBranch(): Promise<void> {
    if (!activeChatId || !snapshot) {
      return;
    }
    const activeBranch = snapshot.activeBranch;
    const rootBranch = snapshot.branches.find((b) => b.parentBranchId === null);
    if (!rootBranch || activeBranch.id === rootBranch.id) {
      setChatNotice("Cannot delete: active branch is the main timeline.");
      return;
    }
    try {
      refresh(activeChatId, await deleteBranch(activeChatId, activeBranch.id));
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Branch delete failed.");
    }
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

  async function handleArchiveCharacter(characterId: string): Promise<void> {
    await archiveCharacter(characterId);
    await loadBootstrap();
  }

  async function handleUnarchiveCharacter(characterId: string): Promise<void> {
    await unarchiveCharacter(characterId);
    await loadBootstrap();
  }

  async function handleDeleteCharacter(characterId: string): Promise<void> {
    await deleteCharacter(characterId);
    await loadBootstrap();
  }

  async function handleDeleteChat(chatId: ChatId): Promise<void> {
    await deleteChat(chatId);
    await loadBootstrap();
  }

  async function handleRenameChat(chatId: ChatId, title: string): Promise<void> {
    await renameChat(chatId, title);
    await loadBootstrap();
  }

  async function handleCreateChat(characterId?: string): Promise<void> {
    const resolvedId = characterId ?? snapshot?.character.id;
    if (!resolvedId) return;
    try {
      const next = await createChat(resolvedId);
      refresh(next.activeChat.id, next);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create chat.");
    }
  }

  async function handleCreateCharacter(input: { name: string; description?: string; firstMessage?: string }): Promise<void> {
    try {
      const result = await createCharacter(input);
      setIsFirstRun(false);
      refresh(result.activeChatId, result.snapshot);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create character.");
    }
  }

  async function handleFreeChat(): Promise<void> {
    try {
      const next = await createChat();
      setIsFirstRun(false);
      refresh(next.activeChat.id, next);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create free chat.");
    }
  }

  async function handleCloneChat(chatId: ChatId): Promise<void> {
    try {
      const next = await cloneChat(chatId);
      refresh(next.activeChat.id, next);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to clone chat.");
    }
  }

  async function handleExportCharacter(characterId: string): Promise<void> {
    try {
      const data = await exportCharacter(characterId);
      const name = snapshot?.character.name ?? "character";
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeName}.chara_card_v3.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to export character.");
    }
  }

  async function handleExportChatJsonl(chatId: ChatId): Promise<void> {
    try {
      const text = await exportChatJsonl(chatId);
      const chatItem = snapshot?.chats.find((c) => c.id === chatId);
      const safeTitle = (chatItem?.title ?? "chat").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeTitle}.jsonl`, text, "application/x-ndjson");
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to export chat.");
    }
  }

  async function handleExportPromptTrace(traceId: string): Promise<void> {
    try {
      const data = await exportPromptTrace(traceId);
      downloadTextFile(`prompt-trace-${traceId}.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to export prompt trace.");
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
    providerProfiles,
    selectedProviderProfileId,
    setSelectedProviderProfileId,
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
    canConnect,
    canRefreshModels,
    canUseLiveApi,
    canSendViaActiveProfile,
    activeProviderProfile,
    handleActivateProviderProfile,
    handleCreateProviderProfile,
    handleDuplicateProviderProfile,
    handleTestDraftConnection,
    handleTestChat,
    handleFetchModelsForProfile,
    handleFetchModelsByEndpoint,
    handleRefreshProfiles,
    handleSaveProviderProfileFromForm,
    personas,
    renderSendLabel,
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
    handleCreatePersona,
    handleDeletePersona,
    handleSetPersonalLorebook,
    promptPresets,
    activePromptPresetId,
    setActivePromptPresetId,
    handleCreatePromptPreset,
    handleUpdatePromptPreset,
    handleDeletePromptPreset,
    handleFork,
    handleActivateBranch,
    handleDeleteActiveBranch,
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
    handleImportFiles,
    confirmDestroy,
    setConfirmDestroy,
    renamingChatId,
    renameDraft,
    setRenamingChatId,
    setRenameDraft,
    handleArchiveCharacter,
    handleUnarchiveCharacter,
    handleDeleteCharacter,
    handleDeleteChat,
    handleRenameChat,
    activePromptTraceId: activePromptTrace?.id ?? null,
    isFirstRun,
    handleCreateCharacter,
    handleFreeChat,
    onCreateChat: handleCreateChat,
    onCloneChat: handleCloneChat,
    onExportCharacter: handleExportCharacter,
    onExportChatJsonl: handleExportChatJsonl,
    onExportPromptTrace: handleExportPromptTrace,
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

function formatImportWarnings(count: number): string {
  return count > 0 ? ` (${count} warning${count === 1 ? "" : "s"})` : "";
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

function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
