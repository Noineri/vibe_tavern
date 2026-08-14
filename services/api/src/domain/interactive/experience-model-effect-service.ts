/**
 * Experience model-effect service (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 4 / IR-43).
 *
 * Runs ONE persisted model effect to a durable terminal state and feeds the
 * result back into the reducer. Sits above the IR-21 effect store (claim /
 * complete / fail / cancel / retry / reconcile lifecycle) and the IR-31
 * ExperienceService (VM projection + the effect-result transition), and reuses
 * the IR-41 prompt builder + IR-42 context bundle + the IR-42 summary-generation
 * seam (effective-profile + per-model-settings + API-key validation — the SAME
 * resolution path ChatSummaryService uses, so a bound model's overlay reaches
 * the effect exactly as it reaches a summary).
 *
 * Durable failure / retry semantics (the unit's required result):
 *  - `claim` (pending → running) happens BEFORE the model call ("persist before
 *    run"), so a crash after claim leaves a `running` effect that restart
 *    reconciles to `unknown` (never silently re-run).
 *  - Client cancellation (aborted signal) persists `cancelled`.
 *  - Known executor failure / no-provider / no-model persists `failed` with a
 *    reason; the effect is inspectable and retryable. An output that fails
 *    validation gets ONE bounded corrective re-ask (the raw reply + the
 *    validation reason appended to the prompt, same claimed run — fix step 1d)
 *    before persisting `failed`.
 *  - Only an explicit user retry (retryEffect, Wave 3 store) creates a new
 *    attempt, preserving the original effect id + audit history.
 *
 * Stale completion (the IR-22 invariant): the feed-back is an `effect_result`
 * transition whose `expectedRevision` is the effect's `originatingRevision`. If
 * the session advanced past it, the CAS rejects the feed-back — the effect stays
 * `succeeded` (terminal, its result recorded) but undelivered, and the session
 * keeps its newer state. The late completion can NEVER overwrite newer state.
 *
 * Provider/model resolution: V1 resolves the active RP provider profile + its
 * default model (the "current provider/profile resolution", identical to the
 * compact_summary path). Per-experience provider selection (the setup modal) is
 * a later unit; the request-payload contract is the fixed V1 surface a package
 * emits inside a `kind: "model"` effect.
 *
 * IR-70E: each NEW model-controlled participant seat pins its own
 * providerProfileId + modelId in the immutable participant snapshot. The
 * effect viewer participant is resolved from that snapshot first, and a
 * complete pinned assignment loads exactly its pinned provider/model (with the
 * settings overlay and API-key policy of that provider) — never the active
 * profile/default model. Legacy persisted participants (neither field) retain
 * the active-profile/default-model fallback; a malformed participant (exactly
 * one field) fails durably as no_model.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type {
	AssemblePromptResponse,
	ExperienceAction,
	ExperienceActionDescriptor,
	ExperienceParticipant,
	StoredProviderProfileRecord,
} from "@vibe-tavern/domain";
import {
	buildExperienceContext,
	buildExperienceModelPrompt,
	type ExperienceContextBundle,
	type ExperienceContextInput,
} from "@vibe-tavern/prompt-pipeline";

import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { providerRequiresApiKey, resolveEffectiveSummaryProfile } from "../chat/summary-generation-seam.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import type { ExperienceContextService } from "./experience-context-service.js";
import type { ExperienceProjection, ExperienceSessionView } from "./experience-service.js";
import {
	type ModelEffectVmContext,
	type EffectDelivery,
	ExperienceService,
} from "./experience-service.js";
import {
	type ExperienceResult,
	type ModelEffectRequestPayload,
	type ModelEffectResultPayload,
	err,
	ok,
} from "./experience-shared.js";
import type {
	StructuredActionChoiceInput,
	StructuredActionChoiceResult,
} from "./experience-model-effect-structured.js";
import { validatePayloadValue } from "./experience-payload-schema.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** The durable outcome of one `runEffect` call (always terminal or running). */
export interface ModelEffectOutcome {
	effectId: string;
	status: "succeeded" | "failed" | "cancelled" | "running";
	/** Present when succeeded (the validated terminal result). */
	result?: ModelEffectResultPayload;
	/** Present when failed (machine-readable reason). */
	error?: string;
	/** Whether the result was delivered into the reducer (false on stale completion). */
	delivered?: boolean;
	/** Present when delivered (the post-feed-back session view + projection). */
	session?: ExperienceSessionView;
	projection?: ExperienceProjection;
}

