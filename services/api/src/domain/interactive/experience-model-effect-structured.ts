/**
 * Native schema-constrained generation for interactive-experience model
 * effects in ACTION mode (INTERACTIVE_ENGINE_EXPANSION, fix step 1c).
 *
 * When a model seat must choose among legal actions, the default path is a
 * plain text generation whose JSON adherence rests on prompt wording (the host
 * protocol asks for `{"actionId", "args"}` and `validateOutput` parses the
 * free text). This module adds the native alternative: synthesize a JSON Schema
 * from the legal action descriptors and run the call through the AI SDK
 * `generateText` with `Output.object`, so the provider receives the response
 * schema and the SDK parses the reply as JSON.
 *
 * Division of authority (deliberate): the generated object is stringified and
 * handed back as TEXT — the caller runs it through the exact same
 * `validateOutput` + payload-subset validator as a free-text reply. The native
 * schema is a generation-quality aid, never the validation authority; the
 * kernel's subset rules stay the single source of truth, so a drift between
 * the synthesized schema and the kernel subset can never admit an illegal move.
 *
 * Failure semantics: ANY error from the structured call (provider rejects
 * `response_format`, network, unsupported model…) returns `{ kind: "unsupported" }`
 * and the caller falls back to the existing text path. There is no retry loop
 * and no double-billing beyond the one failed attempt.
 *
 * Isolation: this module lives in the interactive domain but reaches the shared
 * AI infrastructure (`resolveModel`, provider fetch, sampler config) the same
 * way the generic executor does. It performs no persistence and no store
 * access; the injectable seam in the model-effect service keeps tests
 * provider-free.
 */
import { generateText, jsonSchema, Output, type JSONSchema7 } from "ai";
import { normalizeProviderType } from "@vibe-tavern/domain";

import type {
	AssemblePromptResponse,
	ExperienceActionDescriptor,
	StoredProviderProfileRecord,
} from "@vibe-tavern/domain";

import { buildSamplerConfig } from "../../infrastructure/ai/sampler-mapper.js";
import { resolveProviderFetchForProfile } from "../providers/provider-fetch-factory.js";
import { prepareSdkMessages, resolveModel, toSdkMessages } from "../../infrastructure/ai/provider-executor-utils.js";

// ─── Input / result types ────────────────────────────────────────────────────

/** One structured action-choice attempt. Mirrors the `execute` seam shape. */
export interface StructuredActionChoiceInput {
	profile: StoredProviderProfileRecord;
	model: string;
	prompt: AssemblePromptResponse;
	legalActions: readonly ExperienceActionDescriptor[];
	signal?: AbortSignal;
}

/**
 * The outcome of one structured attempt. `structured` carries the generated
 * object serialized as JSON text (ready for `validateOutput`); `unsupported`
 * means "fall back to the text path" for any reason.
 */
export type StructuredActionChoiceResult =
	| { kind: "structured"; text: string }
	| { kind: "unsupported"; reason: string };

// ─── Schema synthesis ────────────────────────────────────────────────────────

/**
 * Synthesize the response schema for an action-mode choice from the legal
 * descriptors. Two shapes:
 *  - no descriptor declares a `payloadSchema` → one flat object, `actionId`
 *    constrained to the legal types, no other keys;
 *  - at least one declares a `payloadSchema` → a `oneOf` of per-action
 *    variants, each binding `actionId` to its single type and embedding that
 *    descriptor's `payloadSchema` as the `args` sub-schema. Descriptors without
 *    a schema contribute a variant without `args` (their bare-action reply
 *    stays valid, mirroring `validateOutput`'s bare-type acceptance).
 *
 * The synthesized schema uses ONLY keywords from the kernel subset vocabulary
 * (`experience-payload-schema.ts`) plus `oneOf` for the discrimination — the
 * same vocabulary any provider's JSON mode understands.
 */
export function synthesizeActionChoiceSchema(
	legalActions: readonly ExperienceActionDescriptor[],
): JSONSchema7 {
	const legalTypes = legalActions.map((a) => a.type);
	const withSchema = legalActions.filter((a) => a.payloadSchema !== undefined);
	if (withSchema.length === 0) {
		return {
			type: "object",
			properties: {
				actionId: { type: "string", enum: legalTypes },
			},
			required: ["actionId"],
			additionalProperties: false,
		};
	}
	const variants: JSONSchema7[] = legalActions.map((a) => ({
		type: "object",
		properties: {
			actionId: { type: "string", enum: [a.type] },
			...(a.payloadSchema !== undefined ? { args: a.payloadSchema as JSONSchema7 } : {}),
		},
		required: ["actionId"],
		additionalProperties: false,
	}));
	return { oneOf: variants };
}


// ─── The structured call ─────────────────────────────────────────────────────

/**
 * Attempt one native schema-constrained action choice. Returns the generated
 * object serialized as JSON text on success; any failure maps to
 * `unsupported` (the caller's text path is the fallback — see the module doc).
 */
export async function generateStructuredActionChoice(
	input: StructuredActionChoiceInput,
): Promise<StructuredActionChoiceResult> {
	try {
		const providerFetch = await resolveProviderFetchForProfile(input.profile);
		const model = resolveModel(input.profile, input.model, undefined, providerFetch);
		const { conversationMessages } = await prepareSdkMessages(toSdkMessages(input.prompt), {
			providerType: normalizeProviderType(input.profile.providerPreset),
		});
		const schema = synthesizeActionChoiceSchema(input.legalActions);
		const sampler = buildSamplerConfig(input.profile, input.model);

		const result = await generateText({
			model,
			output: Output.object({ schema: jsonSchema(schema) }),
			messages: conversationMessages,
			allowSystemInMessages: true,
			abortSignal: input.signal,
			...(sampler.temperature !== undefined ? { temperature: sampler.temperature } : {}),
			...(sampler.maxOutputTokens !== undefined ? { maxOutputTokens: sampler.maxOutputTokens } : {}),
		});
		return { kind: "structured", text: JSON.stringify(result.output) };
	} catch (error) {
		if (input.signal?.aborted) throw error;
		return { kind: "unsupported", reason: error instanceof Error ? error.message : String(error) };
	}
}
