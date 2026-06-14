/**
 * @module providers/protocol-registry
 *
 * Protocol registry — one {@link ProtocolAdapter} per {@link ProviderType}.
 *
 * This is the single source of truth for per-protocol knowledge. It collapses
 * four sites that were previously kept in sync by hand:
 *
 *   1. `mapProfileToSdkModel` 7-arm switch (`ai/provider-profile-mapper.ts`)
 *   2. `PROVIDER_CAPABILITIES` map (`ai/provider-capabilities.ts`)
 *   3. `provider-gateway` probe/test/list switches
 *   4. `SAMPLER_SETS` per-protocol lookup
 *
 * Adding a new native provider (e.g. Vertex AI) is now one object entry here,
 * not a four-site lock-step edit. Each adapter carries its capability flags,
 * its SDK model resolver, its human-readable limitations, AND its probe /
 * test-chat / list-models operations in one place.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2 (registry) and §5.3.3
 * (the request-mode / `textCompletion` axis — the field is present now, default
 * false; Novel Mode flips it per protocol when text-completion wiring lands).
 *
 * NOTE: providers/ imports nothing from ai/. The generation pipeline (ai/)
 * depends on providers/ one-way. Do not invert this.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import {
	PROVIDER_TYPE,
	SAMPLER_SETS,
} from "@vibe-tavern/domain";
import type { ProviderType, SamplerCapabilityFlags } from "@vibe-tavern/domain";
import { providerError } from "../../shared/errors.js";
import { createReasoningAwareFetch } from "./openai-reasoning-fetch.js";
import { createKoboldCppModel } from "./koboldcpp-adapter.js";
import { createOllamaModel } from "./ollama-adapter.js";
import {
	resolveVendor,
	buildDefaultModelsUrl,
	type OpenAiModelRecord,
	type OpenAiModelsResponse,
} from "./vendor-registry.js";
import {
	PROBE_TIMEOUT_MS,
	MODEL_LIST_TIMEOUT_MS,
	TEST_CHAT_TIMEOUT_MS,
	normalizeOpenAiCompatibleBaseUrl,
	normalizeLocalOpenAiCompatibleBaseUrl,
	normalizeKoboldCppBaseUrl,
	buildHeaders,
	tryParseUrl,
	extractChoiceContent,
	wrapProviderNetworkError,
	type ProviderConnectionInput,
	type ProviderModelOption,
	type ProviderProbeResult,
	type TestChatResult,
	type OpenAiChatCompletionResponse,
} from "./provider-transport.js";

// ---------------------------------------------------------------------------
// Capability flags (canonical type — source of truth lives here now)
// ---------------------------------------------------------------------------

export interface ProviderCapabilityFlags {
	/** Provider can produce a complete non-streamed reply. */
	nonStreamGeneration: boolean;
	/** Provider execution respects an AbortSignal for cancellation. */
	abortSignal: boolean;
	/** Provider supports SSE/streaming responses. */
	streaming: boolean;
	/** Provider supports prefill (prefixing assistant content). */
	prefill: boolean;
	/** Provider supports logit bias (token-level output control). */
	logitBias: boolean;
	/** Granular sampler controls supported by this provider type. */
	samplers: SamplerCapabilityFlags;
	/**
	 * Whether this protocol can serve a raw text-completion request
	 * (`/v1/completions` or a native equivalent like KoboldCPP `/api/v1/generate`),
	 * as required by Novel Mode's flat-prompt assembler.
	 *
	 * Refactor plan §5.3.3. Default false everywhere until Novel Mode's
	 * text-completion wiring lands; flipping a flag here is the only change
	 * needed to opt a protocol in.
	 */
	textCompletion: boolean;
}

export interface ProviderProfileInput {
	providerPreset: string;
	endpoint: string;
	apiKey: string | null;
}

// ---------------------------------------------------------------------------
// Protocol adapter
// ---------------------------------------------------------------------------

/** Input for a connection probe (no model required). */
export interface ProbeInput {
	baseUrl: string;
	apiKey: string;
}

/** Input for a model list request (no model required). */
export type ListModelsInput = Omit<ProviderConnectionInput, "model">;

