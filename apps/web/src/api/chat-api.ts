import type { ChatId, ChatMode, PromptTraceRecordDto } from "@vibe-tavern/domain";
import type { CoauthorApplyRequest, CoauthorCorrection, CoauthorModule, CoauthorModuleCreate, CoauthorModuleUpdate } from "@vibe-tavern/api-contracts";
import type { AppSnapshot, AppMessage, ChatListItem, ChatSummaryRecord, AutoSummaryConfig, InsightsConfig } from "./types.js";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { normalizeSnapshot } from "./normalize.js";
import { sendStream, regenerateStream, generateReplyStream, type StreamOpts } from "./stream.js";
import { getGatewayBaseUrl, getMobileToken } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

export async function fetchChat(chatId: ChatId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].$get({ param: { chatId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function createChat(characterId: string, mode?: ChatMode): Promise<AppSnapshot> {
  const response = await client.api.chats.$post({ json: { characterId, mode } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

/** List a character's co-author chats (Co-Author mode entry screen). */
export async function listCoauthorChats(characterId: string): Promise<ChatListItem[]> {
  const response = await client.api.characters[":characterId"]["coauthor-chats"].$get({ param: { characterId } });
  return await unwrapRpc<ChatListItem[]>(response);
}

/**
 * Apply a co-author turn's aggregated proposed state to the underlying card
 * (CA-7). Returns the merged snapshot plus any `corrections` the backend
 * applied (e.g. an empty name restored from the card) — surfaced as a toast,
 * not silently masked (plan R3).
 */
export async function applyCoauthorDraft(
  chatId: ChatId,
  body: CoauthorApplyRequest,
): Promise<{ snapshot: AppSnapshot; corrections: CoauthorCorrection[] }> {
  const response = await client.api.chats[":chatId"].coauthor.apply.$post({ param: { chatId }, json: body });
  const data = await unwrapRpc<AppSnapshot & { corrections?: CoauthorCorrection[] }>(response);
  const corrections = data.corrections ?? [];
  return { snapshot: normalizeSnapshot(data), corrections };
}

export async function deleteChat(chatId: ChatId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].$delete({ param: { chatId } });
  // The backend returns the refreshed chats list (ChatListResponse) so the
  // sidebar can drop the deleted chat deterministically instead of relying on
  // a racy fire-and-forget bootstrap (ghost-chat fix).
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function clearChat(chatId: ChatId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].clear.$post({ param: { chatId } });
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function renameChat(chatId: ChatId, title: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].title.$patch({ param: { chatId }, json: { title } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function setGreetingIndex(chatId: ChatId, greetingIndex: number): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["greeting-index"].$patch({ param: { chatId }, json: { greetingIndex } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function setCoauthorLorebooks(chatId: ChatId, lorebookIds: string[]): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["coauthor-lorebooks"].$patch({ param: { chatId }, json: { lorebookIds } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function listCoauthorModules(): Promise<CoauthorModule[]> {
  const response = await client.api.coauthor.modules.$get();
  const data = await unwrapRpc<{ modules: CoauthorModule[] }>(response);
  return data.modules;
}

export async function createCoauthorModule(input: CoauthorModuleCreate): Promise<CoauthorModule> {
  const response = await client.api.coauthor.modules.$post({ json: input });
  return unwrapRpc<CoauthorModule>(response);
}

export async function updateCoauthorModule(moduleId: string, input: CoauthorModuleUpdate): Promise<CoauthorModule> {
  const response = await client.api.coauthor.modules[":moduleId"].$patch({ param: { moduleId }, json: input });
  return unwrapRpc<CoauthorModule>(response);
}

export async function deleteCoauthorModule(moduleId: string): Promise<void> {
  const response = await client.api.coauthor.modules[":moduleId"].$delete({ param: { moduleId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function setCoauthorModule(chatId: ChatId, moduleId: string | null): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["coauthor-module"].$patch({ param: { chatId }, json: { moduleId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function setChatPersona(chatId: ChatId, personaId: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["set-persona"].$post({ param: { chatId }, json: { personaId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function setChatPromptPreset(chatId: ChatId, promptPresetId: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["set-prompt-preset"].$post({ param: { chatId }, json: { promptPresetId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

// ─── Messages (non-stream) ──────────────────────────────────────────────

export async function sendChatMessage(
  chatId: ChatId,
  input: { content: string; attachments?: { id: string; name: string; type: "image" | "file" | "video"; assetId: string; mimeType: string; sizeBytes: number }[] },
  options?: { signal?: AbortSignal },
): Promise<AppSnapshot> {
  logClientSendDebug("web.client.sendChatMessage.start", { chatId, contentLength: input.content.length });
  const response = await client.api.chats[":chatId"].messages.$post(
    { param: { chatId }, json: input },
    { init: { signal: options?.signal } },
  );
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function regenerateChatMessage(
  chatId: ChatId,
  messageId: string,
  options?: { signal?: AbortSignal; override?: { model?: string; promptPresetId?: string } },
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].regenerate.$post(
    { param: { chatId, messageId }, ...(options?.override ? { json: options.override } : {}) },
    { init: { signal: options?.signal } },
  );
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
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

export async function editChatMessage(chatId: ChatId, messageId: string, content: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].$patch({
    param: { chatId, messageId },
    json: { content },
  });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function deleteChatMessage(chatId: ChatId, messageId: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].$delete({ param: { chatId, messageId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function selectMessageVariant(chatId: ChatId, messageId: string, variantIndex: number): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].variants[":variantIndex"].select.$post({
    param: { chatId, messageId, variantIndex: String(variantIndex) },
  });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function deleteMessageVariant(chatId: ChatId, messageId: string, variantIndex: number): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].messages[":messageId"].variants[":variantIndex"].$delete({
    param: { chatId, messageId, variantIndex: String(variantIndex) },
  });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function updateAttachmentDescription(
  chatId: string,
  messageId: string,
  attachmentId: string,
  description: string,
): Promise<{ ok: boolean }> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/chats/${chatId}/messages/${messageId}/attachments/${attachmentId}/description`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    },
  );
  if (!response.ok) throw new Error(`Failed to update description: ${response.status}`);
  return response.json();
}

export async function deleteAttachment(
  chatId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ ok: boolean }> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/chats/${chatId}/messages/${messageId}/attachments/${attachmentId}`),
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`Failed to delete attachment: ${response.status}`);
  return response.json();
}

export async function regenerateAttachmentDescription(
  chatId: string,
  messageId: string,
  attachmentId: string,
  options?: { signal?: AbortSignal },
): Promise<{ description: string }> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/chats/${chatId}/messages/${messageId}/attachments/${attachmentId}/regenerate-description`),
    { method: "POST", signal: options?.signal },
  );
  if (!response.ok) throw new Error(`Failed to regenerate description: ${response.status}`);
  return response.json();
}

// ─── Streams ────────────────────────────────────────────────────────────

export { sendStream as sendChatMessageStream, regenerateStream as regenerateChatMessageStream, generateReplyStream as generateReplyStream };
export type { StreamOpts };

// ─── Branches ───────────────────────────────────────────────────────────

export async function forkBranch(chatId: ChatId, fromMessageId?: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].fork.$post({ param: { chatId }, json: { fromMessageId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function activateBranch(chatId: ChatId, branchId: import("@vibe-tavern/domain").ChatBranchId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].branches[":branchId"].activate.$post({ param: { chatId, branchId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function renameBranch(chatId: ChatId, branchId: import("@vibe-tavern/domain").ChatBranchId, label: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].branches[":branchId"].$patch({ param: { chatId, branchId }, json: { label } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function deleteBranch(chatId: ChatId, branchId: import("@vibe-tavern/domain").ChatBranchId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].branches[":branchId"].$delete({ param: { chatId, branchId } });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

// ─── Summaries & Memory ─────────────────────────────────────────────────

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

export async function saveChatSummary(chatId: ChatId, summary: string): Promise<{ summary: string; snapshot: AppSnapshot }> {
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

export async function updateInsightsConfig(
  chatId: ChatId,
  input: { insightsConfig?: Partial<InsightsConfig> },
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"]["insights-config"].$patch({ param: { chatId }, json: input });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

// ─── Insights — Objective Tracker (INS-5) ────────────────────────────────
// Manual actions return via RPC (no SSE); each round-trips the snapshot so the
// store refreshes. Provider/model omitted → the backend resolves the active
// provider profile + its default model.

export async function generateObjectiveTasks(
  chatId: ChatId,
  input: { providerProfileId?: string; model?: string },
  options?: { signal?: AbortSignal },
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights.objective.generate.$post(
    { param: { chatId }, json: input },
    { init: { signal: options?.signal } },
  );
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function checkObjectiveCompletion(
  chatId: ChatId,
  input: { providerProfileId?: string; model?: string },
  options?: { signal?: AbortSignal },
): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights.objective.check.$post(
    { param: { chatId }, json: input },
    { init: { signal: options?.signal } },
  );
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function addObjectiveTask(chatId: ChatId, description: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights.objective.tasks.$post({ param: { chatId }, json: { description } });
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function updateObjectiveTask(chatId: ChatId, taskId: string, input: { description?: string; status?: string }): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights.objective.tasks[":taskId"].$patch({ param: { chatId, taskId }, json: input });
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function deleteObjectiveTask(chatId: ChatId, taskId: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights.objective.tasks[":taskId"].$delete({ param: { chatId, taskId } });
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function setObjectiveDescription(chatId: ChatId, objectiveDescription: string): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights.objective.description.$put({ param: { chatId }, json: { objectiveDescription } });
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

export async function updateObjectiveConfig(chatId: ChatId, input: {
  autoCheckFrequency?: number;
  injectionDepth?: number;
  generatePrompt?: string;
  checkPrompt?: string;
  injectPrompt?: string;
  useChatModel?: boolean;
  providerProfileId?: string | null;
  model?: string | null;
}): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights.objective.config.$put({ param: { chatId }, json: input });
  return normalizeSnapshot(await unwrapRpc<AppSnapshot>(response));
}

// ─── Export ─────────────────────────────────────────────────────────────

export async function exportChatJsonl(chatId: ChatId): Promise<string> {
  const response = await client.api.chats[":chatId"]["export.jsonl"].$get({ param: { chatId } });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.text();
}

export async function exportPromptTrace(traceId: string): Promise<Record<string, unknown>> {
  const response = await client.api["prompt-traces"][":traceId"].export.$get({ param: { traceId } });
  return unwrapRpc<Record<string, unknown>>(response);
}

/**
 * Lazy-load the prompt-trace history for a chat, optionally scoped server-side
 * to a branch and/or message. Replaces the old promptTraceHistory snapshot
 * field (removed in TL-A2): the full history only crosses the wire when the
 * Trace tab is opened, not on every snapshot.
 */
export async function fetchTraceHistory(
  chatId: ChatId,
  opts?: { messageId?: string; branchId?: string },
): Promise<PromptTraceRecordDto[]> {
  const response = await client.api.chats[":chatId"].traces.$get({
    param: { chatId },
    query: { messageId: opts?.messageId, branchId: opts?.branchId },
  });
  return unwrapRpc<PromptTraceRecordDto[]>(response);
}

// ─── Debug ──────────────────────────────────────────────────────────────

function logClientSendDebug(event: string, data: Record<string, unknown> = {}): void {
  postSendDebug(event, data);
}

export { logClientSendDebug };

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
