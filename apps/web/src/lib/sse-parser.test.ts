import { describe, expect, it, mock } from "bun:test";
import { parseSSEStream } from "./sse-parser.js";
import { ProviderStreamError } from "../api/provider-stream-error.js";

/**
 * Contract tests for the chat SSE parser. The headline case is the `error`
 * event: the server (reanimation Layer 3) now emits `{ message, category }`,
 * and the parser must surface both as a {@link ProviderStreamError} so the
 * chat controller can show category-aware feedback (Layer 4). The other event
 * types are covered as regression guards.
 */

function sseResponse(parts: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(encoder.encode(part));
			controller.close();
		},
	});
	return new Response(stream);
}

function opts() {
	return {
		onStatus: mock((_: string) => {}),
		onChunk: mock((_: string) => {}),
	};
}

describe("parseSSEStream", () => {
	it("forwards text-delta chunks to onChunk", async () => {
		const o = opts();
		await parseSSEStream({
			response: sseResponse(["data: {\"delta\":\"Hel\"}\n", "data: {\"delta\":\"lo\"}\n", "data: {\"finishReason\":\"stop\"}\n\n"]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
		});
		expect(o.onChunk).toHaveBeenCalledTimes(2);
		expect(o.onChunk.mock.calls[0]![0]).toBe("Hel");
	});

	it("throws ProviderStreamError with the server's category on an error event", async () => {
		const o = opts();
		const promise = parseSSEStream({
			response: sseResponse(["event: error\n", "data: {\"message\":\"Invalid API key\",\"category\":\"authentication\"}\n\n"]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
		});
		// The error event must fail the generation AND carry the category through.
		await expect(promise).rejects.toBeInstanceOf(ProviderStreamError);
		await expect(promise).rejects.toMatchObject({ message: "Invalid API key", category: "authentication" });
		expect(o.onStatus).toHaveBeenCalledWith("failed");
	});

	it("defaults the category to 'unknown' when the server omits it (backwards compat)", async () => {
		// Older / non-provider errors still send just { message }. The parser must
		// not crash — it surfaces them as an unknown-category ProviderStreamError.
		const o = opts();
		const promise = parseSSEStream({
			response: sseResponse(["event: error\n", "data: {\"message\":\"Something went wrong\"}\n\n"]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
		});
		await expect(promise).rejects.toMatchObject({ message: "Something went wrong", category: "unknown" });
	});

	it("falls back to a default message and 'unknown' category when the error payload is empty", async () => {
		const o = opts();
		const promise = parseSSEStream({
			response: sseResponse(["event: error\n", "data: {}\n\n"]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
		});
		await expect(promise).rejects.toMatchObject({ message: "Provider request failed", category: "unknown" });
	});

	it("surfaces an abort event as 'cancelled' status (no throw)", async () => {
		const o = opts();
		const result = await parseSSEStream({
			response: sseResponse(["event: abort\n\n"]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
		});
		expect(o.onStatus).toHaveBeenCalledWith("cancelled");
		expect(result.finishReason).toBe("cancelled");
	});
});
