import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatBranchId, ChatId, PromptTraceRecordDto } from "@vibe-tavern/domain";
import { mapPromptTraceRecord } from "./session-runtime-dto.js";

/**
 * Trace reads for SessionRuntime — extracted from the class (arch-gate
 * file-size ratchet; LC-1). The class methods of the same names are thin
 * delegations over `this.stores`; this module is the one derivation of the
 * trace-read logic (same pattern as session-runtime-messages.ts).
 */

export async function getPromptTraceHistory(
	stores: StoreContainer,
	chatId: ChatId,
	branchId?: ChatBranchId,
	limit = 12,
): Promise<PromptTraceRecordDto[]> {
	// LC-1: the limit is pushed into the SQL query — the slice-after-full-load
	// was the D1 cost (LONG_CHAT_PERFORMANCE_REPORT). Same rows: the store's
	// newest-first order (desc createdAt, desc id) makes slice(0, limit) ≡ LIMIT.
	const traces = await stores.traces.getTracesByChat(chatId, branchId, undefined, limit);
	return traces.map(mapPromptTraceRecord);
}

export async function listPromptTraces(
	stores: StoreContainer,
	chatId: ChatId,
	opts?: { messageId?: string; branchId?: string },
): Promise<PromptTraceRecordDto[]> {
	// Server-side filtering only — the route's query params flow straight to
	// the store so the frontend never receives traces outside its scope.
	const traces = await stores.traces.getTracesByChat(
		chatId,
		opts?.branchId,
		opts?.messageId,
	);
	return traces.map(mapPromptTraceRecord);
}
