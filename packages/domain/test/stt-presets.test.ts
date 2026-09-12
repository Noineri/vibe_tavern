/**
 * Characterization tests for the named STT provider preset roster
 * (STT_PROVIDER_EXPANSION_REPORT, SPE-1).
 *
 * These pin the DATA contract the picker and the openai-stt adapter build on:
 * roster shape (unique ids, existing backends, non-empty base URLs except the
 * local row), auth-header overrides (Cartesia), and the model-source
 * discriminated union (static lists self-consistent, fetch/free-text carried
 * by their defaults). Endpoint facts themselves are doc-verified and pinned
 * verbatim — a silent edit to a base URL or a model list must fail here.
 */

import { describe, expect, test } from "bun:test";

import {
	DEFAULT_DEEPGRAM_STT_MODEL,
	DEFAULT_ELEVENLABS_STT_MODEL,
	DEFAULT_GEMINI_STT_MODEL,
	DEFAULT_NVIDIA_STT_MODEL,
	STT_BACKENDS,
	STT_PRESET_AUTH_HEADER,
	STT_PRESET_GROUP,
	STT_PROVIDER_PRESETS,
	getSttNativePreset,
	getSttPresetGroup,
	getSttProviderPreset,
} from "../src/index.js";

const ROSTER_IDS = STT_PROVIDER_PRESETS.map((p) => p.id);

describe("STT provider presets — roster shape", () => {
	test("roster ids are unique", () => {
		expect(new Set(ROSTER_IDS).size).toBe(ROSTER_IDS.length);
	});

	test("every preset rides an existing backend", () => {
		const known = new Set<string>(Object.values(STT_BACKENDS));
		for (const preset of STT_PROVIDER_PRESETS) {
			expect(known.has(preset.backend)).toBe(true);
		}
	});

	test("group taxonomy mirrors the LLM-tab pattern (SPE-8)", () => {
		const byId = new Map(STT_PROVIDER_PRESETS.map((p) => [p.id, p.group]));
		for (const id of ["openai", "openrouter", "groq", "mistral", "cartesia"]) {
			expect(byId.get(id)).toBe(STT_PRESET_GROUP.Cloud);
		}
		for (const id of ["gemini", "deepgram", "elevenlabs", "nvidia"]) {
			expect(byId.get(id)).toBe(STT_PRESET_GROUP.Native);
		}
		expect(byId.get("local")).toBe(STT_PRESET_GROUP.Local);
		expect(byId.get("whisper-cpp")).toBe(STT_PRESET_GROUP.Local);
	});

	test("compat rows ride the openai-compat transport; native rows ride their own slugs", () => {
		// SPE-4..6 + SPE-8: the gemini/deepgram/elevenlabs/nvidia rows ride
		// their OWN native backend adapters (baseUrl empty, authHeader
		// omitted — the adapter owns the wire). SPE-9 adds the whisper-cpp
		// row — an own-wire LOCAL backend (editable address). Every other row
		// must stay executable by the one OpenAI-compatible server transport.
		const compatIds = ["openai", "openrouter", "groq", "mistral", "cartesia", "local"];
		for (const preset of STT_PROVIDER_PRESETS) {
			if (compatIds.includes(preset.id)) {
				expect(preset.backend).toBe(STT_BACKENDS.OpenAiCompat);
			} else {
			expect(preset.backend).not.toBe(STT_BACKENDS.OpenAiCompat);
			}
		}
	});

	test("baseUrl is non-empty for cloud compat rows; empty only for local and endpoint-fixed natives", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			if (preset.id === "local" || (preset.backend !== STT_BACKENDS.OpenAiCompat && preset.id !== "whisper-cpp")) {
				// Natives have a FIXED endpoint inside their adapter — no baseUrl.
				expect(preset.baseUrl).toBe("");
			} else if (preset.id === "whisper-cpp") {
				// SPE-9: an own-wire LOCAL row carries the server's default
				// address as a PREFILL — the endpoint stays user-editable.
				expect(preset.baseUrl).toBe("http://127.0.0.1:8080");
			} else {
				expect(preset.baseUrl.startsWith("https://")).toBe(true);
				// Adapter-normalized form: no trailing slash (the adapter
				// appends `/audio/transcriptions` itself).
				expect(preset.baseUrl.endsWith("/")).toBe(false);
			}
		}
	});

	test("the two local rows mark the key optional — every server row requires one", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			expect(preset.keyOptional).toBe(preset.id === "local" || preset.id === "whisper-cpp");
		}
	});

	test("authHeader rides compat rows only — native adapters own their wire", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			if (preset.backend === STT_BACKENDS.OpenAiCompat) {
				expect(preset.authHeader).toBe(STT_PRESET_AUTH_HEADER.Bearer);
			} else {
				expect(preset.authHeader).toBeUndefined();
			}
		}
	});

	test("englishOnly flags the NVIDIA row alone", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			expect(preset.englishOnly ?? false).toBe(preset.id === "nvidia");
		}
	});
});

