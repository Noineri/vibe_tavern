/**
 * @module providers/provider-transport
 *
 * Shared transport-level helpers + types used by the protocol registry's
 * probe/test/list operations and by the gateway's public entry points.
 *
 * Pure plumbing (URL normalization, header building, fetch error wrapping,
 * response extraction). No protocol dispatch lives here — that is the
 * registry's job. Extracted from provider-gateway.ts so the registry can
 * import these without a circular dependency on the gateway.
 *
 * Refactor plan: `CODE_REVIEW_REFACTOR_PLAN.md` §5.3.2.
 */

import type { ProviderModelCapabilities } from "./vendor-registry.js";

// ---------------------------------------------------------------------------
// Operation timeouts
// ---------------------------------------------------------------------------

export const PROBE_TIMEOUT_MS = 5_000;
export const MODEL_LIST_TIMEOUT_MS = 10_000;
export const TEST_CHAT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Transport types
// ---------------------------------------------------------------------------

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

export interface ProviderProbeResult {
	success: boolean;
	error?: string;
	modelCount?: number;
}

export interface TestChatResult {
	success: boolean;
	reply?: string;
	error?: string;
}

export interface OpenAiChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | Array<{ type?: string; text?: string }>;
		};
		text?: string;
	}>;
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/** Strip a trailing `/chat/completions` and trailing slashes from a base URL. */
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

/** Strip + append `/v1` for local OpenAI-compat servers (llama.cpp / unsloth). */
export function normalizeLocalOpenAiCompatibleBaseUrl(baseUrl: string): string {
	const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
	if (!normalized) return "";
	if (normalized.endsWith("/v1")) return normalized;
	if (normalized.endsWith("/api")) return `${normalized.slice(0, -"/api".length)}/v1`;
	return `${normalized}/v1`;
}

/** Strip `/api/v1` or `/api` from a KoboldCPP base URL. */
export function normalizeKoboldCppBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) return "";
	if (normalized.endsWith("/api/v1")) normalized = normalized.slice(0, -"/api/v1".length);
	else if (normalized.endsWith("/api")) normalized = normalized.slice(0, -"/api".length);
	return normalized;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export function buildHeaders(apiKey: string, withBody = false): HeadersInit {
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

export function tryParseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

/** Extract the textual content from an OpenAI-compat chat completion choice. */
export function extractChoiceContent(
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

/** Wrap a fetch error as a timeout or generic network error. */
export function wrapProviderNetworkError(
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
