/**
 * Extracts <thinking>/<think...> tags from model response text.
 *
 * Some providers (e.g. GLM-5.1 via NanoGPT) return reasoning wrapped in
 * <thinking> tags directly in the content field, rather than via the
 * `reasoning_content` SSE field. This function strips those tags from
 * the main content and returns the reasoning separately.
 *
 * If reasoning was already extracted by the stream executor (via marker
 * protocol or native reasoning parts), the caller's `reasoning` argument
 * takes precedence.
 */
export function extractThinkingTags(
	text: string,
	existingReasoning?: string,
): { mainContent: string; reasoning: string | undefined } {
	const THINKING_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
	const matches = text.match(THINKING_RE);

	if (!matches) {
		return { mainContent: text, reasoning: existingReasoning };
	}

	// Extract reasoning text from tags
	const tagReasoning = matches
		.map((m) =>
			m
				.replace(/^<think(?:ing)?>\s*/i, "")
				.replace(/\s*<\/think(?:ing)?>$/i, "")
				.trim(),
		)
		.filter(Boolean)
		.join("\n\n");

	const mainContent = text.replace(THINKING_RE, "").trim();

	// Merge: stream-detected reasoning first, then tag-extracted
	const combinedReasoning = [existingReasoning, tagReasoning]
		.filter(Boolean)
		.join("\n\n");

	return {
		mainContent: mainContent || "",
		reasoning: combinedReasoning || undefined,
	};
}
