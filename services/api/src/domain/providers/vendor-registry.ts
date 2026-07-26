/**
 * @module vendor-registry
 *
 * Aggregator ("vendor") registry for OpenAI-compatible model-list responses.
 *
 * Different aggregators (OpenRouter, Together, Fireworks, xAI, ElectronHub, …)
 * all expose an OpenAI-compatible `/models` endpoint, but the JSON shape of each
 * model record differs wildly — vision lives under `architecture.modality` for
 * OpenRouter, under `supports_vision` for Fireworks, under `input_modalities`
 * for xAI, etc. Previously this was handled by three sites kept in sync by hand
 * through a string `providerKind`:
 *
 *   1. `detectProviderKind(baseUrl)`        — regex chain over 10 aggregators
 *   2. `extractCapabilities(kind, record)`  — 8-arm switch
 *   3. inline URL/filter switch in listOpenAiCompatModels
 *
 * Adding a vendor meant editing all three. This registry collapses them into a
 * single array: each `VendorAdapter` owns everything vendor-specific. Adding a
 * new aggregator is one array entry.
 *
 * Zero dependencies on the rest of the gateway — this module is pure data +
 * pure functions, so it cannot form an import cycle with provider-gateway.ts.
 */

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Capability flags extracted from a vendor's model record. All optional: a flag
 * is present only if the vendor's response actually signals it.
 */
export interface ProviderModelCapabilities {
	vision?: boolean;
	reasoning?: boolean;
	tools?: boolean;
	webSearch?: boolean;
	premium?: boolean;
}

/**
 * Raw model record from an OpenAI-compatible `/models` response. This is a
 * deliberately permissive union: every aggregator populates a different subset,
 * and `OpenAiModelRecord` is an honest reflection of that mess. Fields are
 * grouped by the vendor(s) that populate them in comments.
 */
