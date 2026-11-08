/**
 * Typed fixture builders for the provider-boundary cluster (Wave B step 6c —
 * TYPE_SAFETY_CAST_DEBT_REPORT): the suites that double the PROVIDER boundary
 * and read its adjacent wire rows — the director/sidechat streaming suites,
 * the review-outcome replays, the STT executor pins, the provider test-chat
 * routes, and the effective-profile resolver.
 *
 * Every fixture here used to reach its consumer through an `as unknown as …`
 * erasure (the DK-9 class: a partial literal silently cast to a full type,
 * hiding which members exist and which required fields were missing). The
 * builders take the narrow subset the tests actually exercise, return the
 * consumer's REAL type (via `strictTestDouble` — unprovided members throw on
 * access), and fill inert defaults only where no test reads the field (or
 * where today's erased literal deliberately read `undefined`).
 *
 * Builders are infrastructure: they land with this batch's consumers and
 * later step-6 batches may import and extend them.
 */
import { z } from "zod";
import {
	streamText,
	type FinishReason,
	type LanguageModelUsage,
	type TextStreamPart,
	type ToolSet,
} from "ai";
import type { ProxyProfile, ProviderProfile } from "@vibe-tavern/db";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import { makeProviderProfileRow } from "./copilot-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

// ─── The injected streamText seam (sidechat + experience-copilot streams) ────

/** The real streamText options/return, instantiated at the SDK's generic
 *  constraints — the exact shapes the generic loop hands the double. */
export type StreamTextCall = Parameters<typeof streamText>[0];
export type StreamTextResultShape = ReturnType<typeof streamText>;
/** The stream-part union the loop's mapper (`createMappedStream`) walks. */
export type StreamTextPart = TextStreamPart<ToolSet>;

/** What a fake turn provides: the stream parts and (optionally) the finish
 *  metadata. Anything omitted rides the builder's inert defaults — the same
 *  values the old erased fakes produced (`finishReason: "stop"`, an idle
 *  usage record whose every token count is `undefined`, which the loop's
 *  estimator treats exactly like the old absent usage). */
export interface FakeStreamTextTurn {
	parts: StreamTextPart[];
	finishReason?: FinishReason;
	usage?: LanguageModelUsage;
}

/** The usage record the SDK's result type requires but these suites never
 *  populate: every count `undefined` — `mapFinish`/`buildContextMetrics`
 *  branch on the NUMBERS, so this is the typed twin of the old
 *  `usage: Promise.resolve(undefined)` fakes (the metrics stay "estimate",
 *  and the JSON'd finish event drops the undefined fields identically). */
const IDLE_USAGE: LanguageModelUsage = {
	inputTokens: undefined,
	inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
	outputTokens: undefined,
	outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
	totalTokens: undefined,
};

/** The fake turn's parts as the SDK's stream member: a real `ReadableStream`
 *  over the parts (bun's web streams are async-iterable, which is what makes
 *  the value satisfy the SDK's `AsyncIterable & ReadableStream` member type
 *  that the loop's `createMappedStream(result.stream)` walks). */
