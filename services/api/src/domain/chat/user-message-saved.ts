/**
 * "The user message is already stored" — carried on an error raised AFTER
 * `prepareLiveTurn` committed the user turn (provider failure, vision / voice
 * gate). The server keeps that message by design (bound dice rolls and
 * experience attachments stay with it; Resend retries), so the client must
 * show it rather than restore the draft (owner 2026-10-02: the text came back
 * into the input while an invisible stored copy sat in the chat).
 *
 * The streaming path announces the same fact with its `user-message-saved`
 * SSE event; this is the non-streaming twin, surfaced as `userMessageSaved`
 * on the JSON error bodies (app-factory `onError`, the chat route's typed
 * 422 gates).
 */

/** Marks `err` as raised after the user message was stored. Non-Error throws
 *  pass through unmarked. */
export function markUserMessageSaved<T>(err: T): T {
	if (err instanceof Error) Object.assign(err, { userMessageSaved: true });
	return err;
}

/** The JSON fragment to spread into an error body: `{ userMessageSaved: true }`
 *  for a marked error, `{}` otherwise (unmarked bodies stay byte-identical). */
export function userMessageSavedFlag(err: unknown): { userMessageSaved?: true } {
	return err instanceof Error && (err as { userMessageSaved?: unknown }).userMessageSaved === true
		? { userMessageSaved: true }
		: {};
}
