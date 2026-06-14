import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import { normalizeProviderType } from "../ai/provider-profile-mapper.js";

export interface ProviderConnectionInput {
	apiKey: string;
	baseUrl: string;
	model: string;
	maxTokens?: number | null;
	temperature?: number | null;
	topP?: number | null;
	minP?: number | null;
	topK?: number | null;
	typicalP?: number | null;
	repPen?: number | null;
	freqPen?: number | null;
	presPen?: number | null;
	stopSeq?: string | null;
	seed?: number | string | null;
	reasoningEffort?: string | null;
}

export interface ProviderModelCapabilities {
	vision?: boolean;
	reasoning?: boolean;
	tools?: boolean;
	webSearch?: boolean;
	premium?: boolean;
}

export interface ProviderModelPricing {
	input?: number;
	output?: number;
}

export interface ProviderModelOption {
	id: string;
	label: string;
	contextLength?: number;
	capabilities?: ProviderModelCapabilities;
	pricing?: ProviderModelPricing;
	description?: string;
}

const PROBE_TIMEOUT_MS = 5_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;
const TEST_CHAT_TIMEOUT_MS = 15_000;

export interface ProviderProbeResult {
	success: boolean;
	error?: string;
	modelCount?: number;
}

type ProviderKind =
	| "electronhub" | "openrouter" | "nanogpt" | "together"
	| "deepinfra" | "fireworks" | "chutes" | "xai"
	| "groq" | "novita" | "generic";

function detectProviderKind(baseUrl: string): ProviderKind {
	if (/electronhub\.ai/.test(baseUrl)) return "electronhub";
	if (/openrouter\.ai/.test(baseUrl)) return "openrouter";
	if (/nano-gpt\.com/.test(baseUrl)) return "nanogpt";
	if (/together\.xyz/.test(baseUrl)) return "together";
	if (/deepinfra\.com/.test(baseUrl)) return "deepinfra";
	if (/fireworks\.ai/.test(baseUrl)) return "fireworks";
	if (/chutes\.ai/.test(baseUrl)) return "chutes";
	if (/api\.x\.ai/.test(baseUrl) || /\.x\.ai/.test(baseUrl)) return "xai";
	if (/groq\.com/.test(baseUrl)) return "groq";
	if (/novita\.ai/.test(baseUrl)) return "novita";
	return "generic";
}

function mergeCapabilities(primary: ProviderModelCapabilities | undefined, fallback: ProviderModelCapabilities | undefined): ProviderModelCapabilities | undefined {
	if (!primary) return fallback;
	if (!fallback) return primary;
	return {
		vision: primary.vision ?? fallback.vision,
		reasoning: primary.reasoning ?? fallback.reasoning,
		tools: primary.tools ?? fallback.tools,
		webSearch: primary.webSearch ?? fallback.webSearch,
		premium: primary.premium ?? fallback.premium,
	};
}

function inferCapabilities(record: OpenAiModelRecord): ProviderModelCapabilities | undefined {
	const capabilities = {
		vision: record.metadata?.vision
			|| record.architecture?.modality?.includes("image")
			|| record.capabilities?.vision
			|| record.supports_vision
			|| record.input_modalities?.includes("image")
			|| record.modality?.includes("image"),
		reasoning: record.metadata?.reasoning
			|| record.capabilities?.reasoning
			|| record.supports_reasoning
			|| record.supported_parameters?.includes("reasoning"),
			tools: record.metadata?.function_call
			|| record.capabilities?.tools
			|| record.capabilities?.tool_calling
			|| record.capabilities?.tool_use
			|| record.capabilities?.function_calling
			|| record.supports_tools
			|| record.supported_parameters?.includes("tools")
			|| record.supported_parameters?.includes("tool_use")
			|| record.supported_parameters?.includes("tool_calling")
			|| record.supported_parameters?.includes("function_calling"),
		webSearch: record.metadata?.web_search || record.capabilities?.web_search,
		premium: record.premium_model,
	};
	return Object.values(capabilities).some((value) => value !== undefined && value !== false)
		? {
			vision: capabilities.vision || undefined,
			reasoning: capabilities.reasoning || undefined,
			tools: capabilities.tools || undefined,
			webSearch: capabilities.webSearch || undefined,
			premium: capabilities.premium || undefined,
		}
		: undefined;
}

