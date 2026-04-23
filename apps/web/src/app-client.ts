import type { PromptTraceRecordDto } from "@rp-platform/api-contracts";
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
  hasStoredApiKey: boolean;
}

export interface ProviderConnectionResult {
  success: boolean;
  models: Array<{
    id: string;
    name?: string;
    context_length?: number;
    owned_by?: string;
  }>;
  error?: string;
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
    providerProfileId: string;
    model: string;
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
  input: {
    providerProfileId: string;
    model: string;
  },
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/messages/${messageId}/regenerate`, {
    method: "POST",
    body: input,
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

export async function connectProviderProfile(
  providerProfileId: string,
): Promise<ProviderConnectionResult> {
  return requestJson(`/api/providers/${providerProfileId}/connect`, {
    method: "POST",
  });
}

export async function fetchProviderProfileModels(
  providerProfileId: string,
): Promise<{ models: Array<{ id: string; label: string }> }> {
  return requestJson(`/api/providers/${providerProfileId}/models`, {
    method: "POST",
  });
}

async function requestJson<T>(
  path: string,
  options?: {
    method?: "DELETE" | "GET" | "PATCH" | "POST";
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
