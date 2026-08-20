/**
 * Realtime round-model seam implementation (RM-7 / REALTIME_EXPERIENCE_MODE_PLAN).
 *
 * Implements the one-shot non-streaming model generation for a model seat in a
 * REALTIME round. The round is CLIENT-authoritative: the loop lives in the
 * visual frame, so state lives frame-side. This seam is session-less and
 * stateless — shared by the live modal host and the playground realtime panel —
 * and it is deliberately DUMBER than the durable / playground model seams: it
 * resolves the pinned provider profile read-only, builds a minimal prompt, calls
 * the REAL {@link nonstreamingProviderExecute}, validates the output SHAPE ONLY,
 * and returns the reply as DATA for the round log. ZERO ExperienceStore/chat/DB
 * writes, NO effect row (the model result is data in the log, never a durable
 * effect), NO legal-action check (legality is a pure function of frame state —
 * the frame reduce and RM-8 replay re-check it server-side).
 *
 * This mirrors `experience-playground-model.ts`'s provider resolution + prompt
 * building + execution path, but for a round claim rather than a turn effect.
 */
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import {
	buildExperienceContext,
	buildExperienceModelPrompt,
	type ExperienceContextInput,
} from "@vibe-tavern/prompt-pipeline";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { providerRequiresApiKey, resolveEffectiveSummaryProfile } from "../chat/summary-generation-seam.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExperienceRoundModelDeps {
	providerProfiles: ProviderProfileService;
	/** Provider execution seam — injected so tests can stub the model call. */
	execute?: typeof nonstreamingProviderExecute;
}

export type ExperienceRoundModelInput = {
	seatId: string;
	requestId?: string;
	providerProfileId: string;
	modelId: string;
	prompt: unknown;
	signal?: AbortSignal;
};

export type ExperienceRoundModelResult =
	| { ok: true; data: { seatId: string; requestId?: string; result: unknown } }
	| { ok: false; error: { code: string; message: string; status: 422 | 500 } };

// ─── Prompt helpers (mirrors the playground seam) ──────────────────────────

/** The model-effect request payload (same author vocabulary as turn effects and
 *  the playground: `{ viewer, mode, actionType?, instruction? }`). */
interface ModelEffectRequest {
	viewer: string;
	mode: "action" | "text";
	actionType?: string;
	instruction?: string;
}

function parseRequest(raw: unknown): ModelEffectRequest | null {
	if (raw === null || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const mode = obj.mode;
	if (mode !== "action" && mode !== "text") return null;
	const viewer = obj.viewer;
	if (typeof viewer !== "string") return null;
	const request: ModelEffectRequest = { viewer, mode };
	if (typeof obj.actionType === "string") request.actionType = obj.actionType;
	if (typeof obj.instruction === "string") request.instruction = obj.instruction;
	return request;
}

// Twin of `hostProtocolForMode` in experience-playground-model.ts (not exported
// there — duplicated deliberately so round-model stays self-contained).
function hostProtocolForMode(mode: ModelEffectRequest["mode"]): string {
	if (mode === "action") {
		return [
			"You are a participant in an interactive experience.",
			"Choose exactly ONE legal action for your participant on your turn.",
			'Reply with ONLY a JSON object: {"actionId": "<one of the legal action types>", "args": <optional arguments>}.',
			"Do not add any prose outside the JSON object.",
		].join(" ");
	}
	return [
		"You are a participant in an interactive experience.",
		"Reply with your in-character text response for your turn.",
		"Stay in character; do not narrate the system or other participants.",
	].join(" ");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Validate the model output's SHAPE ONLY. The round is stateless — the frame
 *  owns the state and legal actions — so legality cannot be (and must not be)
 *  checked here; the frame reduce + RM-8 replay re-verify it. Action mode must
 *  return a JSON object `{ actionId, args? }` (NO bare-string fallback — the
 *  frame feeds this to reduce as a script-move intent); text mode a non-empty
 *  trimmed string. Returns `null` on any shape failure. */
function validateOutputShape(text: string, request: ModelEffectRequest): unknown {
	const trimmed = text.trim();
	if (request.mode === "text") {
		return trimmed.length > 0 ? trimmed : null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const obj = parsed as { actionId?: unknown; args?: unknown };
	if (typeof obj.actionId !== "string" || obj.actionId.length === 0) return null;
	return obj;
}

function describeError(e: unknown): string {
	if (e !== null && typeof e === "object") {
		const message = (e as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return typeof e === "string" ? e : "unknown_error";
}

// ─── Seam factory ───────────────────────────────────────────────────────────

/**
 * Create a {@link ExperienceRoundModelDeps}-driven executor: resolves the pinned
 * provider/model read-only, builds a minimal prompt (host protocol + author
 * instruction + the prompt object rendered), calls the REAL non-streaming
 * executor, and returns the reply as bounded DATA. ZERO store writes — the only
 * mutation is the executor's outbound HTTP call.
 */
export function createRoundModelDeps(deps: ExperienceRoundModelDeps): {
	run(input: ExperienceRoundModelInput): Promise<ExperienceRoundModelResult>;
} {
	const execute = deps.execute ?? nonstreamingProviderExecute;
	const providerProfiles = deps.providerProfiles;

	return {
		async run(input: ExperienceRoundModelInput): Promise<ExperienceRoundModelResult> {
			// 1. Interpret the author prompt as the model-effect request vocabulary.
			const request = parseRequest(input.prompt);
			if (request === null) {
				return { ok: false, error: { code: "invalid_model_prompt", message: "Malformed model prompt", status: 422 } };
			}

			// 2. Resolve the pinned provider profile (read-only).
			const profile: StoredProviderProfileRecord | null = await providerProfiles.getProviderProfile(input.providerProfileId);
			if (profile === null) {
				return { ok: false, error: { code: "no_provider", message: `Provider profile '${input.providerProfileId}' not found`, status: 422 } };
			}

			// 3. API-key policy check (mirrors the durable service).
			if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) {
				return { ok: false, error: { code: "no_api_key", message: `Provider '${profile.name}' requires an API key`, status: 422 } };
			}

			// 4. Resolve the effective profile (per-model settings overlay).
			const effectiveProfile = await resolveEffectiveSummaryProfile(profile, input.modelId, providerProfiles);

			// 5. Build the prompt (host protocol + author instruction + prompt payload).
			// There is NO projected private view here: the state lives client-side
			// in the frame, so the author data IS the payload.
			const emptyContext: ExperienceContextInput = { messages: [], summaries: [], character: null, persona: null };
			const bundle = buildExperienceContext(emptyContext);
			const prompt = buildExperienceModelPrompt({
				hostProtocol: hostProtocolForMode(request.mode),
				packagePrompt: request.instruction ?? null,
				context: bundle,
				privateView: safeStringify(request),
			});

			// 6. Execute via the REAL non-streaming executor (forward the abort signal).
			let text: string;
			try {
				const result = await execute({ profile: effectiveProfile, model: input.modelId, prompt, signal: input.signal });
				text = result.text;
			} catch (e) {
				return { ok: false, error: { code: "provider_error", message: describeError(e), status: 500 } };
			}

			// 7. Validate the output SHAPE ONLY (no legal-action check — see header).
			const result = validateOutputShape(text, request);
			if (result === null) {
				return { ok: false, error: { code: "invalid_output", message: "Model output did not match the expected format", status: 422 } };
			}
			return {
				ok: true,
				data: {
					seatId: input.seatId,
					...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
					result,
				},
			};
		},
	};
}
