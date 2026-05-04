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

export interface ProviderModelOption {
	id: string;
	label: string;
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
	owned_by?: string;
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

export interface TestChatResult {
	success: boolean;
	reply?: string;
	error?: string;
}

export async function testProviderChat(
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

		const payload = (await response.json()) as OpenAiChatCompletionResponse;
		const content = extractChoiceContent(payload.choices?.[0]);
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
	input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
	const url = buildModelsUrl(baseUrl);
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

	return records
		.map((record) => {
			const id = (record.id ?? record.name ?? "").trim();
			if (!id) {
				return null;
			}

			return {
				id,
				label: record.owned_by ? `${id} - ${record.owned_by}` : id,
			};
		})
		.filter((record): record is ProviderModelOption => Boolean(record))
		.sort((left, right) => left.id.localeCompare(right.id));
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
				};
				text?: string;
		  }
		| undefined,
): string {
	if (!choice) {
		return "";
	}

	if (typeof choice.message?.content === "string") {
		return choice.message.content.trim();
	}

	if (Array.isArray(choice.message?.content)) {
		return choice.message.content
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

