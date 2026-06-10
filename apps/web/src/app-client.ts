import { hc } from "hono/client";
import type { Chat, ChatBranch, ChatBranchId, ChatId, Message, MessageVariant } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, PromptPresetDto, PromptTraceRecordDto, ProviderProbeResponse } from "@vibe-tavern/domain";
import type { AppType } from "@vibe-tavern/api";
import { getGatewayBaseUrl } from "./gateway-client.js";
import { parseSSEStream } from "./lib/sse-parser.js";
import { getMobileToken, appendTokenQuery } from "./lib/mobile-token.js";

const client = hc<AppType>(getGatewayBaseUrl(), {
  headers: () => {
    const token = getMobileToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  },
});

export interface ChatListItem {
  id: ChatId;
  title: string;
  characterId: string;
  characterName: string;
  subtitle: string;
  activeBranchLabel: string;
  messageCount: number;
  updatedAt: string;
}

export interface PersonaRecord {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
  avatarCropJson: string | null;
  defaultForNewChats: boolean;
}

export interface UiSettingsRecord {
  id: string;
  theme: string;
  chatFontSize: number;
  uiFontSize: number;
  messageWidth: number;
  language: string;
  activePromptPresetId: string | null;
  aiAssistantProviderId: string | null;
  aiAssistantModelName: string | null;
  updatedAt: string;
}

export interface ChatSummaryRecord {
  id: string;
  chatId: string;
  branchId: string;
  label: string;
  content: string;
  summarizedFrom: number;
  summarizedTo: number;
  includeInContext: boolean;
  excludeSummarized: boolean;
  source: "manual" | "auto";
  sortOrder: number;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoSummaryConfig {
  enabled: boolean;
  everyN: number;
  useChatModel: boolean;
  excludeSummarized: boolean;
  providerProfileId?: string;
  model?: string;
}

export interface AppSnapshot {
  chats: ChatListItem[];
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null }>;
  activeChat: Chat & { summary?: string; messageHistoryLimit?: number; autoSummaryConfig?: AutoSummaryConfig };
  activeBranch: ChatBranch;
  branches: ChatBranch[];
  messages: AppMessage[];
  summaries: Array<{
    id: string;
    kind: string;
    summary: string;
  }>;
  promptTrace: PromptTraceRecordDto | null;
  promptTraceHistory: PromptTraceRecordDto[];
  contextPreview: AssemblePromptResponse | null;
  character: {
    id: string;
    name: string;
    description: string;
    scenario: string;
    systemPrompt: string;
    subtitle: string;
    firstMessage: string | null;
    mesExample: string | null;
    mesExampleMode: string;
    mesExampleDepth: number;
    alternateGreetings: string[];
    postHistoryInstructions: string | null;
    creatorNotes: string | null;
    depthPrompt: string | null;
    depthPromptDepth: number | null;
    depthPromptRole: string | null;
    tags: string[];
    avatarAssetId: string | null;
    avatarFullAssetId: string | null;
    avatarCropJson: string | null;
    personalitySummary: string | null;
  };
  persona: {
    id: string;
    name: string;
    description: string;
    pronouns: string | null;
    avatarAssetId: string | null;
    avatarFullAssetId: string | null;
    avatarCropJson: string | null;
  } | null;
}

export interface AppMessage extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
  modelId: string | null;
}

export interface ImportJsonResponse {
  activeChatId: ChatId;
  snapshot: AppSnapshot;
  imported: {
    kind: "character" | "lorebook" | "chat";
    name: string;
    fileName: string;
    warningCount: number;
    warnings: string[];
    attachedToCharacterName?: string;
  };
}

export interface ProviderProfileRecord {
  id: string;
  name: string;
  providerPreset: string;
  endpoint: string;
  defaultModel: string | null;
  contextBudget: number | null;
  pinContextBudget: boolean;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  topA: number;
  typicalP: number;
  tfsZ: number;
  repeatLastN: number;
  mirostat: number;
  mirostatTau: number;
  mirostatEta: number;
  dryMultiplier: number;
  dryBase: number;
  dryAllowedLength: number;
  drySequenceBreakers: string[];
  xtcThreshold: number;
  xtcProbability: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  stopSequences: string[];
  logitBias: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed: string | null;
  reasoningEffort: string;
  showReasoning: boolean;
  streamResponse: boolean;
  customSamplers: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  hasStoredApiKey: boolean;
}

export interface LoreEntryRecord {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: string;
  position: string;
  depth: number;
  priority: number;
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  enabled: boolean;
  constant: boolean;
  probability: number;
  ignoreBudget: boolean;
  role: string;
  groupName: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  useGroupScoring: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: string[];
  characterFilterExclude: boolean;
  triggers: string[];
  matchSources: string[];
  sortOrder: number;
}

export interface LorebookRecord {
  id: string;
  name: string;
  description: string;
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  scanDepth: number;
  tokenBudget: number;
  recursiveScanning: boolean;
  enabled: boolean;
}

export interface LorebookLinkRecord {
  lorebookId: string;
  targetType: 'character' | 'persona';
  targetId: string;
}

