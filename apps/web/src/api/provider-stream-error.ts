import type { ProviderErrorCategory } from "@vibe-tavern/api-contracts";

/**
 * Error thrown by the chat stream client ({@link parseSSEStream} in
 * `lib/sse-parser.ts` and `streamChatEndpoint` in `api/stream.ts`) when a
 * provider/LLM generation fails. Carries the server-classified `category` so
 * the UI can show category-appropriate feedback (e.g. authentication → "open
 * provider settings") instead of raw HTTP text.
 *
 * The category originates server-side (`classifyProviderError` in services/api,
 * reanimation Layer 1) and crosses the wire in the SSE `error` event
 * `{ message, category }` (streaming endpoints) or the JSON error body
 * `error.details.category` (non-streaming endpoints). `unknown` means no signal
 * matched — the UI shows just the message.
 */
export class ProviderStreamError extends Error {
	readonly category: ProviderErrorCategory;
	/** Optional structured conflict/disambiguation code the server attached to
	 *  the error payload (e.g. a dice commit conflict `stale_revision` /
	 *  `unresolved_choose` — DICE-F3). Absent for ordinary provider failures. */
	readonly code?: string;
	/** The provider cut the stream mid-reply and the server KEPT the text
	 *  streamed before the cut (`partialSaved` on the SSE error event) — the
	 *  chat holds the user message and the partial reply, so the client
	 *  reloads it instead of restoring the draft. */
	readonly partialSaved: boolean;
	/** The server had already stored the user message when the error came
	 *  (the stream's `user-message-saved` event preceded it) — the client
	 *  shows it by reloading the chat instead of restoring the draft. */
	readonly userMessageSaved: boolean;
	constructor(
		message: string,
		category: ProviderErrorCategory,
		code?: string,
		kept: { partialSaved?: boolean; userMessageSaved?: boolean } = {},
	) {
		super(message);
		this.name = "ProviderStreamError";
		this.category = category;
		this.code = code;
		this.partialSaved = kept.partialSaved ?? false;
		this.userMessageSaved = kept.userMessageSaved ?? false;
	}
}

/** Marks a NON-stream send error whose body said the server had already
 *  stored the user message (`userMessageSaved`) — the twin of the stream
 *  error's own `userMessageSaved` field. */
export function markUserMessageSaved<E extends Error>(error: E): E {
	return Object.assign(error, { userMessageSaved: true });
}

/** The failed send's user message is on the server — a marked non-stream
 *  error or a {@link ProviderStreamError} whose stream announced it. */
export function isUserMessageSavedError(error: unknown): boolean {
	return error instanceof Error && (error as { userMessageSaved?: unknown }).userMessageSaved === true;
}