export interface ExperienceModelEffectServiceDeps {
	stores: StoreContainer;
	experienceService: ExperienceService;
	contextService: ExperienceContextService;
	providerProfiles: ProviderProfileService;
	/** Provider execution seam — injected so tests can stub the model call. */
	execute?: typeof nonstreamingProviderExecute;
	/** Structured-generation seam (fix step 1c) — when absent, action mode uses
	 * the text path only. Production wiring passes the real implementation;
	 * tests opt in per-case. */
	executeStructured?: (input: StructuredActionChoiceInput) => Promise<StructuredActionChoiceResult>;
}

// ─── Service ─────────────────────────────────────────────────────────────────

const NO_BUNDLE_FALLBACK_BUDGET = 8000;

/** Bounded corrective re-asks after a validation failure (fix step 1d). */
const MAX_CORRECTIVE_REASKS = 1;

export class ExperienceModelEffectService {
	private readonly deps: ExperienceModelEffectServiceDeps;
	private readonly execute: typeof nonstreamingProviderExecute;

	constructor(deps: ExperienceModelEffectServiceDeps) {
		this.deps = deps;
		this.execute = deps.execute ?? nonstreamingProviderExecute;
	}

	/**
	 * Resolve one persisted model effect to a terminal state and feed the result
	 * back into the reducer. Idempotent: a non-pending effect returns its current
	 * status without re-running (a concurrent worker, a retry of a terminal
	 * effect, or a re-delivery).
	 */
	async runEffect(effectId: string, signal?: AbortSignal): Promise<ExperienceResult<ModelEffectOutcome>> {
		const effect = await this.deps.stores.experiences.getEffectById(effectId);
		if (effect === null) {
			return err({ status: 404, code: "effect_not_found", message: `Effect '${effectId}' not found` });
		}
		// Idempotent re-entry: a terminal/running effect is NOT re-run.
		if (effect.status !== "pending") {
			return ok({ effectId, status: toOutcomeStatus(effect.status) });
		}

		// 1. Claim (pending → running) BEFORE the model call. A crash after this
		//    leaves a `running` effect that restart reconciles to `unknown`.
		const claimed = await this.deps.stores.experiences.claimEffect(effectId);
		if (claimed === null) {
			const raced = await this.deps.stores.experiences.getEffectById(effectId);
			return ok({ effectId, status: toOutcomeStatus(raced?.status ?? "running") });
		}

		// 2. Resolve the VM context FIRST (IR-70E): the effect viewer determines
		//    the seat assignment, which selects the provider/model. A failure here
		//    persists `failed` and never calls the executor.
		const vmCtx = await this.deps.experienceService.resolveModelEffectContext(effectId);
		if (!vmCtx.ok) {
			await this.deps.stores.experiences.failEffect(effectId, vmCtx.error.code);
			return ok({ effectId, status: "failed", error: vmCtx.error.code });
		}

		// 3. Resolve the provider profile + model for this seat from the immutable
		//    participant snapshot (IR-70E). A complete pinned assignment (both
		//    providerProfileId + modelId present) loads exactly its pinned
		//    provider/model, including that provider/model's settings overlay and
		//    API-key policy — it does NOT consult the active profile/default model.
		//    A legacy participant (neither field) falls back to the active
		//    provider/default model. A malformed participant (exactly one field)
		//    fails durably as no_model rather than silently switching.
		const seat = resolveSeatAssignment(vmCtx.data.participant);
		let profile: StoredProviderProfileRecord;
		let model: string;
		if (seat.kind === "pinned") {
			const pinned = await this.deps.providerProfiles.getProviderProfile(seat.providerProfileId);
			if (pinned === null) {
				await this.deps.stores.experiences.failEffect(effectId, "no_provider");
				return ok({ effectId, status: "failed", error: "no_provider" });
			}
			profile = pinned;
			model = seat.modelId;
		} else if (seat.kind === "malformed") {
			await this.deps.stores.experiences.failEffect(effectId, "no_model");
			return ok({ effectId, status: "failed", error: "no_model" });
		} else {
			// Legacy fallback: active provider profile + default model.
			const active = await this.deps.providerProfiles.resolveActiveProviderProfile();
			if (active === null) {
				await this.deps.stores.experiences.failEffect(effectId, "no_provider");
				return ok({ effectId, status: "failed", error: "no_provider" });
			}
			profile = active;
			model = active.defaultModel?.trim() ?? "";
		}
		if (!model) {
			await this.deps.stores.experiences.failEffect(effectId, "no_model");
			return ok({ effectId, status: "failed", error: "no_model" });
		}
		if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) {
			await this.deps.stores.experiences.failEffect(effectId, "no_api_key");
			return ok({ effectId, status: "failed", error: "no_api_key" });
		}
		const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, this.deps.providerProfiles);

		// 4. Build the prompt (host protocol + overrides + character/persona + bundle + private view).
		const prompt = await this.buildPrompt(effectiveProfile, model, vmCtx.data);

		// 5+6. Generate + validate, with ONE bounded corrective re-ask (fix step
		//      1d): when a reply fails validation, the raw reply + the validation
		//      reason are appended as a corrective exchange and the SAME generation
		//      path (structured-first for action mode) runs once more. This is all
		//      inside the already-claimed run, before any terminal persist — a
		//      crash mid-re-ask leaves the effect `running` exactly like a crash
		//      before it, and only an explicit user retry (retryEffect) creates a
		//      new attempt. Provider failures (cancel/network) still persist their
		//      terminal state immediately and are never re-asked.
		let resultPayload: ModelEffectResultPayload | undefined;
		let attemptPrompt: AssemblePromptResponse = prompt;
		let reask = 0;
		while (resultPayload === undefined) {
			const generated = await this.generateAttempt(effectId, effectiveProfile, model, vmCtx.data, attemptPrompt, signal);
			if (!generated.ok) return generated.result; // cancel/fail already persisted
			const candidate = validateOutput(generated.text, vmCtx.data.request, vmCtx.data.legalActions);
			if (candidate.ok) {
				resultPayload = candidate.value;
				break;
			}
			if (reask >= MAX_CORRECTIVE_REASKS) {
				await this.deps.stores.experiences.failEffect(effectId, candidate.reason);
				return ok({ effectId, status: "failed", error: candidate.reason });
			}
			attemptPrompt = appendCorrectiveExchange(attemptPrompt, generated.text, candidate, vmCtx.data.request, vmCtx.data.legalActions);
			reask += 1;
		}

		// 7. Persist the complete terminal result.
		await this.deps.stores.experiences.completeEffect(effectId, JSON.stringify(resultPayload));

		// 8. Feed the result back into the reducer. Acceptance is the CAS
		//    (expectedRevision = originatingRevision): a stale session rejects
		//    the feed-back and the effect stays succeeded-but-undelivered.
		const action = mapResultToAction(effectId, vmCtx.data, resultPayload);
		const delivery = await this.deps.experienceService.applyEffectResult(effectId, action);
		if (!delivery.ok) {
			// The reducer rejected the mapped action (illegal at the current state).
			// The effect is already succeeded; surface the delivery failure without
			// mutating the terminal result.
			return ok({ effectId, status: "succeeded", result: resultPayload, delivered: false, error: delivery.error.code });
		}
		return ok({
			effectId,
			status: "succeeded",
			result: resultPayload,
			delivered: delivery.data.delivered,
			...(delivery.data.delivered ? { session: delivery.data.session, projection: delivery.data.projection } : {}),
		});
	}

	// ─── Generation ─────────────────────────────────────────────────────────────

	/**
	 * One generation attempt (fix step 1c + 1d): structured-first for action
	 * mode when the seam is available, then the text path as fallback. Terminal
	 * cancel/fail outcomes are persisted HERE and returned as a ready outcome;
	 * success returns the raw reply text (validation happens in the caller).
	 */
	private async generateAttempt(
		effectId: string,
		profile: StoredProviderProfileRecord,
		model: string,
		vmData: ModelEffectVmContext,
		prompt: AssemblePromptResponse,
		signal: AbortSignal | undefined,
	): Promise<{ ok: true; text: string } | { ok: false; result: ExperienceResult<ModelEffectOutcome> }> {
		let text: string | null = null;
		if (vmData.request.mode === "action" && this.deps.executeStructured) {
			let structured: StructuredActionChoiceResult | null = null;
			try {
				structured = await this.deps.executeStructured({
					profile,
					model,
					prompt,
					legalActions: vmData.legalActions,
					signal,
				});
			} catch {
				// A throwing seam maps to "fall back" (the contract maps provider
				// errors to `unsupported`; this guards a misbehaving stub/seam).
				structured = null;
			}
			if (structured !== null && structured.kind === "structured") {
				text = structured.text;
			}
		}
		if (text === null) {
			try {
				const result = await this.execute({ profile, model, prompt, signal });
				text = result.text;
			} catch (e) {
				// Cancellation: an aborted signal (client cancel) persists `cancelled`.
				if (signal?.aborted) {
					await this.deps.stores.experiences.cancelEffect(effectId);
					return { ok: false, result: ok({ effectId, status: "cancelled" }) };
				}
				const message = describeError(e);
				await this.deps.stores.experiences.failEffect(effectId, message);
				return { ok: false, result: ok({ effectId, status: "failed", error: message }) };
			}
		}
		// Some providers resolve cleanly on abort rather than throwing — re-check.
		if (signal?.aborted) {
			await this.deps.stores.experiences.cancelEffect(effectId);
			return { ok: false, result: ok({ effectId, status: "cancelled" }) };
		}
		return { ok: true, text };
	}

	// ─── Prompt construction ──────────────────────────────────────────────────

	private async buildPrompt(
		profile: StoredProviderProfileRecord,
		_model: string,
		vmCtx: ModelEffectVmContext,
	): Promise<AssemblePromptResponse> {
		const bundle = await this.loadContextBundle(vmCtx.effect.sessionId);
		const globalOverride = (await this.deps.stores.experienceResources.getGlobalOverride())?.content ?? null;
		const characterOverride = vmCtx.characterId
			? (await this.deps.stores.experienceResources.getOverrideForCharacter(vmCtx.characterId))?.content ?? null
			: null;
		return buildExperienceModelPrompt({
			hostProtocol: hostProtocolForMode(vmCtx.request.mode),
			packagePrompt: vmCtx.request.instruction ?? null,
			globalOverride,
			characterOverride,
			context: bundle,
			privateView: renderPrivateView(vmCtx),
			budget: {
				contextBudget: profile.contextBudget ?? NO_BUNDLE_FALLBACK_BUDGET,
				responseReserve: Math.min(1024, Math.floor((profile.contextBudget ?? NO_BUNDLE_FALLBACK_BUDGET) / 4)),
			},
		});
	}

	/** Load the frozen RP-context bundle, or an empty bundle when none was captured. */
	private async loadContextBundle(sessionId: string): Promise<ExperienceContextBundle> {
		const bundle = await this.deps.contextService.loadBundle(sessionId);
		if (bundle) return bundle;
		const empty: ExperienceContextInput = { messages: [], summaries: [], character: null, persona: null };
		return buildExperienceContext(empty);
	}
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The resolved seat assignment for a model effect, read from the immutable
 * participant snapshot (IR-70E):
 *  - `pinned`    — BOTH providerProfileId + modelId are present (nonblank).
 *    The effect loads exactly its pinned provider/model.
 *  - `malformed` — exactly ONE field is present. A historical corruption that
 *    is never treated as legacy fallback; the effect fails durably as no_model.
 *  - `legacy`    — NEITHER field is present. Falls back to the active
 *    provider/default model (the pre-IR-70E behavior).
 */