export interface TestChatResponse {
  success: boolean;
  reply?: string;
  error?: string;
}

export interface FavoriteProviderModelRecord {
  id: string;
  providerProfileId: string;
  modelId: string;
  label: string | null;
  contextLength: number | null;
  createdAt: string;
}

export interface ProviderModelOption {
  id: string;
  label: string;
  contextLength?: number;
  capabilities?: { vision?: boolean; reasoning?: boolean; tools?: boolean; webSearch?: boolean; premium?: boolean };
  pricing?: { input?: number; output?: number };
  description?: string;
}

export type ChatGenerationStatus =
  | "idle"
  | "preparing"
  | "waiting_full"
  | "streaming"
  | "aborting"
  | "cancelled"
  | "failed";

type RpcResponse = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };

async function unwrapRpc<T>(response: RpcResponse): Promise<T> {
  if (!response.ok) {
    throw await unwrapError(response);
  }
  return response.json() as Promise<T>;
}

async function unwrapError(response: RpcResponse): Promise<Error> {
  const errorBody = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
  const error = errorBody?.error;
  const message = typeof error === "string" ? error : error?.message || `Request failed: ${response.status}`;
  return new Error(message);
}

export async function bootstrapApp(): Promise<{
  initialChatId: ChatId | null;
  snapshot: AppSnapshot | null;
  isFirstRun: boolean;
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarCropJson: string | null }>;
  promptPresets: PromptPresetDto[];
  uiSettings: UiSettingsRecord;
  isArmServer: boolean;
}> {
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/bootstrap`), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const data = await unwrapRpc<{
    initialChatId: ChatId | null;
    snapshot: AppSnapshot | null;
    isFirstRun?: boolean;
    allCharacters?: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarCropJson?: string | null }>;
    promptPresets?: PromptPresetDto[];
    uiSettings?: UiSettingsRecord;
    isArmServer?: boolean;
  }>(response);

  return {
    initialChatId: data.initialChatId,
    snapshot: data.snapshot ? normalizeSnapshot(data.snapshot) : null,
    isFirstRun: data.isFirstRun ?? false,
    allCharacters: (data.allCharacters ?? []).map(c => ({ ...c, avatarCropJson: c.avatarCropJson ?? null })),
    promptPresets: data.promptPresets ?? [],
    uiSettings: data.uiSettings ?? {
      id: "default",
      theme: "dark",
      chatFontSize: 15,
      uiFontSize: 14,
      messageWidth: 700,
      language: "en",
      activePromptPresetId: null,
      aiAssistantProviderId: null,
      aiAssistantModelName: null,
      updatedAt: "",
    },
    isArmServer: data.isArmServer ?? false,
  };
}

export async function fetchUiSettings(): Promise<UiSettingsRecord> {
  const response = await client.api.settings.ui.$get();
  return unwrapRpc<UiSettingsRecord>(response);
}

export async function updateUiSettings(input: Partial<Pick<UiSettingsRecord, "theme" | "chatFontSize" | "uiFontSize" | "messageWidth" | "language" | "activePromptPresetId" | "aiAssistantProviderId" | "aiAssistantModelName">>): Promise<UiSettingsRecord> {
  const response = await client.api.settings.ui.$patch({ json: input });
  return unwrapRpc<UiSettingsRecord>(response);
}

export async function fetchChat(chatId: ChatId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].$get({ param: { chatId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function updateCharacter(
  characterId: string,
  input: Partial<{
    chatId?: ChatId;
    name: string;
    description: string;
    personalitySummary: string | null;
    scenario: string;
    systemPrompt: string;
    firstMessage: string | null;
    mesExample: string | null;
    mesExampleMode?: "always" | "once" | "depth";
    mesExampleDepth?: number;
    alternateGreetings: string[];
    postHistoryInstructions: string | null;
    creatorNotes: string | null;
    depthPrompt: string | null;
    depthPromptDepth: number | null;
    depthPromptRole: string | null;
    tags: string[];
  }>,
): Promise<AppSnapshot> {
  const response = await client.api.characters[":characterId"].$patch({ param: { characterId }, json: input });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function updatePersona(
  personaId: string,
  input: {
    chatId?: ChatId;
    name: string;
    description: string;
    pronouns?: string | null;
    avatarAssetId?: string | null;
    avatarFullAssetId?: string | null;
    avatarCropJson?: string | null;
  },
): Promise<AppSnapshot> {
  const response = await client.api.personas[":personaId"].$patch({ param: { personaId }, json: input });
  const data = await unwrapRpc<AppSnapshot>(response);
  // When no chats exist (wizard), server returns { id } instead of full snapshot
  if (!data.character) return data as unknown as AppSnapshot;
  return normalizeSnapshot(data);
}

export async function listPersonas(): Promise<PersonaRecord[]> {
  const response = await client.api.personas.$get();
  return unwrapRpc<PersonaRecord[]>(response);
}

export async function createPersona(input: {
  name: string;
  description: string;
  pronouns?: string | null;
  defaultForNewChats?: boolean;
}): Promise<PersonaRecord> {
  const response = await client.api.personas.$post({ json: input });
  return unwrapRpc<PersonaRecord>(response);
}

export async function deletePersona(personaId: string): Promise<void> {
  const response = await client.api.personas[":personaId"].$delete({ param: { personaId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function duplicatePersona(personaId: string): Promise<PersonaRecord> {
  const response = await client.api.personas[":personaId"].duplicate.$post({ param: { personaId } });
  return unwrapRpc<PersonaRecord>(response);
}

export async function setDefaultPersona(personaId: string): Promise<void> {
  await client.api.personas[":personaId"]["set-default"].$post({ param: { personaId } });
}

export async function duplicateCharacter(characterId: string): Promise<ImportJsonResponse> {
  const response = await client.api.characters[":characterId"].duplicate.$post({ param: { characterId } });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  return {
    ...data,
    snapshot: normalizeSnapshot(data.snapshot),
  };
}

export async function listPromptPresets(): Promise<PromptPresetDto[]> {
  const response = await client.api["prompt-presets"].$get();
  return unwrapRpc<PromptPresetDto[]>(response);
}

export async function createPromptPreset(input: {
  name: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  prefill?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  authorsNotePosition?: "in_prompt" | "in_chat" | "after_chat";
  authorsNoteRole?: "system" | "user" | "assistant";
  summary?: string;
  tools?: string;
  customInjections?: PromptPresetDto["customInjections"];
  promptOrder?: PromptPresetDto["promptOrder"];
  advancedMode?: boolean;
  scriptAiSystemPrompt?: string;
}): Promise<PromptPresetDto> {
  const response = await client.api["prompt-presets"].$post({ json: input });
  return unwrapRpc<PromptPresetDto>(response);
}

export async function updatePromptPreset(
  presetId: string,
  patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>,
): Promise<PromptPresetDto> {
  const response = await client.api["prompt-presets"][":presetId"].$patch({ param: { presetId }, json: patch });
  return unwrapRpc<PromptPresetDto>(response);
}

export async function deletePromptPreset(presetId: string): Promise<void> {
  const response = await client.api["prompt-presets"][":presetId"].$delete({ param: { presetId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function getPersonalLorebookStatus(personaId: string): Promise<{ enabled: boolean; lorebookId: string | null }> {
  const response = await client.api.personas[":personaId"]["personal-lorebook"].$get({ param: { personaId } });
  return unwrapRpc<{ enabled: boolean; lorebookId: string | null }>(response);
}

export async function setPersonalLorebookEnabled(personaId: string, enabled: boolean): Promise<{ enabled: boolean; lorebookId: string | null }> {
  const response = await client.api.personas[":personaId"]["personal-lorebook"].$put({ param: { personaId }, json: { enabled } });
  return unwrapRpc<{ enabled: boolean; lorebookId: string | null }>(response);
}

export async function setChatPersona(chatId: import("@vibe-tavern/domain").ChatId, personaId: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["set-persona"].$post({ param: { chatId }, json: { personaId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function setChatPromptPreset(chatId: import("@vibe-tavern/domain").ChatId, promptPresetId: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["set-prompt-preset"].$post({ param: { chatId }, json: { promptPresetId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function sendChatMessage(
  chatId: ChatId,
  input: {
    content: string;
  },
  options?: { signal?: AbortSignal },
): Promise<AppSnapshot> {
  postSendDebug("web.client.sendChatMessage.start", { chatId, contentLength: input.content.length });
  const response = await client.api.chats[":chatId"].messages.$post(
    { param: { chatId }, json: input },
    { init: { signal: options?.signal } },
  );
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function summarizeChat(
  chatId: ChatId,
  input: { providerProfileId: string; model?: string; maxMessages: number },
  options?: { signal?: AbortSignal },
): Promise<{ summary: string; snapshot: AppSnapshot }> {
  const response = await client.api.chats[":chatId"].summary.$post(
    { param: { chatId }, json: input },
    { init: { signal: options?.signal } },
  );
  const data = await unwrapRpc<{ summary: string; snapshot: AppSnapshot }>(response);
  return { summary: data.summary, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function saveChatSummary(
  chatId: ChatId,
  summary: string,
): Promise<{ summary: string; snapshot: AppSnapshot }> {
  const response = await client.api.chats[":chatId"].summary.$put({ param: { chatId }, json: { summary } });
  const data = await unwrapRpc<{ summary: string; snapshot: AppSnapshot }>(response);
  return { summary: data.summary, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function listChatSummaries(chatId: ChatId): Promise<ChatSummaryRecord[]> {
  const response = await client.api.chats[":chatId"].summaries.$get({ param: { chatId } });
  return unwrapRpc<ChatSummaryRecord[]>(response);
}

export async function createChatSummary(
  chatId: ChatId,
  input: {
    label?: string;
    content?: string;
    summarizedFrom: number;
    summarizedTo: number;
    includeInContext?: boolean;
    excludeSummarized?: boolean;
    source?: "manual" | "auto";
    sortOrder?: number;
  },
): Promise<{ summary: ChatSummaryRecord; snapshot: AppSnapshot }> {
  const response = await client.api.chats[":chatId"].summaries.$post({ param: { chatId }, json: input });
  const data = await unwrapRpc<{ summary: ChatSummaryRecord; snapshot: AppSnapshot }>(response);
  return { summary: data.summary, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function updateChatSummary(
  chatId: ChatId,
  summaryId: string,
  input: Partial<Pick<ChatSummaryRecord, "label" | "content" | "summarizedFrom" | "summarizedTo" | "includeInContext" | "excludeSummarized" | "sortOrder">>,
): Promise<{ summary: ChatSummaryRecord; snapshot: AppSnapshot }> {
  const response = await client.api.chats[":chatId"].summaries[":summaryId"].$patch({ param: { chatId, summaryId }, json: input });
  const data = await unwrapRpc<{ summary: ChatSummaryRecord; snapshot: AppSnapshot }>(response);
  return { summary: data.summary, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function deleteChatSummary(chatId: ChatId, summaryId: string): Promise<{ ok: boolean; snapshot: AppSnapshot }> {
  const response = await client.api.chats[":chatId"].summaries[":summaryId"].$delete({ param: { chatId, summaryId } });
  const data = await unwrapRpc<{ ok: boolean; snapshot: AppSnapshot }>(response);
  return { ok: data.ok, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function generateChatSummary(
  chatId: ChatId,
  input: {
    providerProfileId: string;
    model?: string;
    summarizedFrom: number;
    summarizedTo: number;
    targetSummaryId?: string;
    label?: string;
    includeInContext?: boolean;
    excludeSummarized?: boolean;
  },
  options?: { signal?: AbortSignal },
): Promise<{ summary: string; chatSummary: ChatSummaryRecord; snapshot: AppSnapshot }> {
  const response = await client.api.chats[":chatId"].summaries.generate.$post(
    { param: { chatId }, json: input },
    { init: { signal: options?.signal } },
  );
  const data = await unwrapRpc<{ summary: string; chatSummary: ChatSummaryRecord; snapshot: AppSnapshot }>(response);
  return { summary: data.summary, chatSummary: data.chatSummary, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function updateMemorySettings(
  chatId: ChatId,
  input: { messageHistoryLimit?: number; autoSummaryConfig?: Partial<AutoSummaryConfig> },
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["memory-settings"].$patch({ param: { chatId }, json: input });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function sendChatMessageStream(
  chatId: ChatId,
  input: { content: string },
  opts: {
    signal?: AbortSignal;
    onStatus: (status: ChatGenerationStatus) => void;
    onChunk: (delta: string) => void;
    onReasoningChunk?: (delta: string) => void;
    onReasoningDone?: (info: { durationMs: number | null; redacted: boolean }) => void;
  },
): Promise<{ finishReason: string; usage?: Record<string, number> }> {
  const baseUrl = getGatewayBaseUrl();
  opts.onStatus("preparing");
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/chats/${chatId}/messages/stream`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: opts.signal,
  });

  if (!response.ok) {
    opts.onStatus("failed");
    throw new Error(`Stream request failed: ${response.status}`);
  }

  opts.onStatus("streaming");
  return parseSSEStream({
    response,
    signal: opts.signal,
    onStatus: opts.onStatus,
    onChunk: opts.onChunk,
    onReasoningChunk: opts.onReasoningChunk,
    onReasoningDone: opts.onReasoningDone,
  });
}

