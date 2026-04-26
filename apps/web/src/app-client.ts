import type { PromptPresetDto, PromptTraceRecordDto, ProviderProbeResponse } from "@rp-platform/api-contracts";
import type { Chat, ChatBranch, ChatBranchId, ChatId, Message, MessageVariant } from "@rp-platform/domain";
import { getGatewayBaseUrl } from "./gateway-client.js";

export interface ChatListItem {
  id: ChatId;
  title: string;
  characterName: string;
  subtitle: string;
  activeBranchLabel: string;
  messageCount: number;
}

export interface PersonaRecord {
  id: string;
  name: string;
  description: string;
}

export interface AppSnapshot {
  chats: ChatListItem[];
  activeChat: Chat;
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
  character: {
    id: string;
    name: string;
    description: string;
    scenario: string;
    systemPrompt: string;
    subtitle: string;
    mesExample: string | null;
    alternateGreetings: string[];
    postHistoryInstructions: string | null;
    creatorNotes: string | null;
  };
  persona: {
    id: string;
    name: string;
    description: string;
  } | null;
}

export interface AppMessage extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
}

export interface ImportJsonResponse {
  activeChatId: ChatId;
  snapshot: AppSnapshot;
  imported: {
    kind: "character" | "lorebook";
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
  type: string;
  endpoint: string;
  defaultModel?: string | null;
  contextBudget?: number | null;
  isActive: boolean;
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
}

export async function bootstrapApp(): Promise<{
  initialChatId: ChatId | null;
  snapshot: AppSnapshot | null;
}> {
  const response = await requestJson<{
    initialChatId: ChatId | null;
    snapshot: AppSnapshot | null;
  }>("/api/bootstrap");

  return {
    initialChatId: response.initialChatId,
    snapshot: response.snapshot ? normalizeSnapshot(response.snapshot) : null,
  };
}

export async function fetchChat(chatId: ChatId): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}`));
}

export async function updateCharacter(
  characterId: string,
  input: {
    chatId?: ChatId;
    name: string;
    description: string;
    scenario: string;
    systemPrompt: string;
    mesExample: string | null;
    alternateGreetings: string[];
    postHistoryInstructions: string | null;
    creatorNotes: string | null;
  },
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/characters/${characterId}`, {
    method: "PATCH",
    body: input,
  }));
}

export async function updatePersona(
  personaId: string,
  input: {
    chatId?: ChatId;
    name: string;
    description: string;
  },
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/personas/${personaId}`, {
    method: "PATCH",
    body: input,
  }));
}

export async function listPersonas(): Promise<PersonaRecord[]> {
  return requestJson("/api/personas");
}

export async function createPersona(input: {
  name: string;
  description: string;
  pronouns?: string | null;
  defaultForNewChats?: boolean;
}): Promise<PersonaRecord> {
  return requestJson("/api/personas", { method: "POST", body: input });
}

export async function deletePersona(personaId: string): Promise<void> {
  await requestJson(`/api/personas/${personaId}`, { method: "DELETE" });
}

export async function listPromptPresets(): Promise<PromptPresetDto[]> {
  return requestJson("/api/prompt-presets");
}

export async function createPromptPreset(input: {
  name: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  summary?: string;
  tools?: string;
}): Promise<PromptPresetDto> {
  return requestJson("/api/prompt-presets", { method: "POST", body: input });
}

export async function updatePromptPreset(
  presetId: string,
  patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>,
): Promise<PromptPresetDto> {
  return requestJson(`/api/prompt-presets/${presetId}`, { method: "PATCH", body: patch });
}

export async function deletePromptPreset(presetId: string): Promise<void> {
  await requestJson(`/api/prompt-presets/${presetId}`, { method: "DELETE" });
}

export async function getPersonalLorebookStatus(personaId: string): Promise<{ enabled: boolean; lorebookId: string | null }> {
  return requestJson(`/api/personas/${personaId}/personal-lorebook`);
}

export async function setPersonalLorebookEnabled(personaId: string, enabled: boolean): Promise<{ enabled: boolean; lorebookId: string | null }> {
  return requestJson(`/api/personas/${personaId}/personal-lorebook`, {
    method: "PUT",
    body: { enabled },
  });
}

export async function setChatPersona(chatId: import("@rp-platform/domain").ChatId, personaId: string): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/set-persona`, {
    method: "POST",
    body: { personaId }
  }));
}

export async function sendChatMessage(
  chatId: ChatId,
  input: {
    content: string;
  },
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/messages`, {
    method: "POST",
    body: input,
  }));
}

export async function selectMessageVariant(
  chatId: ChatId,
  messageId: string,
  variantIndex: number,
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/messages/${messageId}/variants/${variantIndex}/select`, {
    method: "POST",
  }));
}

export async function editChatMessage(
  chatId: ChatId,
  messageId: string,
  content: string,
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/messages/${messageId}`, {
    method: "PATCH",
    body: {
      content,
    },
  }));
}

export async function deleteChatMessage(
  chatId: ChatId,
  messageId: string,
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/messages/${messageId}`, {
    method: "DELETE",
  }));
}

export async function regenerateChatMessage(
  chatId: ChatId,
  messageId: string,
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/messages/${messageId}/regenerate`, {
    method: "POST",
    body: {},
  }));
}

export async function forkBranch(chatId: ChatId): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/fork`, {
    method: "POST",
  }));
}

