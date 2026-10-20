/**
 * Summary-prompt fallback resolver — mirrors the AI-assistant
 * {@link resolveSystemPrompt} role but for the chat summary instruction.
 *
 * Preset text wins when present (non-empty after trim); otherwise the bundled
 * asset is loaded. This stops the "instruction-less summary call" failure mode
 * where an empty override produced a summary request with no system
 * instruction at all.
 *
 * SC-8d: WHICH service prompt summarizes a chat is decided here, in
 * {@link summaryPromptKeyForChatMode} — the one key-decision place. Co-author
 * chats summarize with `coauthor_summary` (an authoring session: decisions,
 * applied changes, stated preferences, open TODOs — never story continuity);
 * every other mode keeps `summary` (the RP continuity engine). An existing
 * user override of `summary` therefore keeps applying to RP chats only, and
 * co-author chats start from the new default.
 *
 * @see SUMMARY_PRIOR_CONTEXT_PLAN Wave 4
 */
import { CHAT_MODE, type ChatMode, type ServicePromptFieldKey } from "@vibe-tavern/domain";
import type { AppDb } from "@vibe-tavern/db";
import { resolveServicePrompt } from "../service-prompts/service-prompt-resolver.js";

/** The single place that maps a chat mode to its summary service-prompt key. */
export function summaryPromptKeyForChatMode(mode: ChatMode): ServicePromptFieldKey {
  return mode === CHAT_MODE.coauthor ? "coauthor_summary" : "summary";
}

export async function resolveSummaryPrompt(db: AppDb, mode: ChatMode = CHAT_MODE.rp): Promise<string> {
	const { text } = await resolveServicePrompt(db, summaryPromptKeyForChatMode(mode));
	return text;
}