export async function regenerateChatMessageStream(
  chatId: ChatId,
  messageId: string,
  opts: {
    signal?: AbortSignal;
    onStatus: (status: ChatGenerationStatus) => void;
    onChunk: (delta: string) => void;
    onReasoningChunk?: (delta: string) => void;
    onReasoningDone?: (info: { durationMs: number | null; redacted: boolean }) => void;
  },
): Promise<{ finishReason: string; usage?: Record<string, number> }> {
  const baseUrl = getGatewayBaseUrl();
  opts.onStatus("preparing");
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/chats/${chatId}/messages/${messageId}/regenerate/stream`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
  });

  if (!response.ok) {
    opts.onStatus("failed");
    throw new Error(`Stream request failed: ${response.status}`);
  }

  opts.onStatus("streaming");
  return parseSSEStream({
    response,
    signal: opts.signal,
    onStatus: opts.onStatus,
    onChunk: opts.onChunk,
    onReasoningChunk: opts.onReasoningChunk,
    onReasoningDone: opts.onReasoningDone,
  });
}

export async function generateReply(
  chatId: ChatId,
  options?: { signal?: AbortSignal },
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["generate-reply"].$post(
    { param: { chatId } },
    { init: { signal: options?.signal } },
  );
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function generateReplyStream(
  chatId: ChatId,
  opts: {
    signal?: AbortSignal;
    onStatus: (status: ChatGenerationStatus) => void;
    onChunk: (delta: string) => void;
    onReasoningChunk?: (delta: string) => void;
    onReasoningDone?: (info: { durationMs: number | null; redacted: boolean }) => void;
  },
): Promise<{ finishReason: string; usage?: Record<string, number> }> {
  const baseUrl = getGatewayBaseUrl();
  opts.onStatus("preparing");
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/chats/${chatId}/generate-reply/stream`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
  });

  if (!response.ok) {
    opts.onStatus("failed");
    throw new Error(`Stream request failed: ${response.status}`);
  }

  opts.onStatus("streaming");
  return parseSSEStream({
    response,
    signal: opts.signal,
    onStatus: opts.onStatus,
    onChunk: opts.onChunk,
    onReasoningChunk: opts.onReasoningChunk,
    onReasoningDone: opts.onReasoningDone,
  });
}

