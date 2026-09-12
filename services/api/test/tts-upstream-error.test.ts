/**
 * TTS upstream-error mapping — HTTP-level contract (error-typing unit,
 * TTS_FIELD_ROUND_3_REPORT).
 *
 * The server-side TTS backends throw plain Errors (`OpenAiCompatTtsError`,
 * `GeminiTtsError`, `ElevenLabsTtsError`) with the upstream status only in
 * the message text. Unmapped, ANY provider failure (wrong key → upstream 401,
 * dead endpoint, bad model) fell through app-factory onError to the generic
 * 500 "Internal" — hiding the upstream status from the client.
 *
 * These tests pin the WIRE shape of the fix (same discipline as
 * dice-send-http-error.test.ts: assert the mapping, not toBeInstanceOf):
 *  - upstream TTS errors → 502 `{kind:"Provider", details.upstreamStatus?}`
 *  - OpenAiCompatTtsConfigError → 400 `{kind:"Validation"}`
 *
 * The runtime stub throws the exact throwables the real backends produce; the
 * routes forward them verbatim, so the assertion targets the onError mapping.
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app-factory.js";
import {
	OpenAiCompatTtsConfigError,
	OpenAiCompatTtsError,
} from "../src/domain/tts/backends/openai-tts.js";
import { GeminiTtsError } from "../src/domain/tts/backends/gemini-tts.js";
import { ElevenLabsTtsError } from "../src/domain/tts/backends/elevenlabs-tts.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";

function runtimeWithTts(tts: Partial<RuntimeApi["tts"]>): RuntimeApi {
	return { tts } as unknown as RuntimeApi;
}

const GENERATE_BODY = {
	profileId: "tts_profile_1",
	text: "Intone this dramatically.",
	voiceId: "alloy",
};

describe("TTS upstream errors → typed 502 Provider (not generic 500)", () => {
	test("openai-compat upstream 401 (wrong key) → 502 + kind Provider + upstreamStatus", async () => {
		const runtime = runtimeWithTts({
			generateTtsSpeech: async () => {
				throw new OpenAiCompatTtsError(
					"OpenAI-compatible TTS generate failed with HTTP 401: {\"error\":\"Missing or invalid API key\"}",
					{ status: 401 },
				);
			},
		});
		const app = await createApp({ runtime });

		const res = await app.request("/api/tts/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(GENERATE_BODY),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as {
			error: { kind: string; message: string; details?: { upstreamStatus?: number } };
		};
		expect(body.error.kind).toBe("Provider");
		expect(body.error.details?.upstreamStatus).toBe(401);
		expect(body.error.message).toContain("HTTP 401");
	});

	test("transport-level openai-compat error (no HTTP response) → 502 without upstreamStatus", async () => {
		const runtime = runtimeWithTts({
			generateTtsSpeech: async () => {
				throw new OpenAiCompatTtsError("OpenAI-compatible TTS generate network error: ECONNREFUSED");
			},
		});
		const app = await createApp({ runtime });

		const res = await app.request("/api/tts/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(GENERATE_BODY),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as {
			error: { kind: string; details?: { upstreamStatus?: number } };
		};
		expect(body.error.kind).toBe("Provider");
		expect(body.error.details?.upstreamStatus).toBeUndefined();
	});

	test("elevenlabs upstream 401 via draft preview → 502 + upstreamStatus", async () => {
		const runtime = runtimeWithTts({
			draftPreviewTts: async () => {
				throw new ElevenLabsTtsError(
					"ElevenLabs text-to-speech failed with HTTP 401: invalid_api_key",
					{ status: 401 },
				);
			},
		});
		const app = await createApp({ runtime });

		const res = await app.request("/api/tts/draft/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				backend: "elevenlabs",
				config: { apiKey: "transient" },
				voiceId: "Rachel",
				text: "hello",
			}),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as {
			error: { kind: string; details?: { upstreamStatus?: number } };
		};
		expect(body.error.kind).toBe("Provider");
		expect(body.error.details?.upstreamStatus).toBe(401);
	});

	test("gemini payload error (no HTTP status) → 502 kind Provider", async () => {
		const runtime = runtimeWithTts({
			draftPreviewTts: async () => {
				throw new GeminiTtsError("Gemini TTS generate returned no audio part in response");
			},
		});
		const app = await createApp({ runtime });

		const res = await app.request("/api/tts/draft/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				backend: "gemini",
				config: { apiKey: "transient" },
				voiceId: "Kore",
				text: "hello",
			}),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: { kind: string; message: string } };
		expect(body.error.kind).toBe("Provider");
		expect(body.error.message).toContain("no audio part");
	});
});

describe("TTS config errors → 400 Validation (caller's config, not a crash)", () => {
	test("missing endpoint → 400 + kind Validation", async () => {
		const runtime = runtimeWithTts({
			draftListTtsVoices: async () => {
				throw new OpenAiCompatTtsConfigError(
					"OpenAI-compatible TTS config error: `endpoint` is required",
				);
			},
		});
		const app = await createApp({ runtime });

		const res = await app.request("/api/tts/draft/voices", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				backend: "openai-compatible",
				config: { model: "tts-1" },
				profileId: "tts_profile_1",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { kind: string; message: string } };
		expect(body.error.kind).toBe("Validation");
		expect(body.error.message).toContain("endpoint");
	});
});