export interface OpenAiModelRecord {
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

/** OpenAI-compatible `/models` envelope. Most vendors use `data`; xAI uses `models`. */
export interface OpenAiModelsResponse {
	data?: OpenAiModelRecord[];
	models?: OpenAiModelRecord[];
}

// ─── Vendor-agnostic helpers ────────────────────────────────────────

/**
 * Merge a vendor-specific capability reading with the generic inference.
 * Vendor-specific values win; inference only fills gaps.
 */
function mergeCapabilities(
	primary: ProviderModelCapabilities | undefined,
	fallback: ProviderModelCapabilities | undefined,
): ProviderModelCapabilities | undefined {
	if (!primary) return fallback;
	if (!fallback) return primary;
	const capabilities = {
		vision: primary.vision ?? fallback.vision,
		reasoning: primary.reasoning ?? fallback.reasoning,
		tools: primary.tools ?? fallback.tools,
		webSearch: primary.webSearch ?? fallback.webSearch,
		premium: primary.premium ?? fallback.premium,
	};
	return {
		...(capabilities.vision !== undefined ? { vision: capabilities.vision } : {}),
		...(capabilities.reasoning !== undefined ? { reasoning: capabilities.reasoning } : {}),
		...(capabilities.tools !== undefined ? { tools: capabilities.tools } : {}),
		...(capabilities.webSearch !== undefined ? { webSearch: capabilities.webSearch } : {}),
		...(capabilities.premium !== undefined ? { premium: capabilities.premium } : {}),
	};
}

function firstDefined(...values: Array<boolean | undefined>): boolean | undefined {
	return values.find((value) => value !== undefined);
}

function includesWhenPresent(values: string[] | undefined, value: string): boolean | undefined {
	return values === undefined ? undefined : values.includes(value);
}

/**
 * Best-effort capability inference from any record shape. Checks every known
 * field location across all aggregators. Returns undefined if nothing is set.
 */
export function inferCapabilities(record: OpenAiModelRecord): ProviderModelCapabilities | undefined {
	const capabilities: ProviderModelCapabilities = {
		vision: firstDefined(record.metadata?.vision, record.architecture?.modality?.includes("image"), record.capabilities?.vision, record.supports_vision, record.input_modalities?.includes("image"), record.modality?.includes("image")),
		reasoning: firstDefined(record.metadata?.reasoning, record.capabilities?.reasoning, record.supports_reasoning, includesWhenPresent(record.supported_parameters, "reasoning")),
		tools: firstDefined(record.metadata?.function_call, record.capabilities?.tools, record.capabilities?.tool_calling, record.capabilities?.tool_use, record.capabilities?.function_calling, record.supports_tools, includesWhenPresent(record.supported_parameters, "tools"), includesWhenPresent(record.supported_parameters, "tool_use"), includesWhenPresent(record.supported_parameters, "tool_calling"), includesWhenPresent(record.supported_parameters, "function_calling")),
		webSearch: firstDefined(record.metadata?.web_search, record.capabilities?.web_search),
		premium: record.premium_model,
	};
	return Object.values(capabilities).some((value) => value !== undefined) ? capabilities : undefined;
}

// ─── Registry ───────────────────────────────────────────────────────

export interface VendorAdapter {
	/** Stable id (matches the old `ProviderKind` string for log continuity). */
	id: string;
	/** Matches against the normalized base URL. First hit wins. */
	match: RegExp;
	/**
	 * Override the `/models` endpoint URL. Default falls back to
	 * `${baseUrl}/models` (the standard OpenAI-compat path).
	 */
	buildModelsUrl?(baseUrl: string): string;
	/**
	 * Extract raw records from the parsed JSON envelope. Default reads `data`.
	 * (xAI is the notable exception — it uses `models`.)
	 */
	extractRecords?(payload: OpenAiModelsResponse): OpenAiModelRecord[];
	/**
	 * Filter records before they are mapped to options. Default: passthrough.
	 * (ElectronHub uses this to keep only chat-capable endpoints.)
	 */
	filterRecords?(records: OpenAiModelRecord[]): OpenAiModelRecord[];
	/**
	 * Map a raw record to capability flags. Each vendor reads its own field
	 * layout, then merges with the vendor-agnostic `inferCapabilities`.
	 */
	extractCapabilities(record: OpenAiModelRecord): ProviderModelCapabilities | undefined;
}

// ─── Per-vendor adapters ────────────────────────────────────────────
//
// Order matters only for `match` disambiguation; in practice each regex is
// domain-specific and non-overlapping. `id` values match the legacy
// `ProviderKind` union so logs/error strings are unchanged.

const electronhubVendor: VendorAdapter = {
	id: "electronhub",
	match: /electronhub\.ai/,
	filterRecords: (records) => {
		// Only keep models that expose a chat-completions endpoint, and only
		// filter at all when at least one record declares its endpoints.
		const canFilter = records.some((record) => Array.isArray(record.endpoints));
		return canFilter
			? records.filter((record) => record.endpoints?.includes("/v1/chat/completions"))
			: records;
	},
	extractCapabilities: (record) => {
		const inferred = inferCapabilities(record);
		if (!record.metadata && record.premium_model === undefined) return inferred;
		return mergeCapabilities({
			vision: record.metadata?.vision,
			reasoning: record.metadata?.reasoning,
			tools: record.metadata?.function_call,
			webSearch: record.metadata?.web_search,
			premium: record.premium_model,
		}, inferred);
	},
};

const openrouterVendor: VendorAdapter = {
	id: "openrouter",
	match: /openrouter\.ai/,
	extractCapabilities: (record) => mergeCapabilities({
		vision: record.architecture?.modality?.includes("image"),
		reasoning: includesWhenPresent(record.supported_parameters, "reasoning"),
		tools: includesWhenPresent(record.supported_parameters, "tools"),
	}, inferCapabilities(record)),
};

const nanogptVendor: VendorAdapter = {
	id: "nanogpt",
	match: /nano-gpt\.com/,
	buildModelsUrl: (baseUrl) => `${baseUrl.replace(/\/v1$/, "")}/subscription/v1/models?detailed=true`,
	extractCapabilities: (record) => mergeCapabilities(
		record.capabilities ? {
			vision: record.capabilities.vision,
			reasoning: record.capabilities.reasoning,
			tools: record.capabilities.tool_calling,
		} : undefined,
		inferCapabilities(record),
	),
};

const togetherVendor: VendorAdapter = {
	id: "together",
	match: /together\.xyz/,
	extractCapabilities: (record) => mergeCapabilities(
		record.capabilities ? {
			vision: record.capabilities.vision,
			reasoning: record.capabilities.reasoning,
			tools: record.capabilities.tool_use ?? record.capabilities.function_calling,
			webSearch: record.capabilities.web_search,
		} : undefined,
		inferCapabilities(record),
	),
};

const deepinfraVendor: VendorAdapter = {
	id: "deepinfra",
	match: /deepinfra\.com/,
	buildModelsUrl: (baseUrl) => `${baseUrl}/models?filter=with_meta`,
	extractCapabilities: (record) => mergeCapabilities(
		(record.capabilities || record.modality) ? {
			vision: record.capabilities?.vision ?? record.modality?.includes("image"),
			reasoning: record.capabilities?.reasoning,
			tools: record.capabilities?.tool_calling,
		} : undefined,
		inferCapabilities(record),
	),
};

const fireworksVendor: VendorAdapter = {
	id: "fireworks",
	match: /fireworks\.ai/,
	extractCapabilities: (record) => mergeCapabilities(
		(record.supports_vision !== undefined || record.supports_tools !== undefined || record.supports_reasoning !== undefined) ? {
			vision: record.supports_vision,
			reasoning: record.supports_reasoning,
			tools: record.supports_tools,
		} : undefined,
		inferCapabilities(record),
	),
};

const chutesVendor: VendorAdapter = {
	id: "chutes",
	match: /chutes\.ai/,
	extractCapabilities: (record) => mergeCapabilities(
		(record.capabilities || record.input_modalities) ? {
			vision: record.capabilities?.vision ?? record.input_modalities?.includes("image"),
			reasoning: record.capabilities?.reasoning,
			tools: record.capabilities?.tools,
		} : undefined,
		inferCapabilities(record),
	),
};

const xaiVendor: VendorAdapter = {
	id: "xai",
	match: /api\.x\.ai|\.x\.ai/,
	buildModelsUrl: (baseUrl) => `${baseUrl.replace(/\/v1$/, "")}/v1/language-models`,
	// xAI returns { models: [...] } instead of { data: [...] }
	extractRecords: (payload) => (Array.isArray(payload.models) ? payload.models : []),
	extractCapabilities: (record) => mergeCapabilities(
		record.input_modalities ? {
			vision: record.input_modalities.includes("image"),
			tools: true,
		} : undefined,
		inferCapabilities(record),
	),
};

// groq & novita: detected by the old detectProviderKind but had no special
// extractCapabilities arm — they fall through to inference, identical to the
// generic adapter. Listed explicitly so the registry documents which
// aggregators we recognize, even when they need no special handling.
const groqVendor: VendorAdapter = {
	id: "groq",
	match: /groq\.com/,
	extractCapabilities: inferCapabilities,
};

const novitaVendor: VendorAdapter = {
	id: "novita",
	match: /novita\.ai/,
	extractCapabilities: inferCapabilities,
};

/** Fallback for any OpenAI-compatible endpoint we don't recognize explicitly. */
const genericVendor: VendorAdapter = {
	id: "generic",
	// never matches — only used as the fallback
	match: /$^/,
	extractCapabilities: inferCapabilities,
};

/** Ordered list of known aggregators. `resolveVendor` returns the first match. */
const vendors: VendorAdapter[] = [
	electronhubVendor,
	openrouterVendor,
	nanogptVendor,
	togetherVendor,
	deepinfraVendor,
	fireworksVendor,
	chutesVendor,
	xaiVendor,
	groqVendor,
	novitaVendor,
];

/**
 * Resolve the vendor adapter for a base URL. Returns `genericVendor` when no
 * known aggregator matches. Replaces `detectProviderKind()`.
 */
export function resolveVendor(baseUrl: string): VendorAdapter {
	return vendors.find((vendor) => vendor.match.test(baseUrl)) ?? genericVendor;
}

/**
 * The default `/models` URL builder, used when a vendor does not override
 * `buildModelsUrl`. Exported so the gateway's fallback path can call it.
 */
export function buildDefaultModelsUrl(baseUrl: string): string {
	return `${baseUrl}/models`;
}