export interface ProtocolAdapter {
	id: ProviderType;
	capabilities: ProviderCapabilityFlags;
	/**
	 * Resolve a Vercel AI SDK chat {@link LanguageModel} for this protocol.
	 *
	 * (Text-completion mode lands with §5.3.3; for now every protocol resolves
	 * a chat model.)
	 */
	resolveModel(profile: ProviderProfileInput, model: string): LanguageModel;
	/** Human-readable limitations surfaced to the UI. */
	limitations: string[];
	/** Connectivity probe (hit a models/tags endpoint, return success + count). */
	probe(input: ProbeInput): Promise<ProviderProbeResult>;
	/** Send a minimal "Hi" chat request to verify generation works. */
	testChat(input: ProviderConnectionInput): Promise<TestChatResult>;
	/** List available models from the provider's models/tags endpoint. */
	listModels(input: ListModelsInput): Promise<ProviderModelOption[]>;
}

// ===========================================================================
// Per-protocol operations (probe / testChat / listModels)
//
// Lifted verbatim from the historical provider-gateway.ts. Each protocol owns
// its HTTP shape here. Shared helpers live in provider-transport.ts.
// ===========================================================================

// ── OpenAI-compatible (shared by openai_compat, llamaCpp, unsloth) ─────────

async function probeOpenAiCompatibleConnection(input: ProbeInput): Promise<ProviderProbeResult> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
	if (!baseUrl) {
		return { success: false, error: "Provider endpoint is required." };
	}
	const parsed = tryParseUrl(baseUrl);
	if (!parsed) {
		return { success: false, error: "Provider endpoint is invalid." };
	}
	if (!/^https?:$/.test(parsed.protocol)) {
		return {
			success: false,
			error: "Provider endpoint must use http or https.",
		};
	}

	let response: Response;
	try {
		response = await fetch(buildDefaultModelsUrl(baseUrl), {
			method: "GET",
			headers: buildHeaders(input.apiKey),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		return {
			success: false,
			error: `Network error during probe: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (response.ok) {
		let modelCount: number | undefined;
		try {
			const payload = (await response.json()) as OpenAiModelsResponse;
			modelCount = Array.isArray(payload.data)
				? payload.data.length
				: undefined;
		} catch {
			modelCount = undefined;
		}

		return { success: true, modelCount };
	}

	if (response.status === 401 || response.status === 403) {
		return {
			success: false,
			error: `Authentication rejected (${response.status} ${response.statusText}).`,
		};
	}
	if (response.status === 404) {
		return {
			success: false,
			error: "Provider does not expose a /models endpoint.",
		};
	}
	return {
		success: false,
		error: `Probe failed: ${response.status} ${response.statusText}`,
	};
}

async function testOpenAiCompatChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
	if (!baseUrl)
		return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: buildHeaders(input.apiKey, true),
			body: JSON.stringify({
				model: input.model,
				messages: [{ role: "user", content: "Hi" }],
				max_tokens: 64,
				temperature: 0.7,
				stream: false,
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

		const payload = (await response.json()) as OpenAiChatCompletionResponse & {
			choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }>; reasoning_content?: string | null } }>;
		};
		const choice = payload.choices?.[0];
		const content = extractChoiceContent(choice, { skipReasoning: true });
		if (!content && choice?.message?.reasoning_content) {
			return { success: true, reply: "(reasoning only, no visible output)" };
		}
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

async function listOpenAiCompatModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);

	if (!baseUrl || !tryParseUrl(baseUrl)) {
		throw new Error(`Invalid provider endpoint: ${input.baseUrl}`);
	}

	const vendor = resolveVendor(baseUrl);

	// Vendor-specific endpoint URL (defaults to the standard /models path).
	const url = vendor.buildModelsUrl?.(baseUrl) ?? buildDefaultModelsUrl(baseUrl);

	let response: Response;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	try {
		response = await fetch(url, {
			method: "GET",
			headers: buildHeaders(input.apiKey),
			signal: controller.signal,
		});
		clearTimeout(timer);
	} catch (error) {
		clearTimeout(timer);
		throw wrapProviderNetworkError(error, {
			operation: "Model list request",
			timeoutMs: MODEL_LIST_TIMEOUT_MS,
		});
	}

	if (!response.ok) {
		throw new Error(
			`Model list request failed: ${response.status} ${response.statusText}`,
		);
	}

	const payload = (await response.json()) as OpenAiModelsResponse;
	// Vendor-specific record extraction (xAI uses { models: [...] }; default { data: [...] }).
	const rawRecords = vendor.extractRecords?.(payload)
		?? (Array.isArray(payload.data) ? payload.data : []);

	// Vendor-specific filtering (ElectronHub keeps only chat-completions endpoints).
	const chatRecords = vendor.filterRecords ? vendor.filterRecords(rawRecords) : rawRecords;

	return chatRecords
		.map((record) => {
			const id = (record.id ?? record.name ?? "").trim();
			if (!id) return null;

			const opt: ProviderModelOption = {
				id,
				label: (record.name ?? "").trim() || id,
			};

			// Context length — try all known field names
			const contextLength = record.context_length
				?? record.context_length_total
				?? record.tokens
				?? record.top_provider?.context_length;
			if (contextLength) opt.contextLength = contextLength;

			if (record.description) opt.description = record.description;

			// Pricing
			if (record.pricing) {
				const inputPrice = record.pricing.input ?? record.pricing.prompt;
				const outputPrice = record.pricing.output ?? record.pricing.completion;
				if (inputPrice !== undefined || outputPrice !== undefined) {
					opt.pricing = { input: inputPrice, output: outputPrice };
				}
			}

			// Capabilities — vendor-specific extraction
			const capabilities = vendor.extractCapabilities(record);
			if (capabilities) opt.capabilities = capabilities;

			return opt;
		})
		.filter((record): record is ProviderModelOption => Boolean(record))
		.sort((left, right) => left.label.localeCompare(right.label));
}

// ── Google ─────────────────────────────────────────────────────────────────

async function probeGoogleConnection(input: ProbeInput): Promise<ProviderProbeResult> {
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
		response = await fetch(url, {
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

	if (response.ok) {
		let modelCount: number | undefined;
		try {
			const payload = (await response.json()) as { models?: unknown[] };
			modelCount = Array.isArray(payload.models) ? payload.models.length : undefined;
		} catch {
			modelCount = undefined;
		}
		return { success: true, modelCount };
	}

	if (response.status === 400 || response.status === 401 || response.status === 403) {
		return {
			success: false,
			error: `Authentication rejected (${response.status} ${response.statusText}).`,
		};
	}
	if (response.status === 404) {
		return { success: false, error: "Provider does not expose a /models endpoint." };
	}
	return { success: false, error: `Probe failed: ${response.status} ${response.statusText}` };
}

async function testGoogleChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl)
		return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const url = `${baseUrl}/v1beta/models/${input.model}:generateContent?key=${input.apiKey}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: "Hi" }] }],
				generationConfig: { maxOutputTokens: 64, temperature: 0.7 },
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

