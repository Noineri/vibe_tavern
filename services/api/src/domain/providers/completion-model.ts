/**
 * @module providers/completion-model
 *
 * The raw text-completion model for the OpenAI-compat-backed protocols
 * (LOCAL_SUPPORT_PLAN LS-2b/LS-2c): served when a profile's `generationMode`
 * is `"completion"` and the protocol carries the `textCompletion` capability.
 *
 * The flat prompt STRING is built by the serialization seam
 * (`completion-prompt.ts` — serializeCompletionPrompt) at REQUEST time, from
 * the standardized messages the executors keep sending (the executor pipeline
 * — mapped stream, finish promises, abort handling, SSE — is reused verbatim;
 * this is the same boundary the chat path runs on).
 *
 * Mechanism (verified against the installed @ai-sdk/openai-compatible@3):
 * `streamText`/`generateText` cannot deliver a raw completion string — a
 * plain `prompt` gets user-wrapped and re-rendered by the completion model's
 * built-in converter (hardcoded lowercase labels + injected `\nuser:` stop +
 * throws on mid-conversation system/tool messages), and the completion model
 * applies NO `transformRequestBody` (that hook exists on the chat model only).
 * So the completion model here is WRAPPED:
 *
 *   1. the wrapper serializes the standardized prompt to the flat string and
 *      calls the underlying SDK completion model with a SANITIZED prompt
 *      (single empty user message) so the built-in conversion cannot throw;
 *   2. a splicing custom fetch — the ONE hook both doGenerate and doStream
 *      honor — rewrites the outgoing JSON body: the seam's flat string
 *      replaces the converted `prompt`, and the converter's injected
 *      `\nuser:` stop artifact is stripped (the profile's own stop sequences
 *      are preserved — they ride `stop` from the profile settings).
 *
 * One model instance per generation call (resolveModel runs per call), so the
 * shared pending-prompt holder is single-flight by construction.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { GENERATION_MODE, type GenerationMode } from "@vibe-tavern/domain";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import { serializeCompletionPrompt } from "./completion-prompt.js";

/**
 * The stop sequence the SDK's built-in completion converter injects on its own
 * (`convertToOpenAICompatibleCompletionPrompt` → stopSequences `["\nuser:"]`).
 * It pairs with THAT converter's lowercase labels; the seam's template owns
 * the boundary markers, so the artifact is stripped from the outgoing body.
 */
const BUILTIN_CONVERTER_STOP = "\nuser:";

