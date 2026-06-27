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
	constructor(message: string, category: ProviderErrorCategory) {
		super(message);
		this.name = "ProviderStreamError";
		this.category = category;
	}
}