export async function selectMessageVariant(
  chatId: ChatId,
  messageId: string,
  variantIndex: number,
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].variants[":variantIndex"].select.$post({
    param: { chatId, messageId, variantIndex: String(variantIndex) },
  });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function deleteMessageVariant(
  chatId: ChatId,
  messageId: string,
  variantIndex: number,
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].variants[":variantIndex"].$delete({
    param: { chatId, messageId, variantIndex: String(variantIndex) },
  });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function editChatMessage(
  chatId: ChatId,
  messageId: string,
  content: string,
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].$patch({
    param: { chatId, messageId },
    json: { content },
  });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function deleteChatMessage(
  chatId: ChatId,
  messageId: string,
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].$delete({ param: { chatId, messageId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function regenerateChatMessage(
  chatId: ChatId,
  messageId: string,
  options?: { signal?: AbortSignal },
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].regenerate.$post(
    {
      param: { chatId, messageId },
    },
    { init: { signal: options?.signal } },
  );
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function forkBranch(chatId: ChatId, fromMessageId?: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].fork.$post({
    param: { chatId },
    json: { fromMessageId },
  });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function activateBranch(
  chatId: ChatId,
  branchId: ChatBranchId,
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].branches[":branchId"].activate.$post({ param: { chatId, branchId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function renameBranch(
  chatId: ChatId,
  branchId: ChatBranchId,
  label: string,
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].branches[":branchId"].$patch({ param: { chatId, branchId }, json: { label } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function deleteBranch(
  chatId: ChatId,
  branchId: ChatBranchId,
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].branches[":branchId"].$delete({ param: { chatId, branchId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function importJson(input: {
  fileName: string;
  jsonText: string;
  chatId?: ChatId;
  skipExisting?: boolean;
}): Promise<ImportJsonResponse> {
  const response = await client.api.import.json.$post({ json: input });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  return {
    ...data,
    snapshot: normalizeSnapshot(data.snapshot),
  };
}

export async function listProviderProfiles(): Promise<ProviderProfileRecord[]> {
  const response = await client.api.providers.$get();
  return unwrapRpc<ProviderProfileRecord[]>(response);
}

export async function fetchProviderProfile(
  providerProfileId: string,
): Promise<ProviderProfileRecord> {
  const response = await client.api.providers[":providerId"].$get({ param: { providerId: providerProfileId } });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function saveProviderProfile(input: {
  id?: string;
  name: string;
  providerPreset: string;
  endpoint: string;
  apiKey?: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
  pinContextBudget?: boolean;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  topA?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
  stopSequences?: string[];
  logitBias?: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed?: string | null;
  reasoningEffort?: string;
  showReasoning?: boolean;
  streamResponse?: boolean;
  customSamplers?: boolean;
}): Promise<ProviderProfileRecord> {
  const response = await client.api.providers.$post({ json: input });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function deleteProviderProfile(providerProfileId: string): Promise<{ ok: true }> {
  const response = await client.api.providers[":providerId"].$delete({ param: { providerId: providerProfileId } });
  return unwrapRpc<{ ok: true }>(response);
}

export async function testProviderDraft(
  input: { endpoint: string; apiKey: string; providerType?: string },
): Promise<ProviderProbeResponse> {
  const response = await client.api.providers.test.$post({ json: input });
  return unwrapRpc<ProviderProbeResponse>(response);
}

export async function testProviderProfile(
  providerProfileId: string,
): Promise<ProviderProbeResponse> {
  const response = await client.api.providers[":providerId"].test.$post({ param: { providerId: providerProfileId } });
  return unwrapRpc<ProviderProbeResponse>(response);
}

export async function fetchProviderProfileModels(
  providerProfileId: string,
): Promise<{ models: ProviderModelOption[] }> {
  const response = await client.api.providers[":providerId"].models.$post({ param: { providerId: providerProfileId } });
  return unwrapRpc<{ models: ProviderModelOption[] }>(response);
}

export async function listFavoriteProviderModels(providerProfileId: string): Promise<FavoriteProviderModelRecord[]> {
  const response = await client.api.providers[":providerId"]["model-favorites"].$get({ param: { providerId: providerProfileId } });
  return unwrapRpc<FavoriteProviderModelRecord[]>(response);
}

export async function addFavoriteProviderModel(
  providerProfileId: string,
  model: { modelId: string; label?: string | null; contextLength?: number | null },
): Promise<FavoriteProviderModelRecord> {
  const response = await client.api.providers[":providerId"]["model-favorites"].$post({ param: { providerId: providerProfileId }, json: model });
  return unwrapRpc<FavoriteProviderModelRecord>(response);
}

export async function removeFavoriteProviderModel(providerProfileId: string, modelId: string): Promise<{ ok: true }> {
  const response = await client.api.providers[":providerId"]["model-favorites"].$delete({ param: { providerId: providerProfileId }, json: { modelId } });
  return unwrapRpc<{ ok: true }>(response);
}

export async function fetchModelsByEndpoint(
  baseUrl: string,
  apiKey?: string,
  providerType?: string,
): Promise<{ models: ProviderModelOption[] }> {
  const response = await client.api.providers["fetch-models"].$post({ json: { baseUrl, apiKey: apiKey ?? "", providerType } });
  return unwrapRpc<{ models: ProviderModelOption[] }>(response);
}

export async function testProviderChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  providerType?: string,
): Promise<TestChatResponse> {
  const response = await client.api.providers["test-chat"].$post({ json: { baseUrl, apiKey, model, providerType } });
  return unwrapRpc<TestChatResponse>(response);
}

export async function testProfileChat(
  providerProfileId: string,
  model: string,
): Promise<TestChatResponse> {
  const response = await client.api.providers[":providerId"]["test-chat"].$post({ param: { providerId: providerProfileId }, json: { model } });
  return unwrapRpc<TestChatResponse>(response);
}

export async function activateProviderProfile(
  providerProfileId: string,
): Promise<ProviderProfileRecord> {
  const response = await client.api.providers[":providerId"].activate.$post({ param: { providerId: providerProfileId } });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function updateProviderProfile(
  providerProfileId: string,
  patch: {
    name?: string;
    providerPreset?: string;
    endpoint?: string;
    apiKey?: string | null;
    defaultModel?: string | null;
    contextBudget?: number | null;
    pinContextBudget?: boolean;
    temperature?: number;
    topP?: number;
    minP?: number;
    topK?: number;
    topA?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    maxTokens?: number;
    stopSequences?: string[];
    logitBias?: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
    seed?: string | null;
    reasoningEffort?: string;
    showReasoning?: boolean;
    streamResponse?: boolean;
    customSamplers?: boolean;
  },
): Promise<ProviderProfileRecord> {
  const response = await client.api.providers[":providerId"].$patch({ param: { providerId: providerProfileId }, json: patch });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function listLoreEntries(lorebookId: string): Promise<LoreEntryRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].entries.$get({ param: { lorebookId } });
  return unwrapRpc<LoreEntryRecord[]>(response);
}

export async function testLoreActivation(
  lorebookId: string,
  text: string,
): Promise<{ activatedIds: string[]; totalEntries: number }> {
  const response = await client.api.lorebooks[":lorebookId"]["test-activation"].$post({ param: { lorebookId }, json: { text } });
  return unwrapRpc<{ activatedIds: string[]; totalEntries: number }>(response);
}

export async function createLoreEntry(lorebookId: string, entry: Partial<LoreEntryRecord>): Promise<LoreEntryRecord> {
  const response = await client.api.lorebooks[":lorebookId"].entries.$post({ param: { lorebookId }, json: entry });
  return unwrapRpc<LoreEntryRecord>(response);
}

export async function updateLoreEntry(lorebookId: string, entryId: string, entry: Partial<LoreEntryRecord>): Promise<LoreEntryRecord> {
  const response = await client.api.lorebooks[":lorebookId"].entries[":entryId"].$patch({ param: { lorebookId, entryId }, json: entry });
  return unwrapRpc<LoreEntryRecord>(response);
}

export async function deleteLoreEntry(lorebookId: string, entryId: string): Promise<void> {
  const response = await client.api.lorebooks[":lorebookId"].entries[":entryId"].$delete({ param: { lorebookId, entryId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function reorderLoreEntries(lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>): Promise<LoreEntryRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].entries.reorder.$patch({ param: { lorebookId }, json: { updates } });
  return unwrapRpc<LoreEntryRecord[]>(response);
}

export async function importLorebookEntries(lorebookId: string, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }): Promise<{ lorebookId?: string; imported: number; skipped: number; warnings: string[] }> {
  const response = await client.api.lorebooks[":lorebookId"].import.$post({ param: { lorebookId }, json: body as { format: "st"; data: unknown; mode: "new" | "merge" | "replace"; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string } });
  return unwrapRpc<{ lorebookId?: string; imported: number; skipped: number; warnings: string[] }>(response);
}

// ── Lorebook-level CRUD ─────────────────────────────────────────────

export async function listAllLorebooks(): Promise<LorebookRecord[]> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/lorebooks/all`));
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<LorebookRecord[]>;
}

export async function listLorebooks(scopeType: string, ownerId?: string): Promise<LorebookRecord[]> {
  const response = await client.api.lorebooks.$get({ query: { scopeType, ownerId } });
  return unwrapRpc<LorebookRecord[]>(response);
}

export async function createLorebook(body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string }): Promise<LorebookRecord> {
  const response = await client.api.lorebooks.$post({ json: body });
  return unwrapRpc<LorebookRecord>(response);
}

export async function updateLorebookMeta(lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }): Promise<LorebookRecord> {
  const response = await client.api.lorebooks[":lorebookId"].$patch({ param: { lorebookId }, json: body });
  return unwrapRpc<LorebookRecord>(response);
}

export async function deleteLorebook(lorebookId: string): Promise<void> {
  const response = await client.api.lorebooks[":lorebookId"].$delete({ param: { lorebookId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function getLorebookLinks(lorebookId: string): Promise<LorebookLinkRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].links.$get({ param: { lorebookId } });
  return unwrapRpc<LorebookLinkRecord[]>(response);
}

export async function setLorebookLinks(lorebookId: string, links: Array<{ targetType: 'character' | 'persona'; targetId: string }>): Promise<LorebookLinkRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].links.$put({ param: { lorebookId }, json: { links } });
  return unwrapRpc<LorebookLinkRecord[]>(response);
}

export async function duplicateLorebook(lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }): Promise<{ lorebook: LorebookRecord; links: LorebookLinkRecord[] }> {
  const response = await client.api.lorebooks[":lorebookId"].duplicate.$post({ param: { lorebookId }, json: overrides ?? {} });
  return unwrapRpc<{ lorebook: LorebookRecord; links: LorebookLinkRecord[] }>(response);
}

export async function exportLorebookSt(lorebookId: string): Promise<Record<string, unknown>> {
  const response = await client.api.lorebooks[":lorebookId"].export.$get({ param: { lorebookId } });
  return unwrapRpc<Record<string, unknown>>(response);
}

// ── Scripts ──────────────────────────────────────────────────────────

export interface ScriptRecord {
  id: string;
  name: string;
  description: string;
  code: string;
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  enabled: boolean;
  sortOrder: number;
}

export async function listScripts(scopeType: string, ownerId?: string): Promise<ScriptRecord[]> {
  const response = await client.api.scripts.$get({ query: { scopeType, ownerId } });
  return unwrapRpc<ScriptRecord[]>(response);
}

export async function getScript(scriptId: string): Promise<ScriptRecord> {
  const response = await client.api.scripts[":scriptId"].$get({ param: { scriptId } });
  return unwrapRpc<ScriptRecord>(response);
}

export async function createScript(body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }): Promise<ScriptRecord> {
  const response = await client.api.scripts.$post({ json: body });
  return unwrapRpc<ScriptRecord>(response);
}

export async function updateScript(scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }): Promise<ScriptRecord> {
  const response = await client.api.scripts[":scriptId"].$patch({ param: { scriptId }, json: body });
  return unwrapRpc<ScriptRecord>(response);
}

export async function deleteScript(scriptId: string): Promise<void> {
  const response = await client.api.scripts[":scriptId"].$delete({ param: { scriptId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function testScript(scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }): Promise<{ personality: string; scenario: string; state: Record<string, unknown>; errors: string[] }> {
  const response = await client.api.scripts[":scriptId"].test.$post({ param: { scriptId }, json: body });
  return unwrapRpc<{ personality: string; scenario: string; state: Record<string, unknown>; errors: string[] }>(response);
}

export async function importScript(body: { format: "js"; code: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string } | { format: "json"; jsonText: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }): Promise<ScriptRecord> {
  const response = await client.api.scripts.import.$post({ json: body });
  return unwrapRpc<ScriptRecord>(response);
}

// ── AI Assistant SSE ──────────────────────────────────────────────────

export interface AiAssistantChunk {
  type: "text" | "reasoning" | "partial_json" | "error" | "done";
  text?: string;
  json?: Record<string, unknown>;
  error?: string;
}

export type AiAssistantMode = "script" | "lore_entry" | "lore_keys" | "chat_impersonate" | "md_import";

export interface AiAssistantRequestBody {
  mode: AiAssistantMode;
  instruction: string;
  existingContent?: string;
  providerProfileId: string;
  model?: string;
  enabledLayers: string[];
  characterIds?: string[];
  personaIds?: string[];
  loreEntryIds?: string[];
  lorebookIds?: string[];
  chatId?: string;
  recentMessageCount?: number;
  existingKeys?: string[];
  existingSecondaryKeys?: string[];
  logic?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export async function countAiAssistantTokens(body: AiAssistantRequestBody, options?: { signal?: AbortSignal }): Promise<{ tokens: number; model: string; layerCount: number; messageCount: number }> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/ai-assistant/tokens`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<{ tokens: number; model: string; layerCount: number; messageCount: number }>;
}

export async function* streamAiAssistant(body: AiAssistantRequestBody, options?: { signal?: AbortSignal }): AsyncGenerator<AiAssistantChunk> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/ai-assistant`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    yield { type: "error", error: `HTTP ${response.status}: ${response.statusText}` };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const chunk: AiAssistantChunk = JSON.parse(line.slice(6));
          yield chunk;
          if (chunk.type === "done" || chunk.type === "error") return;
        } catch {
          // Skip malformed lines
        }
      }
    }
  }
}

export async function archiveCharacter(characterId: string): Promise<{ characterId: string; status: "archived" }> {
  const response = await client.api.characters[":characterId"].archive.$patch({ param: { characterId } });
  return unwrapRpc<{ characterId: string; status: "archived" }>(response);
}

export async function unarchiveCharacter(characterId: string): Promise<{ characterId: string; status: "active" }> {
  const response = await client.api.characters[":characterId"].unarchive.$patch({ param: { characterId } });
  return unwrapRpc<{ characterId: string; status: "active" }>(response);
}

export async function deleteCharacter(characterId: string): Promise<void> {
  const response = await client.api.characters[":characterId"].$delete({ param: { characterId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function deleteChat(chatId: ChatId): Promise<void> {
  const response = await client.api.chats[":chatId"].$delete({ param: { chatId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function clearChat(chatId: ChatId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].clear.$post({ param: { chatId } });
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function renameChat(chatId: ChatId, title: string): Promise<{ chatId: string; title: string }> {
  const response = await client.api.chats[":chatId"].title.$patch({ param: { chatId }, json: { title } });
  return unwrapRpc<{ chatId: string; title: string }>(response);
}

export async function setGreetingIndex(chatId: ChatId, greetingIndex: number): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["greeting-index"].$patch({ param: { chatId }, json: { greetingIndex } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function createChat(characterId?: string): Promise<AppSnapshot> {
  const response = await client.api.chats.$post({ json: { characterId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function createCharacter(input: {
  name: string;
  description?: string;
  firstMessage?: string;
  scenario?: string;
  personalitySummary?: string;
  mesExample?: string;
  alternateGreetings?: string[];
  postHistoryInstructions?: string;
  creatorNotes?: string;
  systemPrompt?: string;
  depthPrompt?: string;
  depthPromptDepth?: number;
  depthPromptRole?: string;
  tags?: string[];
}): Promise<ImportJsonResponse> {
  const response = await client.api.characters.$post({ json: input });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  return {
    ...data,
    snapshot: normalizeSnapshot(data.snapshot),
  };
}

export async function exportCharacter(characterId: string): Promise<Record<string, unknown>> {
  const response = await client.api.characters[":characterId"].export.$get({ param: { characterId } });
  return unwrapRpc<Record<string, unknown>>(response);
}

export async function exportChatJsonl(chatId: ChatId): Promise<string> {
  const response = await client.api.chats[":chatId"]["export.jsonl"].$get({ param: { chatId } });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.text();
}

export async function exportPromptTrace(traceId: string): Promise<Record<string, unknown>> {
  const response = await client.api["prompt-traces"][":traceId"].export.$get({ param: { traceId } });
  return unwrapRpc<Record<string, unknown>>(response);
}

export async function updateCharacterAvatar(characterId: string, chatId: string, avatarAssetId: string, avatarFullAssetId?: string, avatarCropJson?: string | null): Promise<AppSnapshot> {
  const payload: Record<string, unknown> = { chatId, avatarAssetId };
  if (avatarFullAssetId !== undefined) payload.avatarFullAssetId = avatarFullAssetId;
  if (avatarCropJson !== undefined) payload.avatarCropJson = avatarCropJson;
  const response = await client.api.characters[":characterId"].$patch({ param: { characterId }, json: payload });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export function logClientSendDebug(event: string, data: Record<string, unknown> = {}): void {
  postSendDebug(event, data);
}

export async function uploadAsset(file: File): Promise<{ assetId: string; url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(`${baseUrl}/api/assets/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Asset upload failed (${response.status}): ${errorBody}`);
  }
  return response.json();
}

function postSendDebug(event: string, data: Record<string, unknown>): void {
  const token = getMobileToken();
  void fetch(`${getGatewayBaseUrl()}/api/debug/send-log`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ event, ...data, clientTs: new Date().toISOString() }),
  }).catch(() => undefined);
}

function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return {
    ...snapshot,
    character: {
      ...snapshot.character,
      firstMessage: snapshot.character.firstMessage ?? null,
      alternateGreetings: Array.isArray(snapshot.character.alternateGreetings)
        ? snapshot.character.alternateGreetings
        : [],
      postHistoryInstructions: snapshot.character.postHistoryInstructions ?? null,
      creatorNotes: snapshot.character.creatorNotes ?? null,
      depthPrompt: snapshot.character.depthPrompt ?? null,
      depthPromptDepth: snapshot.character.depthPromptDepth ?? null,
      depthPromptRole: snapshot.character.depthPromptRole ?? null,
      tags: Array.isArray(snapshot.character.tags) ? snapshot.character.tags : [],
    },
    chats: Array.isArray(snapshot.chats) ? snapshot.chats : [],
    branches: Array.isArray(snapshot.branches) ? snapshot.branches : [],
    messages: Array.isArray(snapshot.messages)
      ? snapshot.messages.map(normalizeMessage)
      : [],
    summaries: Array.isArray(snapshot.summaries) ? snapshot.summaries : [],
    promptTraceHistory: Array.isArray(snapshot.promptTraceHistory)
      ? snapshot.promptTraceHistory
      : [],
  };
}

function normalizeMessage(message: AppMessage): AppMessage {
  const variants = Array.isArray(message.variants) ? message.variants : [];
  const selectedVariantIndex =
    typeof message.selectedVariantIndex === "number" ? message.selectedVariantIndex : null;

  return {
    ...message,
    variants,
    selectedVariantIndex,
  };
}