describe("STT provider presets — verbatim endpoint facts (doc-verified)", () => {
	test("openai row", () => {
		const preset = getSttProviderPreset("openai");
		expect(preset?.baseUrl).toBe("https://api.openai.com/v1");
		expect(preset?.authHeader).toBe(STT_PRESET_AUTH_HEADER.Bearer);
		expect(preset?.modelSource).toEqual({
			kind: "static",
			models: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-transcribe"],
			defaultModel: "whisper-1",
		});
	});

	test("openrouter row uses live fetch, not a hardcoded list", () => {
		const preset = getSttProviderPreset("openrouter");
		expect(preset?.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(preset?.modelSource.kind).toBe("fetch");
	});

	test("groq row", () => {
		const preset = getSttProviderPreset("groq");
		expect(preset?.baseUrl).toBe("https://api.groq.com/openai/v1");
		expect(preset?.modelSource).toEqual({
			kind: "static",
			models: ["whisper-large-v3", "whisper-large-v3-turbo"],
			defaultModel: "whisper-large-v3",
		});
	});

	test("mistral row", () => {
		const preset = getSttProviderPreset("mistral");
		expect(preset?.baseUrl).toBe("https://api.mistral.ai/v1");
		expect(preset?.modelSource).toEqual({
			kind: "static",
			models: ["voxtral-mini-3b-2507", "voxtral-small-24b-2507-stt"],
			defaultModel: "voxtral-mini-3b-2507",
		});
	});

	test("cartesia row — no /v1 segment and Bearer auth (SPE-R correction)", () => {
		// The drop-in endpoint is https://api.cartesia.ai/audio/transcriptions
		// (no version segment). Auth is Bearer — their own /stt OpenAPI
		// declares the bearer scheme and the live cartesia-tts adapter sends
		// Bearer (SPE-R 2026-09-05; the old X-API-Key claim came from a now
		// unreachable migrate page — no transport override needed).
		const preset = getSttProviderPreset("cartesia");
		expect(preset?.baseUrl).toBe("https://api.cartesia.ai");
		expect(preset?.authHeader).toBe(STT_PRESET_AUTH_HEADER.Bearer);
		expect(preset?.modelSource).toEqual({
			kind: "static",
			models: ["ink-whisper"],
			defaultModel: "ink-whisper",
		});
	});

	test("local row — user-filled URL, free-text model, keyless-friendly", () => {
		const preset = getSttProviderPreset("local");
		expect(preset?.baseUrl).toBe("");
		expect(preset?.vendor).toBe("");
		expect(preset?.modelSource).toEqual({
			kind: "free-text",
			defaultModel: "whisper-1",
		});
		expect(preset?.keyOptional).toBe(true);
	});
});

describe("STT provider presets — model-source union invariants", () => {
	test("static lists are non-empty and contain their default", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			if (preset.modelSource.kind === "static") {
				expect(preset.modelSource.models.length).toBeGreaterThan(0);
				expect(preset.modelSource.models).toContain(preset.modelSource.defaultModel);
				// Picker order is the shipped order — no duplicates.
				expect(new Set(preset.modelSource.models).size).toBe(preset.modelSource.models.length);
			} else if (preset.modelSource.kind === "server") {
				// SPE-9: the server-bound arm carries no default — the model is
				// bound at server start, not request-side.
				expect(true).toBe(true);
			} else {
				// fetch/free-text arms carry a non-empty default.
				expect(preset.modelSource.defaultModel.length).toBeGreaterThan(0);
			}
		}
	});

	test("local and whisper.cpp rows carry no vendor slug (localhost — the auto-key rule has nothing to match)", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			if (preset.id === "local" || preset.id === "whisper-cpp") continue;
			expect(preset.vendor.length).toBeGreaterThan(0);
		}
		expect(getSttProviderPreset("whisper-cpp")?.vendor).toBe("");
	});
});

describe("getSttProviderPreset", () => {
	test("resolves by slug and returns undefined for unknown ids", () => {
		expect(getSttProviderPreset("groq")?.id).toBe("groq");
		expect(getSttProviderPreset("nope")).toBeUndefined();
	});
});