function partsToStream(parts: StreamTextPart[]): ReadableStream<StreamTextPart> {
	return new ReadableStream<StreamTextPart>({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

/**
 * THE one typed double for the deps' injectable `streamText` (`typeof
 * streamText` in SidechatStreamDeps / ExperienceCopilotStreamDeps /
 * AgentStreamDeps). Every suite used to erase its fake through `as unknown as
 * SidechatStreamDeps["streamText"]` — the SDK's signature is generic over
 * <TOOLS, RUNTIME_CONTEXT, OUTPUT> (and its `stream` member is an
 * `AsyncIterableStream`), which a literal fake cannot represent.
 *
 * This seam is the batch's ONE documented plain-cast site, constructed the
 * same way as `strictTestDouble`'s own definition-site cast: the compiler
 * cannot express the generic signature's mirror (TS provides no way to
 * re-emit a generic function type's parameters, and the constraint types
 * (`Context`, `Output`) are not exported by the `ai` package), so the
 * non-generic wrapper narrows through a single `as typeof streamText` HERE —
 * backed by a runtime invariant the type system cannot say: the impl receives
 * the call's FULL options object and the result double forwards every member
 * the loop reads (`stream`/`finishReason`/`usage` — see `mapFinish`), so the
 * double behaves as a `typeof streamText` for EVERY instantiation the loop
 * can produce, and an unprovided result member throws a labeled error instead
 * of returning `undefined` far from the cause.
 *
 * Call tracking stays on the caller's own variables (the impl closure writes
 * them); restore discipline (testing skill R3) is unchanged — this seam
 * installs nothing global.
 */
export function makeStreamTextDouble(
	impl: (options: StreamTextCall) => FakeStreamTextTurn,
	label: string,
): typeof streamText {
	const double = (options: StreamTextCall) => {
		const turn = impl(options);
		return strictTestDouble<StreamTextResultShape>(
			{
				stream: partsToStream(turn.parts),
				finishReason: Promise.resolve(turn.finishReason ?? "stop"),
				usage: Promise.resolve(turn.usage ?? { ...IDLE_USAGE }),
			},
			label,
		);
	};
	return double as typeof streamText;
}

// ─── The sidechat provider profile (director streaming suites) ───────────────

/**
 * The sidechat provider profile both director suites inject through
 * `getProviderProfile`/`getEffectiveProviderProfile`. Built through
 * {@link makeProviderProfileRow} so the row is a complete stored record: the
 * erased literals carried the INVALID transport spelling "chatCompletions"
 * (the union value is `chat_completions`) hidden by the cast — runtime never
 * read it (the suites stub `resolveModel`, so no transport resolution ever
 * runs), and the builder fixes the value. The budget/pin fields are pinned to
 * the literals' explicit values (`null`/`false`) so the context-packing math
 * reads the same numbers as before the migration.
 */
export function makeSidechatProviderProfile(): ProviderProfile {
	return makeProviderProfileRow({
		id: "prov_1",
		name: "Sidechat test",
		providerPreset: "openai",
		endpoint: "http://sidechat.test",
		apiKey: "key",
		defaultModel: "sidechat-model",
		contextBudget: null,
		pinContextBudget: false,
		maxTokens: 2000,
		temperature: 0.3,
	});
}

// ─── Stored proxy row (provider test-chat routes) ────────────────────────────

/**
 * A complete stored proxy row; the adapter resolves it only to check
 * EXISTENCE for a draft proxyId (the fetch itself is injected through the
 * provider-fetch factory, so no field beyond identity is read on the pinned
 * paths) — everything else rides inert defaults; overrides win. Replaces the
 * `{ id }` fragments the erasure casts let past the compiler.
 */
export function makeProxyRow(over: Partial<ProxyProfile> = {}): ProxyProfile {
	return {
		id: "proxy_1",
		name: "Fixture proxy",
		url: "http://proxy.test:8080",
		username: null,
		password: null,
		sortOrder: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

// ─── Provider-execution prompt (STT executor pins) ───────────────────────────

/**
 * A complete `AssemblePromptResponse` for `ProviderExecutionInput.prompt`:
 * the STT executor reads `finalPayload.messages` (the outbound request body)
 * and nothing else on the pinned paths — every other required member rides
 * the assembler's empty-shape defaults. Replaces the erased
 * `{ finalPayload: … }` fragments that were missing `layers`/
 * `tokenAccounting`/`activatedLoreEntries`/`scriptInjections`/
 * `retrievedMemories`; overrides win wholesale.
 */
export function makeExecutorPrompt(
	over: Partial<AssemblePromptResponse> = {},
): AssemblePromptResponse {
	return {
		layers: [],
		tokenAccounting: {},
		activatedLoreEntries: [],
		scriptInjections: [],
		retrievedMemories: [],
		finalPayload: { messages: [] },
		...over,
	};
}

// ─── Co-author toolset schema probe (coauthor-tools.test.ts) ─────────────────

/**
 * The co-author toolset's zod input schema for one tool, derived from the
 * REAL `buildCoauthorTools()` return (`ToolSet` — an index-signature record,
 * so presence pins read members directly and need no probe). Only the
 * input-schema probe needs narrowing: `Tool["inputSchema"]` is
 * `FlexibleSchema`, a union in which only the zod member carries
 * `shape`/`safeParse`. Every co-author tool is declared with
 * `inputSchema: z.object(...)`, so the probe narrows honestly through an
 * `instanceof z.ZodObject` check — a non-zod schema is a build regression the
 * probe REPORTS, not silently probes.
 *
 * fork #1 of `copilotToolInputSchema` (copilot-test-builders.ts) — same
 * narrowing, different toolset: the probe deliberately stays per-cluster so
 * each cluster's consumers name their own tools file; the count header is the
 * durable memory (agents' contexts compact, the owner doesn't read code).
 */
export function coauthorToolInputSchema(
	tools: ToolSet,
	name: string,
): z.ZodObject {
	const schema = tools[name].inputSchema;
	if (!(schema instanceof z.ZodObject)) {
		throw new Error(
			`coauthorToolInputSchema(${name}): inputSchema is not a zod object schema — the probe contract is broken`,
		);
	}
	return schema;
}
