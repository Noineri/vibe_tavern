/**
 * Non-stream send errors (owner 2026-10-02): when the server already stored
 * the user message before the failure it says so (`userMessageSaved` — inside
 * `error` on the onError bodies, top-level on the route's typed 422 gates),
 * and `sendChatMessage` must carry that fact on the thrown error so the
 * controller shows the stored message instead of restoring the draft. The
 * error message itself (and the 422 gate sentinels) stay exactly as before.
 * Harness: the stt-api.test.ts mockFetch pattern (fetch restored after each).
 */

import { afterEach, beforeAll, describe, expect, it, jest, mock } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let chatApi: typeof import("./chat-api.js");
let isUserMessageSavedError: typeof import("./provider-stream-error.js").isUserMessageSavedError;

beforeAll(async () => {
	chatApi = await import("./chat-api.js");
	({ isUserMessageSavedError } = await import("./provider-stream-error.js"));
});

const originalFetch = globalThis.fetch;

type FetchImplementation = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function respondWith(status: number, body: unknown): void {
	globalThis.fetch = Object.assign(
		mock<FetchImplementation>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
		{ preconnect: originalFetch.preconnect },
	);
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	jest.restoreAllMocks();
});

async function sendFailure(): Promise<unknown> {
	return chatApi.sendChatMessage("chat-1" as ChatId, { content: "hello" }).then(() => null, (err: unknown) => err);
}

describe("sendChatMessage — failure after the user message was stored", () => {
	it("a 502 provider body with error.userMessageSaved → the thrown error is marked; its message is unchanged", async () => {
		respondWith(502, { error: { kind: "Provider", message: "Invalid API key", details: { category: "authentication" }, userMessageSaved: true } });
		const error = await sendFailure();
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Invalid API key");
		expect(isUserMessageSavedError(error)).toBe(true);
	});

	it("a typed 422 vision gate with top-level userMessageSaved → the VISION_NOT_SUPPORTED sentinel, marked", async () => {
		respondWith(422, { type: "vision_not_supported", message: "no vision", attachments: ["cat.png"], userMessageSaved: true });
		const error = await sendFailure();
		expect((error as Error).message).toBe("VISION_NOT_SUPPORTED");
		expect(isUserMessageSavedError(error)).toBe(true);
	});

	it("an error body without the flag → unmarked (the draft-restore path stays)", async () => {
		respondWith(502, { error: { kind: "Provider", message: "Invalid API key", details: { category: "authentication" } } });
		const error = await sendFailure();
		expect((error as Error).message).toBe("Invalid API key");
		expect(isUserMessageSavedError(error)).toBe(false);
	});
});
