/**
 * STT API client tests (STT_PLAN ST-5b): pins that `transcribeSttAudio`
 * builds the multipart payload the server route expects (file + profileId +
 * optional language) and hits the mobile-token-aware URL; and that the CRUD
 * helpers surface errors through the unified unwrap path. Mirrors the
 * skill-api.test.ts harness (happy-dom env, mockFetch, FormData spy).
 */

import { afterEach, beforeAll, describe, expect, it, jest, mock, spyOn } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

let sttApi: typeof import("./stt-api.js");

beforeAll(async () => {
	sttApi = await import("./stt-api.js");
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
	jest.restoreAllMocks();
});

describe("transcribeSttAudio", () => {
	it("posts the audio blob + profileId (+ language) as multipart on the token-aware URL", async () => {
		const appendSpy = spyOn(FormData.prototype, "append");
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		globalThis.fetch = mockFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return new Response(JSON.stringify({ text: "hello", language: "en" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
		const result = await sttApi.transcribeSttAudio("stt_1", blob, "ru");

		expect(result).toEqual({ text: "hello", language: "en" });
		// The URL is the transcribe route on the gateway base (mobile token is
		// absent in this env — appendTokenQuery is a pass-through then).
		expect(capturedUrl.endsWith("/api/stt/transcribe")).toBe(true);
		expect(capturedInit?.method).toBe("POST");

		const form = capturedInit?.body as FormData;
		const fileField = form.get("audio") as Blob;
		expect(fileField).toBeTruthy();
		expect(appendSpy).toHaveBeenCalledWith("audio", blob, "audio");
		expect(form.get("profileId")).toBe("stt_1");
		expect(form.get("language")).toBe("ru");
	});

	it("omits the language field when not provided", async () => {
		const appendSpy = spyOn(FormData.prototype, "append");
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = mockFetch(async (_input, init) => {
			capturedInit = init;
			return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
		});
		await sttApi.transcribeSttAudio("stt_1", new Blob(["x"], { type: "audio/mpeg" }));
		const form = capturedInit?.body as FormData;
		expect(appendSpy).toHaveBeenCalledWith("audio", expect.anything(), "audio");
		expect(appendSpy).toHaveBeenCalledWith("profileId", "stt_1");
		expect(form.get("language")).toBeNull();
	});

	it("non-2xx → typed error with the server message", async () => {
		globalThis.fetch = mockFetch(async () => new Response("stt profile not found", { status: 404 }));
		await expect(sttApi.transcribeSttAudio("missing", new Blob(["x"]))).rejects.toThrow("stt profile not found");
	});
});

describe("STT profile CRUD helpers", () => {
	it("listAllSttProfiles unwraps the RPC envelope", async () => {
		globalThis.fetch = mockFetch(async () =>
			new Response(JSON.stringify([{ id: "stt_1", name: "W" }]), { status: 200 }),
		);
		const profiles = await sttApi.listAllSttProfiles();
		expect(profiles.length).toBe(1);
		expect(profiles[0]).toMatchObject({ id: "stt_1", name: "W" });
	});

	it("getSttProfile returns null on 404", async () => {
		// The RPC client derives its URL from the AppType path template; the
		// mobile gateway base may be empty in tests, so assert purely that a
		// 404 decodes to null via the mocked fetch (the client routes through
		// hc() → fetch).
		globalThis.fetch = mockFetch(async () => new Response('{"error":"STT profile not found"}', { status: 404 }));
		const profile = await sttApi.getSttProfile("missing");
		expect(profile).toBeNull();
	});

	it("createSttProfile throws the unwrapped error on failure", async () => {
		globalThis.fetch = mockFetch(async () =>
			new Response(JSON.stringify({ error: "validation failed" }), { status: 400 }),
		);
		await expect(sttApi.createSttProfile({ name: "x", backend: "whisper-browser" })).rejects.toThrow(
			"validation failed",
		);
	});
});