/**
 * @module providers/anthropic-adapter
 *
 * The Anthropic (Claude) protocol. Owns its probe / test-chat / list-models
 * HTTP operations (the /v1/messages + /v1/models REST shape with
 * anthropic-version + x-api-key headers, reasoning-only test-chat handling)
 * and its complete {@link ProtocolAdapter} constant.
 *
 * Extracted from protocol-registry.ts (AD-019).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
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

export async function probeAnthropicConnection(input: ProbeInput): Promise<ProviderProbeResult> {
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
		const doFetch: typeof fetch = input.fetch ?? fetch;
		response = await doFetch(url, {
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

	return interpretProbeResponse(response, (payload) => {
		const models = (payload as { data?: unknown[] }).data;
		return Array.isArray(models) ? models.length : undefined;
	});
}

export async function testAnthropicChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl)
		return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const url = `${baseUrl}/messages`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);
	const doFetch: typeof fetch = input.fetch ?? fetch;

	try {
		const response = await doFetch(url, {
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
			content?: Array<{ type?: string; text?: string; thinking?: string }>;
		};
		const textBlock = payload.content?.find((c) => c.type === "text");
		const content = textBlock?.text?.trim() ?? "";
		const reasoning = payload.content
			?.filter((block) => block.type === "thinking")
			.map((block) => block.thinking ?? block.text ?? "")
			.join("")
			.trim() ?? "";
		return { success: true, reply: content || reasoning || "(empty response)" };
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

export async function listAnthropicModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	const url = `${baseUrl}/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

	let response: Response;
	try {
		const doFetch: typeof fetch = input.fetch ?? fetch;
		response = await doFetch(url, {
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

export const anthropicProtocol: ProtocolAdapter = {
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
	resolveModel(profile, model, fetch?: ProviderFetch) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		const provider = createAnthropic({
			apiKey: apiKey || "not-needed",
			baseURL: endpoint || undefined,
			...(fetch ? { fetch } : {}),
		});
		return provider(model);
	},
	limitations: [],
	probe: probeAnthropicConnection,
	testChat: testAnthropicChat,
	listModels: listAnthropicModels,
};