async function listGoogleModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	const apiKey = input.apiKey;
	const url = `${baseUrl}/v1beta/models?key=${apiKey}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, {
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

// ── Anthropic ──────────────────────────────────────────────────────────────

async function probeAnthropicConnection(input: ProbeInput): Promise<ProviderProbeResult> {
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

	const url = `${baseUrl}/models`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (input.apiKey) {
		headers["x-api-key"] = input.apiKey;
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		return {
			success: false,
			error: `Network error during probe: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (response.ok) {
		let modelCount: number | undefined;
		try {
			const payload = (await response.json()) as { data?: unknown[] };
			modelCount = Array.isArray(payload.data) ? payload.data.length : undefined;
		} catch {
			modelCount = undefined;
		}
		return { success: true, modelCount };
	}

	if (response.status === 401 || response.status === 403) {
		return {
			success: false,
			error: `Authentication rejected (${response.status} ${response.statusText}).`,
		};
	}
	if (response.status === 404) {
		return { success: false, error: "Provider does not expose a /models endpoint." };
	}
	return { success: false, error: `Probe failed: ${response.status} ${response.statusText}` };
}

async function testAnthropicChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl)
		return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const url = `${baseUrl}/messages`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				...(input.apiKey ? { "x-api-key": input.apiKey } : {}),
			},
			body: JSON.stringify({
				model: input.model,
				max_tokens: 64,
				messages: [{ role: "user", content: "Hi" }],
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
			content?: Array<{ type?: string; text?: string }>;
		};
		const textBlock = payload.content?.find((c) => c.type === "text");
		const content = textBlock?.text?.trim() ?? "";
		if (!content && payload.content?.some((c) => c.type === "thinking")) {
			return { success: true, reply: "(reasoning only, no visible output)" };
		}
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

async function listAnthropicModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	const url = `${baseUrl}/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				...(input.apiKey ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" } : {}),
			},
			signal: controller.signal,
		});
		clearTimeout(timer);
	} catch (error) {
		clearTimeout(timer);
		throw wrapProviderNetworkError(error, { operation: "Anthropic model list", timeoutMs: MODEL_LIST_TIMEOUT_MS });
	}

	if (!response.ok) {
		throw new Error(`Anthropic model list failed: ${response.status} ${response.statusText}`);
	}

	interface AnthropicModel { id: string; display_name?: string; }
	const payload = (await response.json()) as { data?: AnthropicModel[] };
	const records = Array.isArray(payload.data) ? payload.data : [];
	return records
		.map((r) => ({
			id: r.id,
			label: r.display_name ?? r.id,
			capabilities: { vision: true, tools: true, reasoning: true },
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Ollama ─────────────────────────────────────────────────────────────────

async function probeOllamaConnection(input: ProbeInput): Promise<ProviderProbeResult> {
	try {
		const models = await listOllamaModels(input);
		return { success: true, modelCount: models.length };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testOllamaChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
	if (!baseUrl) return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

	try {
		const response = await fetch(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				model: input.model,
				messages: [{ role: "user", content: "Hi" }],
				stream: false,
				options: { num_predict: 64, temperature: 0.7 },
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

		const payload = (await response.json()) as { message?: { content?: string } };
		const content = payload.message?.content?.trim() ?? "";
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

async function listOllamaModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
	const url = `${baseUrl}/api/tags`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		clearTimeout(timer);
	} catch (error) {
		clearTimeout(timer);
		throw wrapProviderNetworkError(error, { operation: "Ollama model list", timeoutMs: MODEL_LIST_TIMEOUT_MS });
	}

	if (!response.ok) {
		throw new Error(`Ollama model list failed: ${response.status} ${response.statusText}`);
	}

	interface OllamaModel { name: string; model?: string; capabilities?: string[]; }
	const payload = (await response.json()) as { models?: OllamaModel[] };
	const records = Array.isArray(payload.models) ? payload.models : [];
	const baseOptions = records
		.filter((r) => !r.capabilities?.includes("embedding") || r.capabilities?.includes("completion"))
		.map((r) => {
			const id = (r.name ?? r.model ?? "").trim();
			return id ? { id, label: id } : null;
		})
		.filter((r): r is ProviderModelOption => r !== null);

	const enriched = await Promise.all(
		baseOptions.map(async (option) => ({
			...option,
			...(await fetchOllamaModelMetadata(baseUrl, option.id)),
		})),
	);

	return enriched.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchOllamaModelMetadata(
	baseUrl: string,
	model: string,
): Promise<Partial<ProviderModelOption>> {
	try {
		const response = await fetch(`${baseUrl}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ model }),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (!response.ok) return {};

		const payload = (await response.json()) as {
			capabilities?: string[];
			details?: {
				family?: string;
				families?: string[];
				format?: string;
				parameter_size?: string;
				quantization_level?: string;
			};
			model_info?: Record<string, unknown>;
			parameters?: string;
		};

		const metadata: Partial<ProviderModelOption> = {};
		const contextLength = extractOllamaContextLength(payload);
		if (contextLength) metadata.contextLength = contextLength;

		const details = payload.details;
		const detailParts = [
			details?.parameter_size,
			details?.quantization_level,
			details?.family,
			details?.format,
		].filter(Boolean);
		if (detailParts.length > 0) metadata.description = detailParts.join(" · ");
		if (payload.capabilities) {
			metadata.capabilities = {
				vision: payload.capabilities.includes("vision"),
			};
		}

		return metadata;
	} catch {
		return {};
	}
}

