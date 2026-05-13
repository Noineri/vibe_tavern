import { normalizeProviderType } from "./ai/provider-profile-mapper.js";

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
	metadata?: {
		vision?: boolean;
		reasoning?: boolean;
		function_call?: boolean;
		web_search?: boolean;
	};
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

export async function probeProviderConnection(input: {
	baseUrl: string;
	apiKey: string;
	providerType?: string;
}): Promise<ProviderProbeResult> {
	const providerType = normalizeProviderType(input.providerType ?? "openai_compat");
	switch (providerType) {
		case "google":
			return probeGoogleConnection(input);
		case "anthropic":
			return probeAnthropicConnection(input);
		default:
			return probeOpenAiCompatibleConnection(input);
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
		case "google":
			return testGoogleChat(input);
		case "anthropic":
			return testAnthropicChat(input);
		default:
			return testOpenAiCompatChat(input);
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
		case "anthropic":
			return listAnthropicModels(input);
		case "google":
			return listGoogleModels(input);
		case "ollama":
			return listOllamaModels(input);
		default:
			return listOpenAiCompatModels(input);
	}
}

async function listOpenAiCompatModels(
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
	const isNanoGpt = /nano-gpt\.com/.test(baseUrl);
	const isElectronHub = /electronhub\.ai/.test(baseUrl);

	// NanoGPT: use subscription-only endpoint with detailed info
	// Other providers: standard /models
	const url = isNanoGpt
		? `${baseUrl.replace(/\/v1$/, "")}/subscription/v1/models?detailed=true`
		: buildModelsUrl(baseUrl);

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
	const records = Array.isArray(payload.data) ? payload.data : [];
	const canFilterByEndpoint = records.some((record) => Array.isArray(record.endpoints));
	const chatRecords = isElectronHub && canFilterByEndpoint
		? records.filter((record) => record.endpoints?.includes("/v1/chat/completions"))
		: records;

	return chatRecords
		.map((record) => {
			const id = (record.id ?? record.name ?? "").trim();
			if (!id) {
				return null;
			}

			// Use display name from detailed response, or just id (skip owned_by for NanoGPT)
			if (isNanoGpt) {
				const opt: ProviderModelOption = { id, label: record.name || id };
				if (record.context_length) opt.contextLength = record.context_length;
				return opt;
			}

			const opt: ProviderModelOption = {
				id,
				label: (record.name ?? "").trim() || id,
			};
			const contextLength = record.context_length ?? record.context_length_total ?? record.tokens ?? record.top_provider?.context_length;
			if (contextLength) opt.contextLength = contextLength;
			if (record.description) opt.description = record.description;
			if (record.pricing) {
				const inputPrice = record.pricing.input ?? record.pricing.prompt;
				const outputPrice = record.pricing.output ?? record.pricing.completion;
				if (inputPrice !== undefined || outputPrice !== undefined) {
					opt.pricing = { input: inputPrice, output: outputPrice };
				}
			}
			if (record.metadata || record.premium_model !== undefined) {
				opt.capabilities = {
					vision: record.metadata?.vision,
					reasoning: record.metadata?.reasoning,
					tools: record.metadata?.function_call,
					webSearch: record.metadata?.web_search,
					premium: record.premium_model,
				};
			}
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
		.map((r) => ({ id: r.id, label: r.display_name ?? r.id }))
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
			return opt;
		})
		.filter((r): r is ProviderModelOption => r !== null)
		.sort((a, b) => a.id.localeCompare(b.id));
}

async function listOllamaModels(
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	const url = `${baseUrl.replace(/\/v1$/, "")}/api/tags`;
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

	interface OllamaModel { name: string; model?: string; }
	const payload = (await response.json()) as { models?: OllamaModel[] };
	const records = Array.isArray(payload.models) ? payload.models : [];
	return records
		.map((r) => {
			const id = (r.name ?? r.model ?? "").trim();
			return id ? { id, label: id } : null;
		})
		.filter((r): r is ProviderModelOption => r !== null)
		.sort((a, b) => a.id.localeCompare(b.id));
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