function extractCapabilities(kind: ProviderKind, record: OpenAiModelRecord): ProviderModelCapabilities | undefined {
	const inferred = inferCapabilities(record);
	switch (kind) {
		case "electronhub":
			if (!record.metadata && record.premium_model === undefined) return inferred;
			return mergeCapabilities({
				vision: record.metadata?.vision || undefined,
				reasoning: record.metadata?.reasoning || undefined,
				tools: record.metadata?.function_call || undefined,
				webSearch: record.metadata?.web_search || undefined,
				premium: record.premium_model || undefined,
			}, inferred);

		case "openrouter":
			return mergeCapabilities({
				vision: record.architecture?.modality?.includes("image") || undefined,
				reasoning: record.supported_parameters?.includes("reasoning") || undefined,
				tools: record.supported_parameters?.includes("tools") || undefined,
			}, inferred);

		case "nanogpt":
			return mergeCapabilities(record.capabilities ? {
				vision: record.capabilities.vision || undefined,
				reasoning: record.capabilities.reasoning || undefined,
				tools: record.capabilities.tool_calling || undefined,
			} : undefined, inferred);

		case "together":
			return mergeCapabilities(record.capabilities ? {
				vision: record.capabilities.vision || undefined,
				reasoning: record.capabilities.reasoning || undefined,
				tools: record.capabilities.tool_use ?? record.capabilities.function_calling,
				webSearch: record.capabilities.web_search || undefined,
			} : undefined, inferred);

		case "deepinfra":
			return mergeCapabilities((record.capabilities || record.modality) ? {
				vision: record.capabilities?.vision ?? (record.modality?.includes("image") || undefined),
				reasoning: record.capabilities?.reasoning || undefined,
				tools: record.capabilities?.tool_calling || undefined,
			} : undefined, inferred);

		case "fireworks":
			return mergeCapabilities((record.supports_vision !== undefined || record.supports_tools !== undefined || record.supports_reasoning !== undefined) ? {
				vision: record.supports_vision || undefined,
				reasoning: record.supports_reasoning || undefined,
				tools: record.supports_tools || undefined,
			} : undefined, inferred);

		case "chutes":
			return mergeCapabilities((record.capabilities || record.input_modalities) ? {
				vision: record.capabilities?.vision ?? (record.input_modalities?.includes("image") || undefined),
				reasoning: record.capabilities?.reasoning || undefined,
				tools: record.capabilities?.tools || undefined,
			} : undefined, inferred);

		case "xai":
			return mergeCapabilities(record.input_modalities ? {
				vision: record.input_modalities.includes("image") || undefined,
				tools: true,
			} : undefined, inferred);

		default:
			return inferred;
	}
}

interface OpenAiModelRecord {
	id?: string;
	name?: string;
	description?: string;
	owned_by?: string;
	category?: string;
	context_length?: number;
	context_length_total?: number;
	tokens?: number;
	top_provider?: { context_length?: number };
	endpoints?: string[];
	premium_model?: boolean;
	pricing?: {
		input?: number;
		output?: number;
		prompt?: number;
		completion?: number;
	};
	// ElectronHub
	metadata?: {
		vision?: boolean;
		reasoning?: boolean;
		function_call?: boolean;
		web_search?: boolean;
	};
	// OpenRouter
	architecture?: {
		modality?: string;
		tokenizer?: string;
		instruct_type?: string | null;
	};
	supported_parameters?: string[];
	// NanoGPT, Together, Chutes, DeepInfra
	capabilities?: {
		vision?: boolean;
		reasoning?: boolean;
		tool_calling?: boolean;
		tool_use?: boolean;
		tools?: boolean;
		function_calling?: boolean;
		structured_outputs?: boolean;
		web_search?: boolean;
	};
	// DeepInfra
	modality?: string;
	// Fireworks
	supports_vision?: boolean;
	supports_tools?: boolean;
	supports_reasoning?: boolean;
	// xAI, Chutes
	input_modalities?: string[];
	output_modalities?: string[];
}

interface OpenAiModelsResponse {
	data?: OpenAiModelRecord[];
}

