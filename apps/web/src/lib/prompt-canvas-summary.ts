import { listChatSummaries } from "../api/chat-api.js";
import type { ChatSummaryRecord } from "../api/types.js";

/**
 * A summary memory block the prompt pipeline will inject at the `chatSummary`
 * canvas anchor. Mirrors the pipeline's injection decision
 * (`prompt-assembly-service.ts`): branch-scoped summaries with
 * `includeInContext && content.trim()`, falling back to the legacy flat
 * `chat.summary` field when no summary records exist.
 */
export interface CanvasSummaryEntry {
  id: string;
  label: string;
  content: string;
  source: "manual" | "auto" | "legacy";
  summarizedFrom: number | null;
  summarizedTo: number | null;
  includeInContext: boolean;
}

export interface PromptCanvasSummaryContext {
  chatId: string;
  /** Active chat branch — summaries are branch-scoped. Null falls back to all
   *  summaries for the chat (no branch filter). */
  branchId?: string | null;
  /** Legacy flat `chat.summary` field — shown only when no branch summary
   *  records carry includable content, matching the pipeline fallback. */
  legacySummary?: string | null;
}

type SummaryRecordSource = Pick<
  ChatSummaryRecord,
  "id" | "label" | "content" | "source" | "summarizedFrom" | "summarizedTo" | "includeInContext" | "branchId"
>;

export interface PromptCanvasSummaryLoadDeps {
  listChatSummaries: (chatId: string) => Promise<SummaryRecordSource[]>;
}

const defaultDeps: PromptCanvasSummaryLoadDeps = {
  listChatSummaries: (chatId) => listChatSummaries(chatId as never),
};

/**
 * Resolve the summary memory blocks the pipeline would inject for one chat.
 * The selection rules mirror `prompt-assembly-service.ts`:
 *   1. branch-scoped records with `includeInContext` and non-blank `content`;
 *   2. if none qualify, the legacy `chat.summary` text (single synthetic entry).
 *
 * Pure/exported for a characterization test; the default deps hit the live API.
 */
export async function loadPromptCanvasSummaries(
  context: PromptCanvasSummaryContext,
  deps: PromptCanvasSummaryLoadDeps = defaultDeps,
): Promise<CanvasSummaryEntry[]> {
  const records = await deps.listChatSummaries(context.chatId);
  const branchRecords = context.branchId
    ? records.filter((record) => record.branchId === context.branchId)
    : records;

  const includable = branchRecords
    .filter((record) => record.includeInContext && record.content.trim().length > 0)
    .map<CanvasSummaryEntry>((record) => ({
      id: record.id,
      label: record.label,
      content: record.content,
      source: record.source,
      summarizedFrom: record.summarizedFrom,
      summarizedTo: record.summarizedTo,
      includeInContext: record.includeInContext,
    }));

  if (includable.length > 0) return includable;

  const legacy = context.legacySummary?.trim();
  if (legacy) {
    return [{
      id: `legacy_chat_summary_${context.chatId}`,
      label: "chat",
      content: legacy,
      source: "legacy",
      summarizedFrom: null,
      summarizedTo: null,
      includeInContext: true,
    }];
  }
  return [];
}
