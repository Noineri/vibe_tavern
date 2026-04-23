import type { AssemblePromptResponse, PromptTraceRecordDto } from "@rp-platform/api-contracts";
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

export interface PreparedTurn {
  prompt: AssemblePromptResponse;
  snapshot: AppSnapshot;
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
  },
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/characters/${characterId}`, {
    method: "PATCH",
    body: input,
  }));
}

export async function prepareLiveTurn(
  chatId: ChatId,
  content: string,
): Promise<PreparedTurn> {
  const response = await requestJson<PreparedTurn>(`/api/chats/${chatId}/prepare-live-turn`, {
    method: "POST",
    body: {
      content,
    },
  });

  return {
    ...response,
    snapshot: normalizeSnapshot(response.snapshot),
  };
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

export async function appendAssistantReply(
  chatId: ChatId,
  content: string,
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/assistant`, {
    method: "POST",
    body: {
      content,
    },
  }));
}

export async function assembleCurrentPrompt(
  chatId: ChatId,
  options?: {
    excludeMessageId?: string;
  },
): Promise<AssemblePromptResponse> {
  return requestJson(`/api/chats/${chatId}/assemble-prompt`, {
    method: "POST",
    body: options,
  });
}

export async function appendMessageVariant(
  chatId: ChatId,
  messageId: string,
  input: {
    content: string;
    finishReason?: string | null;
  },
): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/messages/${messageId}/variants`, {
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

export async function forkBranch(chatId: ChatId): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/fork`, {
    method: "POST",
  }));
}

export async function sleepBranch(chatId: ChatId): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/sleep`, {
    method: "POST",
  }));
}

export async function refreshPrompt(chatId: ChatId): Promise<AppSnapshot> {
  return normalizeSnapshot(await requestJson(`/api/chats/${chatId}/refresh-prompt`, {
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

export async function generateProviderProfileReply(
  providerProfileId: string,
  input: {
    model: string;
    prompt: AssemblePromptResponse;
  },
): Promise<string> {
  const response = await requestJson<{ content?: string }>(`/api/providers/${providerProfileId}/generate`, {
    method: "POST",
    body: input,
  });

  if (!response.content?.trim()) {
    throw new Error("Saved profile generation returned empty content.");
  }

  return response.content;
}

export async function fetchPromptTraceHistory(
  chatId: ChatId,
  options?: {
    branchId?: ChatBranchId;
    limit?: number;
  },
): Promise<PromptTraceRecordDto[]> {
  const params = new URLSearchParams();
  if (options?.branchId) {
    params.set("branchId", options.branchId);
  }
  if (typeof options?.limit === "number") {
    params.set("limit", String(options.limit));
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson(`/api/chats/${chatId}/prompt-traces${suffix}`);
}

export async function fetchLatestPromptTrace(
  chatId: ChatId,
  branchId?: ChatBranchId,
): Promise<PromptTraceRecordDto | null> {
  const suffix = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
  return requestJson(`/api/chats/${chatId}/prompt-traces/latest${suffix}`);
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