interface OpenAiChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | Array<{ type?: string; text?: string }>;
		};
		text?: string;
	}>;
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) {
		return "";
	}

	if (normalized.endsWith("/chat/completions")) {
		return normalized.slice(0, -"/chat/completions".length);
	}

	return normalized;
}

function normalizeLocalOpenAiCompatibleBaseUrl(baseUrl: string): string {
	const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
	if (!normalized) return "";
	if (normalized.endsWith("/v1")) return normalized;
	if (normalized.endsWith("/api")) return `${normalized.slice(0, -"/api".length)}/v1`;
	return `${normalized}/v1`;
}

function normalizeKoboldCppBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) return "";
	if (normalized.endsWith("/api/v1")) normalized = normalized.slice(0, -"/api/v1".length);
	else if (normalized.endsWith("/api")) normalized = normalized.slice(0, -"/api".length);
	return normalized;
}

export async function probeProviderConnection(input: {
	baseUrl: string;
	apiKey: string;
	providerType?: string;
}): Promise<ProviderProbeResult> {
	const providerType = normalizeProviderType(input.providerType ?? "openai_compat");
	switch (providerType) {
		case PROVIDER_TYPE.google:
			return probeGoogleConnection(input);
		case PROVIDER_TYPE.anthropic:
			return probeAnthropicConnection(input);
		case PROVIDER_TYPE.ollama:
			return probeOllamaConnection(input);
		case PROVIDER_TYPE.koboldCpp:
			return probeKoboldCppConnection(input);
		case PROVIDER_TYPE.llamaCpp:
		case PROVIDER_TYPE.unsloth:
			return probeOpenAiCompatibleConnection({ ...input, baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl) });
		default:
			return probeOpenAiCompatibleConnection(input);
	}
}

