/**
 * Summary-prompt fallback resolver — mirrors the AI-assistant
 * {@link resolveSystemPrompt} role but for the chat summary instruction.
 *
 * Preset text wins when present (non-empty after trim); otherwise the bundled
 * `summary-ai-prompt.md` asset is loaded. This stops the "instruction-less
 * summary call" failure mode where an empty `preset.summary` produced a
 * summary request with no system instruction at all.
 *
 * @see SUMMARY_PRIOR_CONTEXT_PLAN Wave 4
 */
import type { AppDb } from "@vibe-tavern/db";
import { resolveServicePrompt } from "../service-prompts/service-prompt-resolver.js";

export async function resolveSummaryPrompt(db: AppDb): Promise<string> {
	const { text } = await resolveServicePrompt(db, "summary");
	return text;
}
