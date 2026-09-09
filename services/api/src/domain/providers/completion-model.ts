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
import { GENERATION_MODE, type GenerationMode, log } from "@vibe-tavern/domain";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import {
	serializeCompletionPrompt,
	type CompletionFormatTemplate,
} from "./completion-prompt.js";

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

/**
 * The template SOURCE for the flat string (LOCAL_SUPPORT_PLAN LS-3b/c):
 * - `manual` — the preset's manual sequences (Generation Format tab), rendered
 *   by the serialization seam.
 * - `auto`   — resolved per provider capability: the backend's own chat
 *   template when the protocol exposes one (llama-server `/apply-template`,
 *   verified live on b10786), else the documented default template.
 * Absent behaves like `auto` (pre-LS-3 behavior).
 */
export type CompletionFormatSource =
	| { kind: "manual"; template: CompletionFormatTemplate }
	| { kind: "auto" };

/** Timeout for the backend template render (LS-3c) — the render is a local
 *  Jinja evaluation; anything slower is a stuck server, not a slow model. */
const APPLY_TEMPLATE_TIMEOUT_MS = 10_000;

/** A single empty user message — a conversion input the SDK cannot throw on. */
const SANITIZED_PROMPT: LanguageModelV4CallOptions["prompt"] = [
	{ role: "user", content: [{ type: "text", text: "" }] },
];

/** Map a standardized (V4) prompt to the messages shape `/apply-template`
 *  consumes. Same channel rules as the seam: tool messages and non-text parts
 *  are skipped (no tool channel in raw completion). */
function toApplyTemplateMessages(prompt: LanguageModelV4CallOptions["prompt"]): Array<{ role: string; content: string }> {
	const messages: Array<{ role: string; content: string }> = [];
	for (const message of prompt) {
		if (message.role === "tool") continue;
		const content =
			message.role === "system"
				? message.content
				: message.content
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => (part as { text: string }).text)
					.join("");
		messages.push({ role: message.role, content });
	}
	return messages;
}

/**
 * Render the flat prompt through the BACKEND's own chat template (LS-3c):
 * llama-server's `POST /apply-template` offloads the model's Jinja template
 * (verified live on b10786, 2026-09-09 — multi-turn and the trailing
 * assistant continuation render exactly). A failure falls back to the
 * documented default template with a warning — a template hiccup must not
 * take a generation down when the default glue is one keystroke away.
 */
async function renderBackendTemplate(
	prompt: LanguageModelV4CallOptions["prompt"],
	applyTemplateUrl: string,
	transport: ProviderFetch,
): Promise<string> {
	try {
		const response = await transport(applyTemplateUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ messages: toApplyTemplateMessages(prompt) }),
			signal: AbortSignal.timeout(APPLY_TEMPLATE_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`apply-template failed (${response.status})`);
		}
		const payload = (await response.json()) as { prompt?: unknown };
		if (typeof payload.prompt !== "string") {
			throw new Error("apply-template: unexpected response shape (missing prompt string).");
		}
		return payload.prompt;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		log.tag("completion").warn("backend template render failed (%s) — falling back to the default template", detail);
		return serializeCompletionPrompt(prompt);
	}
}

/** Resolve the flat string for a call per the template source (LS-3b/c):
 *  manual preset sequences → seam renderer; auto → backend template when the
 *  protocol exposes one, else the documented default template. */
async function renderFlatPrompt(
	prompt: LanguageModelV4CallOptions["prompt"],
	format: CompletionFormatSource | undefined,
	applyTemplateUrl: string | undefined,
	transport: ProviderFetch,
): Promise<string> {
	if (format?.kind === "manual") {
		return serializeCompletionPrompt(prompt, { template: format.template });
	}
	if (applyTemplateUrl) {
		return renderBackendTemplate(prompt, applyTemplateUrl, transport);
	}
	return serializeCompletionPrompt(prompt);
}

/**
 * Wrap an SDK completion model so its outgoing request body carries the SEAM's
 * flat prompt string instead of the built-in conversion's output.
 */
function withFlatPrompt(
	base: FlatPromptBase,
	pending: PendingPromptHolder,
	format: CompletionFormatSource | undefined,
	applyTemplateUrl: string | undefined,
	transport: ProviderFetch,
): LanguageModelV4 {
	const run = async <R>(
		callOptions: LanguageModelV4CallOptions,
		op: (o: LanguageModelV4CallOptions) => PromiseLike<R>,
	): Promise<R> => {
		pending.prompt = await renderFlatPrompt(callOptions.prompt, format, applyTemplateUrl, transport);
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
	/** LS-3b/c: the preset's generation format, threaded from assembly through
	 *  the executor. `manual` renders the preset's sequences; `auto` (or absent)
	 *  uses the backend template when {@link applyTemplateUrl} is set, else the
	 *  documented default template. */
	completionFormat?: CompletionFormatSource;
	/** LS-3c: the backend's template-application endpoint (llama-server's
	 *  `POST /apply-template`). Set only when the protocol's `backendTemplate`
	 *  capability is on AND the profile runs TC mode. */
	applyTemplateUrl?: string;
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

	return withFlatPrompt(
		completionProvider.completionModel(options.model),
		pending,
		options.completionFormat,
		options.applyTemplateUrl,
		options.fetch ?? fetch,
	);
}
