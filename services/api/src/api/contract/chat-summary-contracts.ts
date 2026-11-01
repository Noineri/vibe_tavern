/** Summary contracts extracted from runtime-api.ts for the BR-1d size ratchet.
 * ChatRuntimeApi extends this slice; existing callers keep the same import path. */
import type { ChatSummary } from "@vibe-tavern/db";
import type { ManualSummaryRunState, ManualSummaryStopResponse } from "@vibe-tavern/api-contracts";
import type { GenerateChatSummaryResult, SummarizeChatResult } from "../../domain/chat/chat-summary-service.js";
import type { SummaryResponse } from "./session-types.js";

export interface ChatSummaryRuntimeApi {
  listChatSummaries: (chatId: string) => Promise<ChatSummary[]>;
  createChatSummary: (chatId: string, body: { label?: string; content?: string; summarizedFrom: number; summarizedTo: number; includeInContext?: boolean; excludeSummarized?: boolean; source?: "manual" | "auto"; sortOrder?: number }) => Promise<{ summary: ChatSummary; snapshot: SummaryResponse }>;
  updateChatSummaryRecord: (chatId: string, summaryId: string, body: { label?: string; content?: string; summarizedFrom?: number; summarizedTo?: number; includeInContext?: boolean; excludeSummarized?: boolean; sortOrder?: number }) => Promise<{ summary: ChatSummary; snapshot: SummaryResponse }>;
  deleteChatSummaryRecord: (chatId: string, summaryId: string) => Promise<{ ok: boolean; snapshot: SummaryResponse }>;
  reorderChatSummaries: (chatId: string, body: { orderedIds: string[] }) => Promise<ChatSummary[]>;
  /** Server-owned manual run; request disconnection is not cancellation. */
  generateChatSummary: (chatId: string, body: { providerProfileId: string; model?: string; summarizedFrom: number; summarizedTo: number; targetSummaryId?: string; label?: string; includeInContext?: boolean; excludeSummarized?: boolean; includePriorSummaries?: boolean; temperature?: number; maxOutputTokens?: number; contextBudget?: number }) => Promise<GenerateChatSummaryResult>;
  getManualSummaryRun: (chatId: string) => ManualSummaryRunState;
  stopManualSummary: (chatId: string) => ManualSummaryStopResponse;
  summarizeChat: (chatId: string, body: { providerProfileId: string; model?: string; maxMessages: number }, signal?: AbortSignal) => Promise<SummarizeChatResult>;
  saveChatSummary: (chatId: string, body: { summary: string }) => Promise<SummarizeChatResult>;
}