type SeatAssignment =
	| { kind: "pinned"; providerProfileId: string; modelId: string }
	| { kind: "malformed" }
	| { kind: "legacy" };

function resolveSeatAssignment(participant: ExperienceParticipant): SeatAssignment {
	const hasProviderField = participant.providerProfileId !== undefined;
	const hasModelField = participant.modelId !== undefined;
	if (!hasProviderField && !hasModelField) return { kind: "legacy" };
	if (!hasProviderField || !hasModelField) return { kind: "malformed" };

	const providerProfileId = participant.providerProfileId?.trim();
	const modelId = participant.modelId?.trim();
	if (!providerProfileId || !modelId) return { kind: "malformed" };
	return { kind: "pinned", providerProfileId, modelId };
}

/** Extract a human-readable message from a thrown value without instanceof (cross-realm safe). */
function describeError(e: unknown): string {
	if (e !== null && typeof e === "object") {
		const message = (e as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
		const name = (e as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) return name;
	}
	return typeof e === "string" ? e : "unknown_error";
}

function hostProtocolForMode(mode: ModelEffectRequestPayload["mode"]): string {
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

function renderPrivateView(vmCtx: ModelEffectVmContext): string {
	const lines: string[] = [];
	lines.push("[Your projected view]");
	lines.push(safeStringify(vmCtx.projectedView));
	if (vmCtx.request.mode === "action" && vmCtx.legalActions.length > 0) {
		lines.push("");
		lines.push("[Your legal actions — pick one]");
		for (const a of vmCtx.legalActions) {
			lines.push(`- ${a.type}${a.label ? ` (${a.label})` : ""}`);
		}
	}
	return lines.join("\n");
}

/**
 * The outcome of validating model output. `ok` carries the terminal result to
 * persist; `reason` is the short stable failure string persisted via
 * `failEffect` ("invalid_output" for an unparseable/illegal reply,
 * "invalid_payload" for a reply whose args violate the descriptor's
 * `payloadSchema`).
 */
type ValidateOutputResult =
	| { ok: true; value: ModelEffectResultPayload }
	| { ok: false; reason: "invalid_output" | "invalid_payload"; detail?: string };

/**
 * Validate the model output against the request mode. Action mode parses a JSON
 * object and requires the `actionId` to match one of the legal action types;
 * when the chosen action's descriptor declares a `payloadSchema`, its `args`
 * must satisfy it (mirroring the kernel's `validateSubmittedAction` rule).
 * Text mode requires a non-empty string. Returns a typed failure on any
 * validation failure (never a bare null).
 */
function validateOutput(
	text: string,
	request: ModelEffectRequestPayload,
	legalActions: ExperienceActionDescriptor[],
): ValidateOutputResult {
	const trimmed = text.trim();
	if (request.mode === "text") {
		return trimmed.length > 0
			? { ok: true, value: { mode: "text", text: trimmed } }
			: { ok: false, reason: "invalid_output", detail: "the reply was empty" };
	}
	// Action mode: accept either a bare legal action type or a JSON object.
	const legalTypes = new Set(legalActions.map((a) => a.type));
	if (legalTypes.has(trimmed)) {
		const descriptor = legalActions.find((a) => a.type === trimmed);
		// Mirror the kernel rule: a schema-declaring action must carry a payload,
		// so a bare actionId reply with no args is invalid_payload.
		if (descriptor?.payloadSchema !== undefined) {
			return { ok: false, reason: "invalid_payload", detail: `action '${trimmed}' declares a payloadSchema, so the reply must be a JSON object carrying args` };
		}
		return { ok: true, value: { mode: "action", actionId: trimmed } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, reason: "invalid_output", detail: "the reply is not valid JSON" };
	}
	if (parsed === null || typeof parsed !== "object") {
		return { ok: false, reason: "invalid_output", detail: "the reply is not a JSON object" };
	}
	const obj = parsed as { actionId?: unknown; args?: unknown };
	if (typeof obj.actionId !== "string" || !legalTypes.has(obj.actionId)) {
		const legal = [...legalTypes].join(", ");
		return { ok: false, reason: "invalid_output", detail: `actionId must be one of: ${legal}` };
	}
	const descriptor = legalActions.find((a) => a.type === obj.actionId);
	if (descriptor?.payloadSchema !== undefined) {
		if (obj.args === undefined) {
			return { ok: false, reason: "invalid_payload", detail: "args is required by this action's payloadSchema" };
		}
		const schemaResult = validatePayloadValue(obj.args, descriptor.payloadSchema, "args");
		if (!schemaResult.ok) {
			return { ok: false, reason: "invalid_payload", detail: schemaResult.message };
		}
	}
	return {
		ok: true,
		value: {
			mode: "action",
			actionId: obj.actionId,
			...(obj.args !== undefined ? { args: obj.args } : {}),
		},
	};
}

/**
 * Build the corrective follow-up prompt (fix step 1d): the rejected raw reply
 * is kept as an assistant turn, and a user turn names the failure and the exact
 * acceptance rule, so the model can correct itself. Pure — touches no state.
 */
function appendCorrectiveExchange(
	prompt: AssemblePromptResponse,
	rawReply: string,
	failure: { reason: string; detail?: string },
	request: ModelEffectRequestPayload,
	legalActions: readonly ExperienceActionDescriptor[],
): AssemblePromptResponse {
	const previous = Array.isArray(prompt.finalPayload.messages)
		? (prompt.finalPayload.messages as Array<{ role: string; content: string }>)
		: [];
	const guidance =
		request.mode === "action"
			? `Your previous reply was rejected by the game engine. Reason: ${failure.reason}${failure.detail ? ` (${failure.detail})` : ""}. Reply again with a single JSON object: {"actionId": "<action>"} where actionId is one of: ${legalActions.map((a) => a.type).join(", ")}. If the chosen action declares arguments, include them in "args" matching its schema. Output only the JSON object — no prose, no code fences.`
			: `Your previous reply was rejected. Reason: ${failure.reason}${failure.detail ? ` (${failure.detail})` : ""}. Reply again with a non-empty reply.`;
	return {
		...prompt,
		finalPayload: {
			...prompt.finalPayload,
			messages: [
				...previous,
				{ role: "assistant", content: rawReply },
				{ role: "user", content: guidance },
			],
		},
	};
}

/** Map a validated result + the originating effect into the action fed to the reducer. */
function mapResultToAction(
	effectId: string,
	vmCtx: ModelEffectVmContext,
	result: ModelEffectResultPayload,
): ExperienceAction {
	const base = {
		requestId: `effect:${effectId}`,
		expectedRevision: vmCtx.effect.originatingRevision,
		participantId: vmCtx.request.viewer,
	};
	if (result.mode === "action") {
		return { type: result.actionId, ...base, ...(result.args !== undefined ? { payload: result.args } : {}) };
	}
	return { type: vmCtx.request.actionType ?? "reply", ...base, payload: { text: result.text } };
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Narrow a persisted effect status (a broad string) to the outcome union. `unknown` (process loss) surfaces as `failed`. */
function toOutcomeStatus(status: string): ModelEffectOutcome["status"] {
	if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "running") return status;
	return "failed";
}

// Re-export the delivery type for callers (adapter / tests).
export type { EffectDelivery };