describe("native preset rows (SPE-4..6, SPE-8)", () => {
	test("gemini — own slug, live catalog fetch, ST-7 default (SPE-8: preset row, not a segment option)", () => {
		const preset = getSttProviderPreset("gemini");
		expect(preset?.group).toBe(STT_PRESET_GROUP.Native);
		expect(preset?.backend).toBe(STT_BACKENDS.Gemini);
		expect(preset?.baseUrl).toBe("");
		expect(preset?.vendor).toBe("gemini");
		expect(preset?.authHeader).toBeUndefined();
		expect(preset?.modelSource).toEqual({
			kind: "fetch",
			defaultModel: DEFAULT_GEMINI_STT_MODEL,
		});
		expect(preset?.keyOptional).toBe(false);
		expect(preset?.englishOnly ?? false).toBe(false);
	});

	test("deepgram — own slug, live catalog fetch, nova-3 default", () => {
		const preset = getSttProviderPreset("deepgram");
		expect(preset?.backend).toBe(STT_BACKENDS.Deepgram);
		expect(preset?.baseUrl).toBe("");
		expect(preset?.vendor).toBe("deepgram");
		expect(preset?.modelSource).toEqual({
			kind: "fetch",
			defaultModel: DEFAULT_DEEPGRAM_STT_MODEL,
		});
		expect(preset?.englishOnly ?? false).toBe(false);
	});

	test("elevenlabs — own slug, static Scribe roster, scribe_v2 default", () => {
		const preset = getSttProviderPreset("elevenlabs");
		expect(preset?.backend).toBe(STT_BACKENDS.ElevenLabs);
		expect(preset?.modelSource).toEqual({
			kind: "static",
			models: [DEFAULT_ELEVENLABS_STT_MODEL, "scribe-1"],
			defaultModel: DEFAULT_ELEVENLABS_STT_MODEL,
		});
	});

	test("nvidia — own slug, static omni roster, EN-only flag", () => {
		const preset = getSttProviderPreset("nvidia");
		expect(preset?.backend).toBe(STT_BACKENDS.Nvidia);
		expect(preset?.modelSource).toEqual({
			kind: "static",
			models: [DEFAULT_NVIDIA_STT_MODEL],
			defaultModel: DEFAULT_NVIDIA_STT_MODEL,
		});
		expect(preset?.englishOnly).toBe(true);
	});

	test("whisper-cpp — own-wire LOCAL row, server-bound model, keyless, prefilled default port (SPE-9)", () => {
		const preset = getSttProviderPreset("whisper-cpp");
		expect(preset?.group).toBe(STT_PRESET_GROUP.Local);
		expect(preset?.backend).toBe(STT_BACKENDS.WhisperCpp);
		// The server's own default host/port (doc-verified: server_params
		// hostname 127.0.0.1, port 8080) — a PREFILL, not a fixed endpoint.
		expect(preset?.baseUrl).toBe("http://127.0.0.1:8080");
		expect(preset?.vendor).toBe("");
		expect(preset?.authHeader).toBeUndefined();
		expect(preset?.modelSource).toEqual({ kind: "server" });
		expect(preset?.keyOptional).toBe(true);
		expect(preset?.englishOnly ?? false).toBe(false);
	});
});

describe("getSttPresetGroup", () => {
	test("resolves the group by slug, null for unknown ids", () => {
		expect(getSttPresetGroup("openai")).toBe(STT_PRESET_GROUP.Cloud);
		expect(getSttPresetGroup("gemini")).toBe(STT_PRESET_GROUP.Native);
		expect(getSttPresetGroup("local")).toBe(STT_PRESET_GROUP.Local);
		expect(getSttPresetGroup("nope")).toBeNull();
	});
});

describe("getSttNativePreset", () => {
	test("resolves the row for each native slug (SPE-8: gemini included)", () => {
		expect(getSttNativePreset(STT_BACKENDS.Gemini)?.id).toBe("gemini");
		expect(getSttNativePreset(STT_BACKENDS.Deepgram)?.id).toBe("deepgram");
		expect(getSttNativePreset(STT_BACKENDS.ElevenLabs)?.id).toBe("elevenlabs");
		expect(getSttNativePreset(STT_BACKENDS.Nvidia)?.id).toBe("nvidia");
	});

	test("undefined for compat (many rows per backend) and whisper-browser (browser tier, no row)", () => {
		expect(getSttNativePreset(STT_BACKENDS.OpenAiCompat)).toBeUndefined();
		expect(getSttNativePreset(STT_BACKENDS.WhisperBrowser)).toBeUndefined();
	});
});
