/**
 * @module providers/google-interactions-adapter
 *
 * The Google Gemini Interactions protocol (`POST /v1beta/interactions`) —
 * Google's newer agent-flavoured surface over the same Generative Language
 * API. Model resolution goes through `@ai-sdk/google`'s
 * `google.interactions()` factory (a `GoogleInteractionsLanguageModel`),
 * which handles request assembly, SSE streaming, reasoning parts, and
 * signature round-tripping.
 *
 * Probe / list-models reuse the classic Google REST surface (`/v1beta/models`)
 * from {@link module:providers/google-adapter} — the two surfaces share the
 * endpoint, auth, and model catalogue, so duplicating those operations here
 * would be a copy-paste fork. Test-chat does NOT reuse `testGoogleChat`:
 * interactions-only models reject `:generateContent`, so this adapter owns a
 * native test against `/v1beta/interactions`.
 *
 * Stateless by design: the app's prompt pipeline sends the full assembled
 * context every turn, so `previousInteractionId` chaining is intentionally
 * not used.
 */

import { createGoogle } from "@ai-sdk/google";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter } from "./protocol-types.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import {
	TEST_CHAT_TIMEOUT_MS,
	type ProviderConnectionInput,
	type TestChatResult,
} from "./provider-transport.js";
import {
	probeGoogleConnection,
	listGoogleModels,
} from "./google-adapter.js";

/**
 * Test chat against the Interactions surface itself. Must NOT reuse
 * `testGoogleChat` — it POSTs to `:generateContent`, which interactions-only
 * models (the 3.5/3.6/3.7 flash series) reject with
 * `400 "This model only supports Interactions API."`.
 */
export async function testGoogleInteractionsChat(input: ProviderConnectionInput): Promise<TestChatResult> {
	const baseUrl = (input.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl)
		return { success: false, error: "Provider endpoint is required." };
	if (!input.model) return { success: false, error: "Model is required." };

	const url = `${baseUrl}/v1beta/interactions?key=${input.apiKey}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);
	const doFetch: typeof fetch = input.fetch ?? fetch;

	try {
		const response = await doFetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// No max_output_tokens cap: thinking models burn the budget on
			// thought tokens first, and a capped test returns `incomplete` with
			// zero model_output text.
			body: JSON.stringify({ model: input.model, input: "Hi" }),
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
			status?: string;
			steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
		};
		const text = (payload.steps ?? [])
			.filter((step) => step.type === "model_output")
			.flatMap((step) => step.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("")
			.trim();
		return { success: true, reply: text || "(empty response)" };
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

export const googleInteractionsProtocol: ProtocolAdapter = {
	id: PROVIDER_TYPE.googleInteractions,
	capabilities: {
		// Same surface as the classic google protocol: the SDK model implements
		// both doGenerate and doStream against /v1beta/interactions.
		nonStreamGeneration: true,
		abortSignal: true,
		streaming: true,
		prefill: false,
		logitBias: false,
		samplers: SAMPLER_SETS.minimal_reasoning,
		textCompletion: false,
	},
	resolveModel(profile, model, fetch?: ProviderFetch) {
		const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
		const apiKey = profile.apiKey ?? "";
		// The SDK defaults to https://generativelanguage.googleapis.com/v1beta
		// and appends /interactions itself. Only override baseURL if the user
		// explicitly changed it (same convention as the google adapter).
		const defaultGoogleBase = "https://generativelanguage.googleapis.com";
		const googleBaseUrl = (!endpoint || endpoint === defaultGoogleBase)
			? undefined
			: endpoint;
		const provider = createGoogle({
			apiKey: apiKey || "not-needed",
			baseURL: googleBaseUrl,
			...(fetch ? { fetch } : {}),
		});
		return provider.interactions(model);
	},
	limitations: [
		"Stateless mode: the full conversation context is sent with every turn (no server-side interaction chaining).",
		"Interactions-only models and deep-research agents are not exposed through the chat UI.",
	],
	probe: probeGoogleConnection,
	testChat: testGoogleInteractionsChat,
	listModels: listGoogleModels,
};
