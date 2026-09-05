/**
 * TTS API client tests (TPE-16): pins that `generateTtsSpeech` threads the
 * caller's AbortSignal into the fetch (stop-button abort propagation) and
 * omits the signal when no options are passed. Mirrors the stt-api.test.ts
 * harness (happy-dom env, mockFetch).
 */

import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let ttsApi: typeof import("./tts-api.js");

beforeAll(async () => {
	ttsApi = await import("./tts-api.js");
});

const originalFetch = globalThis.fetch;

type FetchImplementation = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function mockFetch(implementation: FetchImplementation): typeof fetch {
	return Object.assign(mock<FetchImplementation>(implementation), {
		preconnect: globalThis.fetch.preconnect,
	});
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("generateTtsSpeech", () => {
	it("threads the caller's AbortSignal into the fetch (stop actually cancels)", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (_input, init) => {
			capturedInit = init;
			return new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});
		});

		const controller = new AbortController();
		const result = await ttsApi.generateTtsSpeech({ profileId: "p1", text: "hi" }, { signal: controller.signal });

		expect(capturedInit?.signal).toBe(controller.signal);
		expect(result.mime).toBe("audio/mpeg");
	});

	it("omits the signal when no options are passed", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (_input, init) => {
			capturedInit = init;
			return new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});
		});

		await ttsApi.generateTtsSpeech({ profileId: "p1", text: "hi" });

		expect(capturedInit?.signal).toBeUndefined();
	});
});
