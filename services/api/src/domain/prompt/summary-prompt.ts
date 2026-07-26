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
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

const DEFAULT_SUMMARY_ASSET = "summary-ai-prompt.md";

export async function resolveSummaryPrompt(
	presetSummary: string | null | undefined,
): Promise<string> {
	const trimmed = presetSummary?.trim();
	if (trimmed) return trimmed;
	return loadPromptAsset(DEFAULT_SUMMARY_ASSET);
}