function extractOllamaContextLength(payload: {
	model_info?: Record<string, unknown>;
	parameters?: string;
}): number | undefined {
	const info = payload.model_info ?? {};
	for (const [key, value] of Object.entries(info)) {
		if (!/(^|\.)context_length$/.test(key)) continue;
		const parsed = typeof value === "number" ? value : Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}

	const numCtxMatch = payload.parameters?.match(/(?:^|\n)\s*num_ctx\s+(\d+)/i);
	if (numCtxMatch?.[1]) {
		const parsed = Number(numCtxMatch[1]);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}

	return undefined;
}

// ── KoboldCPP ──────────────────────────────────────────────────────────────

async function probeKoboldCppConnection(input: ProbeInput): Promise<ProviderProbeResult> {
	try {
		const models = await listKoboldCppModels(input);
		return { success: true, modelCount: models.length };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testKoboldCppChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = normalizeKoboldCppBaseUrl(input.baseUrl);
	if (!baseUrl) return { success: false, error: "Provider endpoint is required." };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

	try {
		const response = await fetch(`${baseUrl}/api/v1/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				prompt: "User: Hi\nAssistant:",
				max_length: 64,
				temperature: 0.7,
				stream: false,
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

		const payload = (await response.json()) as { results?: Array<{ text?: string }> };
		const content = payload.results?.[0]?.text?.trim() ?? "";
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

async function listKoboldCppModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = normalizeKoboldCppBaseUrl(input.baseUrl);
	if (!baseUrl || !tryParseUrl(baseUrl)) {
		throw new Error(`Invalid provider endpoint: ${input.baseUrl}`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/api/v1/model`, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		clearTimeout(timer);
	} catch (error) {
		clearTimeout(timer);
		throw wrapProviderNetworkError(error, { operation: "KoboldCPP model list", timeoutMs: MODEL_LIST_TIMEOUT_MS });
	}

	if (!response.ok) {
		throw new Error(`KoboldCPP model list failed: ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as { result?: string; model?: string; name?: string };
	const id = (payload.result ?? payload.model ?? payload.name ?? "koboldcpp-loaded-model").trim();
	return [{ id: id || "koboldcpp-loaded-model", label: id || "KoboldCPP loaded model" }];
}

// ===========================================================================
// Per-protocol adapters
// ===========================================================================

const openaiCompatProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.openaiCompat,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.openai_compat_minimal,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		// `openai_compat` is intentionally broad: in this app it covers
		// aggregators and non-OpenAI model-family providers, not only the real
		// OpenAI Chat API. The stricter OpenAI-only sampler surface is selected
		// elsewhere by preset-level resolveSamplerCapabilities("openai", ...).
		const provider = createOpenAICompatible({
			name: "openai_compat",
			apiKey: apiKey || "not-needed",
			baseURL: endpoint || "https://api.openai.com/v1",
			fetch: createReasoningAwareFetch(),
			// Many OpenAI-compatible aggregators/models support response_format:
			// json_schema, but the generic provider defaults this capability to
			// false unless declared.
			supportsStructuredOutputs: true,
		});
		return provider.chatModel(model);
	},
	limitations: [],
	probe: probeOpenAiCompatibleConnection,
	testChat: testOpenAiCompatChat,
	listModels: listOpenAiCompatModels,
};

const anthropicProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.anthropic,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.anthropic,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		const provider = createAnthropic({
			apiKey: apiKey || "not-needed",
			baseURL: endpoint || undefined,
		});
		return provider(model);
	},
	limitations: [],
	probe: probeAnthropicConnection,
	testChat: testAnthropicChat,
	listModels: listAnthropicModels,
};

const googleProtocol: ProtocolAdapter = {
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
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		// Google SDK defaults to https://generativelanguage.googleapis.com/v1beta.
		// Only override baseURL if the user explicitly changed it (e.g. Vertex AI
		// proxy).
		const defaultGoogleBase = "https://generativelanguage.googleapis.com";
		const googleBaseUrl = (!endpoint || endpoint === defaultGoogleBase)
			? undefined
			: endpoint;
		const provider = createGoogleGenerativeAI({
			apiKey: apiKey || "not-needed",
			baseURL: googleBaseUrl,
		});
		return provider(model);
	},
	limitations: [],
	probe: probeGoogleConnection,
	testChat: testGoogleChat,
	listModels: listGoogleModels,
};

const ollamaProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.ollama,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.openai_local,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "") || "http://localhost:11434";
		return createOllamaModel({ baseURL: endpoint, modelId: model });
	},
	limitations: [
		"Uses Ollama native /api/chat endpoint for full sampler support.",
		"Model list uses Ollama's native /api/tags endpoint.",
	],
	probe: probeOllamaConnection,
	testChat: testOllamaChat,
	listModels: listOllamaModels,
};

// llama.cpp + Unsloth wrap a local OpenAI-compat server; they reuse the
// openai_compat probe/test/list operations but normalize the base URL to /v1
// first (matching the historical gateway switch arms).
const llamaCppProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.llamaCpp,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.openai_local,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint);
		const apiKey = profile.apiKey ?? "";
		const provider = createOpenAICompatible({
			name: "llamacpp",
			apiKey: apiKey || "not-needed",
			baseURL: endpoint,
			fetch: createReasoningAwareFetch(),
		});
		return provider.chatModel(model);
	},
	limitations: [
		"Uses llama.cpp server's OpenAI-compatible /v1 endpoint for generation.",
		"Sampling parameters top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen are not forwarded via OpenAI-compatible adapter.",
		"Model selection is limited to the single loaded model on the llama.cpp server.",
	],
	probe: (input) => probeOpenAiCompatibleConnection({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
	testChat: (input) => testOpenAiCompatChat({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
	listModels: (input) => listOpenAiCompatModels({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
};

const koboldCppProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.koboldCpp,
	capabilities: {
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.koboldcpp_native,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "") || "http://localhost:5001";
		return createKoboldCppModel({ baseURL: endpoint, modelId: model ?? "koboldcpp" });
	},
	limitations: [
		"Uses KoboldCPP native /api/v1/generate endpoint (not OpenAI-compat).",
		"Chat messages are serialized into a flat text prompt.",
		"Tool calling is not supported.",
	],
	probe: probeKoboldCppConnection,
	testChat: testKoboldCppChat,
	listModels: listKoboldCppModels,
};

const unslothProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.unsloth,
	capabilities: {
		// Unsloth Studio wraps llama-server behind OpenAI-compat /v1 endpoints.
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: true,
		logitBias: true,
		samplers: SAMPLER_SETS.openai_local,
		textCompletion: false,
	},
	resolveModel(profile, model) {
		const endpoint = normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint || "http://localhost:8888");
		const apiKey = profile.apiKey ?? "";
		const provider = createOpenAICompatible({
			name: "unsloth",
			apiKey: apiKey || "not-needed",
			baseURL: endpoint,
			fetch: createReasoningAwareFetch(),
		});
		return provider.chatModel(model);
	},
	limitations: [
		"Uses Unsloth Studio's OpenAI-compatible /v1 endpoint (llama-server under the hood).",
		"Requires an sk-unsloth- API key created from Studio Settings → API.",
	],
	probe: (input) => probeOpenAiCompatibleConnection({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
	testChat: (input) => testOpenAiCompatChat({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
	listModels: (input) => listOpenAiCompatModels({
		...input,
		baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl),
	}),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const protocols: Record<ProviderType, ProtocolAdapter> = {
	[PROVIDER_TYPE.openaiCompat]: openaiCompatProtocol,
	[PROVIDER_TYPE.anthropic]: anthropicProtocol,
	[PROVIDER_TYPE.google]: googleProtocol,
	[PROVIDER_TYPE.ollama]: ollamaProtocol,
	[PROVIDER_TYPE.llamaCpp]: llamaCppProtocol,
	[PROVIDER_TYPE.koboldCpp]: koboldCppProtocol,
	[PROVIDER_TYPE.unsloth]: unslothProtocol,
};

/**
 * Resolve the {@link ProtocolAdapter} for a canonical {@link ProviderType}.
 *
 * Callers holding a raw preset ID must normalise it first via
 * `normalizeProviderType()` from `@vibe-tavern/domain`.
 *
 * Throws for an unknown type. In practice this is unreachable: the
 * `protocols` record is exhaustive over the `ProviderType` union, and
 * `normalizeProviderType` falls back to `openai_compat`.
 */
export function resolveProtocol(type: ProviderType): ProtocolAdapter {
	const adapter = protocols[type];
	if (!adapter) {
		throw providerError(
			`Unknown provider type '${type}'. ` +
				`Supported types: ${Object.values(PROVIDER_TYPE).join(", ")}.`,
			{ providerType: type },
		);
	}
	return adapter;
}

/**
 * Derived capability map (keyed by provider type). Kept as an export so the
 * compatibility shim in `ai/provider-capabilities.ts` can re-export the legacy
 * `PROVIDER_CAPABILITIES` name without duplicating data.
 */
export const PROTOCOL_CAPABILITIES: Record<ProviderType, ProviderCapabilityFlags> =
	Object.fromEntries(
		Object.values(protocols).map((adapter) => [adapter.id, adapter.capabilities]),
	) as Record<ProviderType, ProviderCapabilityFlags>;
