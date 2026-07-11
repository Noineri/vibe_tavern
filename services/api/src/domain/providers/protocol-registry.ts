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

import {
	PROVIDER_TYPE,
	SAMPLER_SETS,
} from "@vibe-tavern/domain";
import type { ProviderType } from "@vibe-tavern/domain";
import { providerError } from "../../shared/errors.js";
import { createReasoningAwareFetch } from "./openai-reasoning-fetch.js";
import { createKoboldCppModel } from "./koboldcpp-adapter.js";
import { createOllamaModel } from "./ollama-adapter.js";
import { openaiCompatProtocol } from "./openai-compat-adapter.js";
import { llamaCppProtocol } from "./llamacpp-adapter.js";
import { unslothProtocol } from "./unsloth-adapter.js";
import { googleProtocol } from "./google-adapter.js";
import { anthropicProtocol } from "./anthropic-adapter.js";
import {
	PROBE_TIMEOUT_MS,
	MODEL_LIST_TIMEOUT_MS,
	TEST_CHAT_TIMEOUT_MS,
	normalizeLocalOpenAiCompatibleBaseUrl,
	normalizeKoboldCppBaseUrl,
	buildHeaders,
	tryParseUrl,
	wrapProviderNetworkError,
	type ProviderConnectionInput,
	type ProviderModelOption,
	type ProviderProbeResult,
	type TestChatResult,
} from "./provider-transport.js";
import type {
	ProtocolAdapter,
	ProviderCapabilityFlags,
	ProviderProfileInput,
	ProbeInput,
	ListModelsInput,
} from "./protocol-types.js";

// Protocol contracts (ProviderCapabilityFlags / ProtocolAdapter / etc.) live in
// protocol-types.ts now — extracted so per-protocol adapter modules can import
// their own contract without the registry importing them back (a circular dep).
// Re-exported here for public compatibility; the registry was their historical home.
export type {
	ProviderCapabilityFlags,
	ProviderProfileInput,
	ProbeInput,
	ListModelsInput,
	ProtocolAdapter,
} from "./protocol-types.js";

// ===========================================================================
// Per-protocol operations (probe / testChat / listModels)
//
// Lifted verbatim from the historical provider-gateway.ts. Each protocol owns
// its HTTP shape here. Shared helpers live in provider-transport.ts.
// ===========================================================================

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
 * Derived capability map (keyed by provider type). The canonical capability
 * surface — consumers read it directly (the legacy `PROVIDER_CAPABILITIES`
 * alias and its compatibility shim were removed once all callers reached the
 * registry directly).
 */
export const PROTOCOL_CAPABILITIES: Record<ProviderType, ProviderCapabilityFlags> =
	Object.fromEntries(
		Object.values(protocols).map((adapter) => [adapter.id, adapter.capabilities]),
	) as Record<ProviderType, ProviderCapabilityFlags>;