async function probeOllamaConnection(input: {
	baseUrl: string;
	apiKey: string;
}): Promise<ProviderProbeResult> {
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

async function probeKoboldCppConnection(input: {
	baseUrl: string;
	apiKey: string;
}): Promise<ProviderProbeResult> {
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

async function probeOpenAiCompatibleConnection(input: {
	baseUrl: string;
	apiKey: string;
}): Promise<ProviderProbeResult> {
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
		response = await fetch(buildModelsUrl(baseUrl), {
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

async function probeGoogleConnection(input: {
	baseUrl: string;
	apiKey: string;
}): Promise<ProviderProbeResult> {
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

async function probeAnthropicConnection(input: {
	baseUrl: string;
	apiKey: string;
}): Promise<ProviderProbeResult> {
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

export interface TestChatResult {
	success: boolean;
	reply?: string;
	error?: string;
}

export async function testProviderChat(
	input: ProviderConnectionInput & { providerType?: string },
): Promise<TestChatResult> {
	const providerType = normalizeProviderType(input.providerType ?? "openai_compat");
	switch (providerType) {
		case PROVIDER_TYPE.google:
			return testGoogleChat(input);
		case PROVIDER_TYPE.anthropic:
			return testAnthropicChat(input);
		case PROVIDER_TYPE.ollama:
			return testOllamaChat(input);
		case PROVIDER_TYPE.koboldCpp:
			return testKoboldCppChat(input);
		case PROVIDER_TYPE.llamaCpp:
		case PROVIDER_TYPE.unsloth:
			return testOpenAiCompatChat({ ...input, baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl) });
		default:
			return testOpenAiCompatChat(input);
	}
}

async function testOllamaChat(
	input: ProviderConnectionInput,
): Promise<TestChatResult> {
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

async function testKoboldCppChat(
	input: ProviderConnectionInput,
): Promise<TestChatResult> {
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

async function testOpenAiCompatChat(
	input: ProviderConnectionInput,
): Promise<TestChatResult> {
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

async function testGoogleChat(
	input: ProviderConnectionInput,
): Promise<TestChatResult> {
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

async function testAnthropicChat(
	input: ProviderConnectionInput,
): Promise<TestChatResult> {
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

export async function listProviderModels(
	input: Omit<ProviderConnectionInput, "model"> & { providerType?: string; requiresAuthForModels?: boolean },
): Promise<ProviderModelOption[]> {
	const providerType = normalizeProviderType(input.providerType ?? "openai_compat");

	if (input.requiresAuthForModels && !input.apiKey) {
		throw new Error("API key required to fetch models for this provider.");
	}

	switch (providerType) {
		case PROVIDER_TYPE.anthropic:
			return listAnthropicModels(input);
		case PROVIDER_TYPE.google:
			return listGoogleModels(input);
		case PROVIDER_TYPE.ollama:
			return listOllamaModels(input);
		case PROVIDER_TYPE.koboldCpp:
			return listKoboldCppModels(input);
		case PROVIDER_TYPE.llamaCpp:
		case PROVIDER_TYPE.unsloth:
			return listOpenAiCompatModels({ ...input, baseUrl: normalizeLocalOpenAiCompatibleBaseUrl(input.baseUrl) });
		default:
			return listOpenAiCompatModels(input);
	}
}

async function listOpenAiCompatModels(
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);

	if (!baseUrl || !tryParseUrl(baseUrl)) {
		throw new Error(`Invalid provider endpoint: ${input.baseUrl}`);
	}

	const providerKind = detectProviderKind(baseUrl);

	// Provider-specific endpoint URLs
	let url: string;
	switch (providerKind) {
		case "nanogpt":
			url = `${baseUrl.replace(/\/v1$/, "")}/subscription/v1/models?detailed=true`;
			break;
		case "deepinfra":
			url = `${baseUrl}/models?filter=with_meta`;
			break;
		case "xai":
			url = `${baseUrl.replace(/\/v1$/, "")}/v1/language-models`;
			break;
		default:
			url = buildModelsUrl(baseUrl);
			break;
	}

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

	const payload = (await response.json()) as OpenAiModelsResponse & { models?: OpenAiModelRecord[] };
	// xAI returns { models: [...] } instead of { data: [...] }
	const rawRecords = providerKind === "xai"
		? (Array.isArray(payload.models) ? payload.models : [])
		: (Array.isArray(payload.data) ? payload.data : []);

	// ElectronHub: only keep models that support chat completions
	const canFilterByEndpoint = rawRecords.some((record) => Array.isArray(record.endpoints));
	const chatRecords = providerKind === "electronhub" && canFilterByEndpoint
		? rawRecords.filter((record) => record.endpoints?.includes("/v1/chat/completions"))
		: rawRecords;

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

			// Capabilities — unified extraction
			const capabilities = extractCapabilities(providerKind, record);
			if (capabilities) opt.capabilities = capabilities;

			return opt;
		})
		.filter((record): record is ProviderModelOption => Boolean(record))
		.sort((left, right) => left.label.localeCompare(right.label));
}

async function listAnthropicModels(
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
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

async function listGoogleModels(
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
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

async function listKoboldCppModels(
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
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

async function listOllamaModels(
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
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

function buildHeaders(apiKey: string, withBody = false): HeadersInit {
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (withBody) {
		headers["Content-Type"] = "application/json";
	}
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

function buildModelsUrl(baseUrl: string): string {
	return `${baseUrl}/models`;
}

function tryParseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

function extractChoiceContent(
	choice:
		| {
				message?: {
					content?: string | Array<{ type?: string; text?: string }>;
					reasoning_content?: string | null;
				};
				text?: string;
		  }
		| undefined,
		options?: { skipReasoning?: boolean },
): string {
	if (!choice) {
		return "";
	}

	if (typeof choice.message?.content === "string") {
		return choice.message.content.trim();
	}

	if (Array.isArray(choice.message?.content)) {
		return choice.message.content
			.filter((part) => {
				if (options?.skipReasoning && (part.type === "thinking" || part.type === "reasoning")) return false;
				return true;
			})
			.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
			.join("")
			.trim();
	}

	return (choice.text ?? "").trim();
}

function wrapProviderNetworkError(
	error: unknown,
	input: {
		operation: string;
		timeoutMs: number;
	},
): Error {
	const timeoutSeconds = Math.floor(input.timeoutMs / 1000);
	if (
		error instanceof Error &&
		(error.name === "TimeoutError" ||
			/aborted due to timeout/i.test(error.message))
	) {
		return new Error(`${input.operation} timed out after ${timeoutSeconds}s.`);
	}

	if (error instanceof Error) {
		return error;
	}

	return new Error(`${input.operation} failed.`);
}