export async function activateBranch(
  chatId: ChatId,
  branchId: ChatBranchId,
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/branches/${branchId}/activate`, {
    method: "POST",
  }));
}

export async function importJson(input: {
  fileName: string;
  jsonText: string;
  chatId?: ChatId;
}): Promise<ImportJsonResponse> {
  const response = await requestJson<ImportJsonResponse>("/api/import/json", {
    method: "POST",
    body: input,
  });

  return {
    ...response,
    snapshot: normalizeSnapshot(response.snapshot),
  };
}

export async function listProviderProfiles(): Promise<ProviderProfileRecord[]> {
  return requestJson("/api/providers");
}

export async function fetchProviderProfile(
  providerProfileId: string,
): Promise<ProviderProfileRecord> {
  return requestJson(`/api/providers/${providerProfileId}`);
}

export async function saveProviderProfile(input: {
  id?: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey?: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
}): Promise<ProviderProfileRecord> {
  return requestJson("/api/providers", {
    method: "POST",
    body: input,
  });
}

export async function deleteProviderProfile(providerProfileId: string): Promise<{ ok: true }> {
  return requestJson(`/api/providers/${providerProfileId}`, {
    method: "DELETE",
  });
}

export async function testProviderDraft(
  input: { endpoint: string; apiKey: string },
): Promise<ProviderProbeResponse> {
  return requestJson<ProviderProbeResponse>("/api/providers/test", {
    method: "POST",
    body: input,
  });
}

export async function testProviderProfile(
  providerProfileId: string,
): Promise<ProviderProbeResponse> {
  return requestJson<ProviderProbeResponse>(`/api/providers/${providerProfileId}/test`, {
    method: "POST",
    body: {},
  });
}

export async function fetchProviderProfileModels(
  providerProfileId: string,
): Promise<{ models: Array<{ id: string; label: string }> }> {
  return requestJson(`/api/providers/${providerProfileId}/models`, {
    method: "POST",
  });
}

export async function activateProviderProfile(
  providerProfileId: string,
): Promise<ProviderProfileRecord> {
  return requestJson(`/api/providers/${providerProfileId}/activate`, {
    method: "POST",
  });
}

export async function updateProviderProfile(
  providerProfileId: string,
  patch: {
    name?: string;
    type?: string;
    endpoint?: string;
    apiKey?: string | null;
    defaultModel?: string | null;
    contextBudget?: number | null;
  },
): Promise<ProviderProfileRecord> {
  return requestJson(`/api/providers/${providerProfileId}`, {
    method: "PATCH",
    body: patch,
  });
}

export async function listLoreEntries(lorebookId: string): Promise<LoreEntryRecord[]> {
  return requestJson(`/api/lorebooks/${lorebookId}/entries`);
}

export async function testLoreActivation(
  lorebookId: string,
  text: string,
): Promise<{ activatedIds: string[]; totalEntries: number }> {
  return requestJson(`/api/lorebooks/${lorebookId}/test-activation`, {
    method: "POST",
    body: { text },
  });
}

export async function createLoreEntry(lorebookId: string, entry: Partial<LoreEntryRecord>): Promise<LoreEntryRecord> {
  return requestJson(`/api/lorebooks/${lorebookId}/entries`, { method: "POST", body: entry });
}

export async function updateLoreEntry(lorebookId: string, entryId: string, entry: Partial<LoreEntryRecord>): Promise<LoreEntryRecord> {
  return requestJson(`/api/lorebooks/${lorebookId}/entries/${entryId}`, { method: "PATCH", body: entry });
}

export async function deleteLoreEntry(lorebookId: string, entryId: string): Promise<void> {
  await requestJson(`/api/lorebooks/${lorebookId}/entries/${entryId}`, { method: "DELETE" });
}

export async function archiveCharacter(characterId: string): Promise<{ characterId: string; status: "archived" }> {
  return requestJson(`/api/characters/${characterId}/archive`, { method: "PATCH" });
}

export async function unarchiveCharacter(characterId: string): Promise<{ characterId: string; status: "active" }> {
  return requestJson(`/api/characters/${characterId}/unarchive`, { method: "PATCH" });
}

export async function deleteCharacter(characterId: string): Promise<void> {
  await requestJson(`/api/characters/${characterId}`, { method: "DELETE" });
}

export async function deleteChat(chatId: ChatId): Promise<void> {
  await requestJson(`/api/chats/${chatId}`, { method: "DELETE" });
}

export async function renameChat(chatId: ChatId, title: string): Promise<{ chatId: string; title: string }> {
  return requestJson(`/api/chats/${chatId}/title`, { method: "PATCH", body: { title } });
}

export async function createChat(characterId: string): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson("/api/chats", {
    method: "POST",
    body: { characterId },
  }));
}

export async function cloneChat(chatId: ChatId): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/clone`, {
    method: "POST",
  }));
}

export async function exportCharacter(characterId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/characters/${characterId}/export`);
}

export async function exportChatJsonl(chatId: ChatId): Promise<string> {
  return requestText(`/api/chats/${chatId}/export.jsonl`);
}

export async function exportPromptTrace(traceId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/prompt-traces/${traceId}/export`);
}

async function requestText(path: string): Promise<string> {
  const response = await fetch(`${getGatewayBaseUrl()}${path}`, {
    method: "GET",
  });

  const text = await response.text();

  if (!response.ok) {
    let errorMsg = `Request failed: ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) errorMsg = parsed.error;
    } catch { /* use default */ }
    throw new Error(errorMsg);
  }

  return text;
}

async function requestJson<T>(
  path: string,
  options?: {
    method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    body?: unknown;
  },
): Promise<T> {
  const response = await fetch(`${getGatewayBaseUrl()}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as { error?: string }) : {};

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data as T;
}

function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return {
    ...snapshot,
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
