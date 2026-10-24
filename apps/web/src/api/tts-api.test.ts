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

describe("TTS profile reorder client", () => {
	it("patches the typed reorder endpoint with the full sort-order payload", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return new Response(JSON.stringify([]), { status: 200 });
		});

		await ttsApi.reorderTtsProfiles([{ id: "voice-2", sortOrder: 0 }, { id: "voice-1", sortOrder: 1 }]);

		expect(capturedUrl.endsWith("/api/tts/profiles/reorder")).toBe(true);
		expect(capturedInit?.method).toBe("PATCH");
		expect(capturedInit?.body).toBe(JSON.stringify({ updates: [{ id: "voice-2", sortOrder: 0 }, { id: "voice-1", sortOrder: 1 }] }));
	});
});

describe("TTS set-default client", () => {
	it("PUTs the dedicated default route and unwraps the updated record", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return new Response(JSON.stringify({ id: "voice-1", name: "A", isDefault: true }), { status: 200 });
		});

		const updated = await ttsApi.setTtsDefault("voice-1");

		expect(capturedUrl.endsWith("/api/tts/profiles/voice-1/default")).toBe(true);
		expect(capturedInit?.method).toBe("PUT");
		expect(updated).toMatchObject({ id: "voice-1", isDefault: true });
	});
});

// Behavior change (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11c): the draft
// listings carry the server's `source: "stored"` open-path marker — in the body
// only when the caller asks, so the refresh path and the connection tests
// stay byte-identical to before.
describe("TTS draft listings — the stored-first marker", () => {
	function captureBody(): { read: () => Record<string, unknown>; url: () => string } {
		let capturedUrl = "";
		let capturedBody = "";
		globalThis.fetch = mockFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedBody = String(init?.body);
			return new Response(JSON.stringify({ voices: [], capabilities: { supportsCloning: false } }), { status: 200 });
		});
		return { read: () => JSON.parse(capturedBody) as Record<string, unknown>, url: () => capturedUrl };
	}

	it("listTtsDraftVoices sends source only when requested", async () => {
		const sent = captureBody();
		await ttsApi.listTtsDraftVoices({ backend: "openai-compatible", config: { model: "m" }, profileId: "p1", source: "stored" });
		expect(sent.url().endsWith("/api/tts/draft/voices")).toBe(true);
		expect(sent.read()).toEqual({ backend: "openai-compatible", config: { model: "m" }, profileId: "p1", source: "stored" });

		await ttsApi.listTtsDraftVoices({ backend: "openai-compatible", config: { model: "m" }, profileId: "p1" });
		expect("source" in sent.read()).toBe(false);
	});

	it("listTtsDraftModels sends source only when requested", async () => {
		const sent = captureBody();
		await ttsApi.listTtsDraftModels({ backend: "gemini", config: {}, profileId: "p1", source: "stored" });
		expect(sent.url().endsWith("/api/tts/draft/models")).toBe(true);
		expect(sent.read()).toEqual({ backend: "gemini", config: {}, profileId: "p1", source: "stored" });

		await ttsApi.listTtsDraftModels({ backend: "gemini", config: {}, profileId: "p1" });
		expect("source" in sent.read()).toBe(false);
	});
});
