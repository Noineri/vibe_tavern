/**
 * @module providers/google-adapter
 *
 * The Google (Gemini / Generative Language) protocol. Owns its probe /
 * test-chat / list-models HTTP operations (the v1beta REST shape) and its
 * complete {@link ProtocolAdapter} constant. Google's probe additionally
 * treats HTTP 400 as an auth-rejected status.
 *
 * Extracted from protocol-registry.ts (AD-019).
 */

import { createGoogle } from "@ai-sdk/google";
import { interpretProbeResponse } from "./probe-helpers.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import {
	PROBE_TIMEOUT_MS,
	MODEL_LIST_TIMEOUT_MS,
	TEST_CHAT_TIMEOUT_MS,
	tryParseUrl,
	wrapProviderNetworkError,
	type ProviderConnectionInput,
	type ProviderModelOption,
	type ProviderProbeResult,
	type TestChatResult,
} from "./provider-transport.js";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter, ProbeInput, ListModelsInput } from "./protocol-types.js";

export async function probeGoogleConnection(input: ProbeInput): Promise<ProviderProbeResult> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl) {
		return { success: false, error: "Provider endpoint is required." };
	}
	const parsed = tryParseUrl(baseUrl);
	if (!parsed) {
		return { success: false, error: "Provider endpoint is invalid." };
	}
	if (!/^https?:$/.test(parsed.protocol)) {
		return { success: false, error: "Provider endpoint must use http or https." };
	}

	const url = `${baseUrl}/v1beta/models?key=${input.apiKey}`;
	let response: Response;
	try {
		const doFetch: typeof fetch = input.fetch ?? fetch;
		response = await doFetch(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		return {
			success: false,
			error: `Network error during probe: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	return interpretProbeResponse(response, (payload) => {
		const models = (payload as { models?: unknown[] }).models;
		return Array.isArray(models) ? models.length : undefined;
	}, [400, 401, 403]);
}

export async function testGoogleChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl)
		return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const url = `${baseUrl}/v1beta/models/${input.model}:generateContent?key=${input.apiKey}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);
	const doFetch: typeof fetch = input.fetch ?? fetch;

	try {
		const response = await doFetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: "Hi" }] }],
				generationConfig: { maxOutputTokens: 64 },
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			return {
				success: false,
				error: `${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
			};
		}

		const payload = (await response.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};
		const content = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
		return { success: true, reply: content || "(empty response)" };
	} catch (error) {
		clearTimeout(timer);
		const msg = error instanceof Error ? error.message : "Unknown error";
		if (
			error instanceof Error &&
			(error.name === "TimeoutError" || /aborted/i.test(error.message))
		) {
			return {
				success: false,
				error: `Timed out after ${Math.floor(TEST_CHAT_TIMEOUT_MS / 1000)}s.`,
			};
		}
		return { success: false, error: msg };
	}
}

export async function listGoogleModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	const apiKey = input.apiKey;
	const url = `${baseUrl}/v1beta/models?key=${apiKey}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	let response: Response;
	try {
		const doFetch: typeof fetch = input.fetch ?? fetch;
		response = await doFetch(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		clearTimeout(timer);
	} catch (error) {
		clearTimeout(timer);
		throw wrapProviderNetworkError(error, { operation: "Google model list", timeoutMs: MODEL_LIST_TIMEOUT_MS });
	}

	if (!response.ok) {
		throw new Error(`Google model list failed: ${response.status} ${response.statusText}`);
	}

	interface GoogleModel {
		name: string;
		displayName?: string;
		supportedGenerationMethods?: string[];
		inputTokenLimit?: number;
	}
	const payload = (await response.json()) as { models?: GoogleModel[] };
	const records = Array.isArray(payload.models) ? payload.models : [];

	// Only keep text/chat models. Some non-chat Google models (image/music/TTS)
	// still expose generateContent, so method filtering alone is not enough.
	const CHAT_METHODS = new Set(["generateContent", "generateMessage"]);
	const NON_CHAT_MODEL_PATTERNS = [
		/image/i,
		/imagen/i,
		/nano[-\s]?banana/i,
		/lyria/i,
		/veo/i,
		/tts/i,
		/native[-\s]?audio/i,
		/embedding/i,
		/aqa$/i,
	];

	return records
		.filter((r) => {
			const id = r.name.replace(/^models\//, "").trim();
			const label = r.displayName ?? id;
			const searchable = `${id} ${label}`;
			if (NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(searchable))) return false;

			const methods = r.supportedGenerationMethods;
			if (!Array.isArray(methods) || methods.length === 0) return false;
			return methods.some((m) => CHAT_METHODS.has(m));
		})
		.map((r) => {
			const id = r.name.replace(/^models\//, "").trim();
			if (!id) return null;
			const opt: ProviderModelOption = { id, label: r.displayName ?? id };
			if (r.inputTokenLimit) opt.contextLength = r.inputTokenLimit;
			opt.capabilities = { vision: true, tools: true };
			return opt;
		})
		.filter((r): r is ProviderModelOption => r !== null)
		.sort((a, b) => a.id.localeCompare(b.id));
}

export const googleProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.google,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.minimal_reasoning,
		textCompletion: false,
	},
	resolveModel(profile, model, fetch?: ProviderFetch) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		// Google SDK defaults to https://generativelanguage.googleapis.com/v1beta.
		// Only override baseURL if the user explicitly changed it (e.g. Vertex AI
		// proxy).
		const defaultGoogleBase = "https://generativelanguage.googleapis.com";
		const googleBaseUrl = (!endpoint || endpoint === defaultGoogleBase)
			? undefined
			: endpoint;
		const provider = createGoogle({
			apiKey: apiKey || "not-needed",
			baseURL: googleBaseUrl,
			...(fetch ? { fetch } : {}),
		});
		return provider(model);
	},
	limitations: [],
	probe: probeGoogleConnection,
	testChat: testGoogleChat,
	listModels: listGoogleModels,
};