/** The part of {@link LanguageModelV4} the flat-prompt wrapper delegates on. */
interface FlatPromptBase {
	specificationVersion: LanguageModelV4["specificationVersion"];
	provider: LanguageModelV4["provider"];
	modelId: LanguageModelV4["modelId"];
	supportedUrls: LanguageModelV4["supportedUrls"];
	doGenerate(callOptions: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult>;
	doStream(callOptions: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4StreamResult>;
}

/** Holder the wrapper (writer) and the splicing fetch (reader) share. */
interface PendingPromptHolder {
	prompt: string | null;
}

/** A single empty user message — a conversion input the SDK cannot throw on. */
const SANITIZED_PROMPT: LanguageModelV4CallOptions["prompt"] = [
	{ role: "user", content: [{ type: "text", text: "" }] },
];

/**
 * Wrap an SDK completion model so its outgoing request body carries the SEAM's
 * flat prompt string instead of the built-in conversion's output.
 */
function withFlatPrompt(base: FlatPromptBase, pending: PendingPromptHolder): LanguageModelV4 {
	const run = async <R>(
		callOptions: LanguageModelV4CallOptions,
		op: (o: LanguageModelV4CallOptions) => PromiseLike<R>,
	): Promise<R> => {
		pending.prompt = serializeCompletionPrompt(callOptions.prompt);
		try {
			return await op({ ...callOptions, prompt: SANITIZED_PROMPT });
		} finally {
			pending.prompt = null;
		}
	};

	return {
		specificationVersion: base.specificationVersion,
		provider: base.provider,
		modelId: base.modelId,
		supportedUrls: base.supportedUrls,
		doGenerate: (callOptions) => run(callOptions, (o) => base.doGenerate(o)),
		doStream: (callOptions) => run(callOptions, (o) => base.doStream(o)),
	};
}

/**
 * Splice the pending flat prompt into the outgoing JSON request body. A JSON
 * body that fails to parse is passed through untouched — the SDK's own error
 * handling owns malformed request bodies, not this hook.
 */
function createSplicingFetch(pending: PendingPromptHolder, transport: ProviderFetch): ProviderFetch {
	const splicing: ProviderFetch = (input, init) => {
		const flat = pending.prompt;
		if (flat === null || typeof init?.body !== "string") return transport(input, init);
		try {
			const args = JSON.parse(init.body) as Record<string, unknown>;
			const stop = Array.isArray(args.stop) ? args.stop.filter((s) => s !== BUILTIN_CONVERTER_STOP) : args.stop;
			const filteredStop = Array.isArray(stop) && stop.length > 0 ? stop : undefined;
			const body = JSON.stringify({
				...args,
				prompt: flat,
				...(filteredStop !== undefined ? { stop: filteredStop } : {}),
			});
			return transport(input, { ...init, body });
		} catch (error) {
			// Non-JSON body (never expected from the SDK): forward verbatim and
			// let the transport produce the authoritative error. Never swallow.
			throw error instanceof Error ? error : new Error(String(error));
		}
	};
	// `typeof fetch` carries Bun's namespace `preconnect`; keep the assignment
	// type-compatible without opening a connection (same pattern as the
	// proxied-fetch wrapper in provider-fetch-factory).
	splicing.preconnect = () => {};
	return splicing;
}

/** Settings shared by the chat and completion providers of one protocol. */
export interface OpenAiCompatModelOptions {
	/** Provider name passed to the SDK factory (e.g. "openai_compat", "llamacpp"). */
	name: string;
	baseURL: string;
	apiKey: string | null;
	model: string;
	/** Optional proxy-aware fetch (profile's proxy policy). */
	fetch?: ProviderFetch;
	/** Whether the CHAT model declares structured-outputs support (openai_compat
	 *  declares true — many aggregators support response_format). The raw
	 *  completion model ignores it (JSON response format is unsupported there). */
	supportsStructuredOutputs?: boolean;
	/** Profile generation mode — `completion` serves the raw completion model. */
	generationMode?: GenerationMode;
}

/**
 * Resolve the language model for an OpenAI-compat-backed protocol: the chat
 * model by default, the flat-prompt raw completion model when the profile's
 * generation mode is `completion` (silent, fully backward-compatible flip —
 * absent/`chat` mode resolves chat exactly as before LS-2).
 */
export function resolveOpenAiCompatLanguageModel(options: OpenAiCompatModelOptions): LanguageModelV4 {
	const shared = {
		name: options.name,
		apiKey: options.apiKey || "not-needed",
		baseURL: options.baseURL,
		...(options.supportsStructuredOutputs ? { supportsStructuredOutputs: true } : {}),
	};

	if (options.generationMode !== GENERATION_MODE.completion) {
		return createOpenAICompatible({ ...shared, ...(options.fetch ? { fetch: options.fetch } : {}) }).chatModel(options.model);
	}

	// Holder shared by the wrapper (writer, at request-assembly time) and the
	// splicing fetch (reader, at request-send time). Single-flight: one model
	// instance is created per resolveModel call, one generation per instance.
	const pending: PendingPromptHolder = { prompt: null };
	const splicingFetch: ProviderFetch = createSplicingFetch(pending, options.fetch ?? fetch);
	const completionProvider = createOpenAICompatible({ ...shared, fetch: splicingFetch });

	return withFlatPrompt(completionProvider.completionModel(options.model), pending);
}
