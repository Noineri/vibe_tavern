/**
 * Ensures the assistant prefill text appears at the start of the model response.
 *
 * When an assistant prefill is used, it is injected as the last assistant message
 * before the API call. Most providers return only the continuation tokens,
 * effectively "skipping" the prefill in the raw response. Some providers echo
 * it back. This function handles both cases by prepending the prefill only
 * when the response does not already start with it.
 *
 * Must be called BEFORE extractThinkingTags() so that the prefill is part of
 * the main content when thinking tags are stripped.
 */

/**
 * If `prefill` is set and `text` does not already start with it,
 * prepend the prefill to the response text.
 */
export function ensurePrefillInResponse(
	text: string,
	prefill?: string,
): string {
	if (!prefill || !text) return text;

	const trimmedPrefill = prefill.trimStart();
	if (!trimmedPrefill) return text;

	// Response already includes the prefill — nothing to do.
	if (text.startsWith(prefill) || text.trimStart().startsWith(trimmedPrefill)) {
		return text;
	}

	return prefill + text;
}
