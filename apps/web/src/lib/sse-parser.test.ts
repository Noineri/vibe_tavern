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

	// ── Co-author tool-call events (CA-9.1) ──
	// The backend (live-chat-orchestrator.drainStream) emits these four wire
	// events carrying the AI's proposed edits. The parser forwards each to an
	// optional callback; RP chat callers pass none of them, so they are inert.

	it("forwards a co-author tool-call event to onToolCall", async () => {
		const o = opts();
		const onToolCall = mock((_: { toolCallId: string; toolName: string; args: unknown }) => {});
		await parseSSEStream({
			response: sseResponse([
				"event: tool-call\n",
				'data: {"toolCallId":"call_1","toolName":"edit_profile","args":{"target":"personality","proposed":"Bold."}}\n\n',
			]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
			onToolCall,
		});
		expect(onToolCall).toHaveBeenCalledTimes(1);
		expect(onToolCall.mock.calls[0]![0]).toEqual({
			toolCallId: "call_1",
			toolName: "edit_profile",
			args: { target: "personality", proposed: "Bold." },
		});
	});

	it("forwards tool-input-delta chunks to onToolInputDelta", async () => {
		const o = opts();
		const onToolInputDelta = mock((_: { toolCallId: string; delta: string }) => {});
		await parseSSEStream({
			response: sseResponse([
				"event: tool-input-delta\n",
				'data: {"toolCallId":"call_1","delta":"Hel"}\n',
				"event: tool-input-delta\n",
				'data: {"toolCallId":"call_1","delta":"lo"}\n\n',
			]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
			onToolInputDelta,
		});
		expect(onToolInputDelta).toHaveBeenCalledTimes(2);
		expect(onToolInputDelta.mock.calls[0]![0]).toEqual({ toolCallId: "call_1", delta: "Hel" });
		expect(onToolInputDelta.mock.calls[1]![0]).toEqual({ toolCallId: "call_1", delta: "lo" });
	});

	it("forwards a tool-result event (with isError flag) to onToolResult", async () => {
		const o = opts();
		const onToolResult = mock(
			(_: { toolCallId: string; toolName: string; output: unknown; isError: boolean }) => {},
		);
		await parseSSEStream({
			response: sseResponse([
				"event: tool-result\n",
				'data: {"toolCallId":"call_1","toolName":"edit_profile","output":{"ok":true},"isError":false}\n\n',
			]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
			onToolResult,
		});
		expect(onToolResult).toHaveBeenCalledTimes(1);
		expect(onToolResult.mock.calls[0]![0]).toEqual({
			toolCallId: "call_1",
			toolName: "edit_profile",
			output: { ok: true },
			isError: false,
		});
	});

	it("defaults isError to false when the server omits it on a tool-result", async () => {
		const o = opts();
		const onToolResult = mock(
			(_: { toolCallId: string; toolName: string; output: unknown; isError: boolean }) => {},
		);
		await parseSSEStream({
			response: sseResponse([
				"event: tool-result\n",
				'data: {"toolCallId":"call_2","toolName":"edit_greeting","output":{"ok":true}}\n\n',
			]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
			onToolResult,
		});
		expect(onToolResult.mock.calls[0]![0].isError).toBe(false);
	});

	it("ignores tool events when no tool callbacks are wired (RP chat unaffected)", async () => {
		// RP chat callers pass only onChunk/onReasoningChunk*. A co-author stream's
		// tool events must not throw or pollute onChunk — regression gate.
		const o = opts();
		await parseSSEStream({
			response: sseResponse([
				"event: tool-call\n",
				'data: {"toolCallId":"call_1","toolName":"edit_profile","args":{}}\n',
				"event: tool-result\n",
				'data: {"toolCallId":"call_1","toolName":"edit_profile","output":{},"isError":false}\n\n',
			]),
			onStatus: o.onStatus,
			onChunk: o.onChunk,
		});
		expect(o.onChunk).not.toHaveBeenCalled();
		expect(o.onStatus).toHaveBeenCalledWith("idle");
	});
});
