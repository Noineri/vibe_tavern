/**
 * Native schema-constrained generation for interactive-experience model
 * effects in ACTION mode (INTERACTIVE_ENGINE_EXPANSION, fix step 1c).
 *
 * When a model seat must choose among legal actions, the default path is a
 * plain text generation whose JSON adherence rests on prompt wording (the host
 * protocol asks for `{"actionId", "args"}` and `validateOutput` parses the
 * free text). This module adds the native alternative: synthesize a JSON Schema
 * from the legal action descriptors and run the call through the AI SDK
 * `generateObject` with `mode: "json"`, so the reply IS a JSON object by
 * construction.
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
import { generateObject, jsonSchema } from "ai";

import type {
	AssemblePromptResponse,
	ExperienceActionDescriptor,
	StoredProviderProfileRecord,
} from "@vibe-tavern/domain";

import { buildSamplerConfig } from "../../infrastructure/ai/sampler-mapper.js";
import { resolveProviderFetchForProfile } from "../providers/provider-fetch-factory.js";
import { resolveModel, toSdkMessages } from "../../infrastructure/ai/provider-executor-utils.js";

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

/** A bare JSON-Schema object node (the subset the descriptors + synthesis emit). */
type SchemaNode = Record<string, unknown>;

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
): SchemaNode {
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
	const variants: SchemaNode[] = legalActions.map((a) => ({
		type: "object",
		properties: {
			actionId: { type: "string", enum: [a.type] },
			...(a.payloadSchema !== undefined ? { args: a.payloadSchema as SchemaNode } : {}),
		},
		required: ["actionId"],
		additionalProperties: false,
	}));
	return { oneOf: variants };
}

// ─── Prompt flattening ───────────────────────────────────────────────────────

/**
 * Flatten the assembled experience prompt into generateObject's `system` +
 * `prompt` pair. `generateObject` does not take the SDK message array the
 * text executor uses, and the experience prompt is plain prose (host protocol
 * + overrides + character/persona + context bundle + private view — no tools,
 * no attachments), so concatenation loses nothing. System messages join as the
 * system; everything else joins in order as the user prompt.
 */
function flattenPrompt(
	prompt: AssemblePromptResponse,
): { system: string | undefined; user: string } {
	const messages = toSdkMessages(prompt);
	const systemParts: string[] = [];
	const userParts: string[] = [];
	for (const m of messages) {
		const text = typeof m.content === "string" ? m.content : "";
		if (text.length === 0) continue;
		if (m.role === "system") systemParts.push(text);
		else userParts.push(text);
	}
	return {
		system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
		user: userParts.join("\n\n"),
	};
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
		const { system, user } = flattenPrompt(input.prompt);
		const schema = synthesizeActionChoiceSchema(input.legalActions);
		const sampler = buildSamplerConfig(input.profile);

		const result = await generateObject({
			model,
			// `jsonSchema(...)` (not a zod schema) selects generic JSON-Schema
			// structured output — the provider-native json/response_format path.
			schema: jsonSchema(schema),
			...(system !== undefined ? { system } : {}),
			prompt: user,
			abortSignal: input.signal,
			...(sampler.temperature !== undefined ? { temperature: sampler.temperature } : {}),
			...(sampler.maxOutputTokens !== undefined ? { maxOutputTokens: sampler.maxOutputTokens } : {}),
		});
		return { kind: "structured", text: JSON.stringify(result.object) };
	} catch (e) {
		if (input.signal?.aborted) throw e;
		const message =
			e !== null && typeof e === "object" && typeof (e as { message?: unknown }).message === "string"
				? (e as { message: string }).message
				: String(e);
		return { kind: "unsupported", reason: message };
	}
}
