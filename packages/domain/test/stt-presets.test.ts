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
	STT_BACKENDS,
	STT_PRESET_AUTH_HEADER,
	STT_PROVIDER_PRESETS,
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

	test("all SPE-1 rows are on the openai-compat transport", () => {
		// Native-adapter vendors (deepgram/elevenlabs/nvidia) join with their
		// own backends in SPE-4..6 — until then every preset row must be
		// executable by the ONE existing server transport.
		for (const preset of STT_PROVIDER_PRESETS) {
			expect(preset.backend).toBe(STT_BACKENDS.OpenAiCompat);
		}
	});

	test("baseUrl is non-empty for every cloud row; empty only for local", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			if (preset.id === "local") {
				expect(preset.baseUrl).toBe("");
			} else {
				expect(preset.baseUrl.startsWith("https://")).toBe(true);
				// Adapter-normalized form: no trailing slash (the adapter
				// appends `/audio/transcriptions` itself).
				expect(preset.baseUrl.endsWith("/")).toBe(false);
			}
		}
	});

	test("only the local preset marks the key optional", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			expect(preset.keyOptional).toBe(preset.id === "local");
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

	test("cartesia row — no /v1 segment and the X-API-Key override", () => {
		// The drop-in endpoint is https://api.cartesia.ai/audio/transcriptions
		// (no version segment) and keeps Cartesia's own header — the adapter
		// must NOT send Bearer there (SPE-2 consumes this flag).
		const preset = getSttProviderPreset("cartesia");
		expect(preset?.baseUrl).toBe("https://api.cartesia.ai");
		expect(preset?.authHeader).toBe(STT_PRESET_AUTH_HEADER.XApiKey);
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
			} else {
				// fetch/free-text arms carry a non-empty default.
				expect(preset.modelSource.defaultModel.length).toBeGreaterThan(0);
			}
		}
	});

	test("every non-local row carries a vendor slug for the auto-key rule", () => {
		for (const preset of STT_PROVIDER_PRESETS) {
			if (preset.id === "local") continue;
			expect(preset.vendor.length).toBeGreaterThan(0);
		}
	});
});

describe("getSttProviderPreset", () => {
	test("resolves by slug and returns undefined for unknown ids", () => {
		expect(getSttProviderPreset("groq")?.id).toBe("groq");
		expect(getSttProviderPreset("nope")).toBeUndefined();
	});
});
