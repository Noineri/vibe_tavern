/**
 * Experience adapter (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-32).
 *
 * Thin glue between the Hono route layer and the three interactive-runtime
 * services (lifecycle / resource / replay). Maps the typed
 * {@link ExperienceApiError} vocabulary to {@link DomainError} (and thus to the
 * 404/409/422/500 the contract promises), shapes the service output into the
 * wire response (session metadata + projected view), and sequences the one
 * piece of round-trip orchestration a client needs — a submitted action
 * auto-resolves any script seats before returning. No business logic lives
 * here: every create/reduce/project call is owned by a service.
 */

import type {
	ExperienceRuntimeApi,
	ExperienceSessionResponse,
	ExperienceActionResponse,
	ExperienceContextStatusDto,
	ExperiencePromptOverridesResponse,
	ExperienceQueuedAttachmentResponse,
} from "../contract/runtime-api.js";
import type {
	ExperienceRoundCommitRequestDto,
	ExperienceRoundModelRequestDto,
	ExperienceRoundModelResponseDto,
} from "@vibe-tavern/api-contracts";
import type {
	ExperienceService,
	ExperienceSessionView,
	ExperienceProjection,
	AppliedAction,
} from "../../domain/interactive/experience-service.js";
import { resolveHumanViewer } from "../../domain/interactive/experience-service.js";
import type { ExperienceResourceService } from "../../domain/interactive/experience-resource-service.js";
import type { ExperienceReplayService } from "../../domain/interactive/experience-replay-service.js";
import type { ExperienceModelEffectService } from "../../domain/interactive/experience-model-effect-service.js";
import type { ExperienceContextService } from "../../domain/interactive/experience-context-service.js";
import type { ExperienceApiError } from "../../domain/interactive/experience-shared.js";
import type { ExperienceParticipant } from "@vibe-tavern/domain";
import {
	runExperienceTest,
	simulateExperienceTest,
	type ExperienceTestError,
	type ExperienceTestRunInput,
	type ExperienceTestSimulateInput,
} from "../../domain/interactive/experience-tester.js";
import {
	startExperiencePlayground,
	advanceExperiencePlayground,
	executeModelTurnExperiencePlayground,
	executeTimerTurnExperiencePlayground,
	type ExperiencePlaygroundAdvanceInput,
	type ExperiencePlaygroundData,
	type ExperiencePlaygroundStartInput,
	type PlaygroundModelDeps,
	type PlaygroundChatter,
} from "../../domain/interactive/experience-playground.js";
import { createPlaygroundModelDeps } from "../../domain/interactive/experience-playground-model.js";
import {
	createRoundModelDeps,
	type ExperienceRoundModelInput,
} from "../../domain/interactive/experience-round-model.js";
import { ExperienceChatterService } from "../../domain/interactive/experience-chatter-service.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import { DomainError } from "../../shared/errors.js";

export class ExperienceAdapter implements ExperienceRuntimeApi {
	constructor(
		private readonly lifecycle: ExperienceService,
		private readonly resources: ExperienceResourceService,
		private readonly replay: ExperienceReplayService,
		private readonly modelEffect: ExperienceModelEffectService,
		private readonly contextService: ExperienceContextService,
		private readonly providerProfiles?: ProviderProfileService,
		/**
		 * IR-90E1: explicit test-injection seam for {@link PlaygroundModelDeps}.
		 * When supplied, this value is used directly — bypassing the provider-profile
		 * derivation path — so tests can supply a deterministic mock model seam
		 * without constructing a real ProviderProfileService. When omitted, the
		 * constructor derives `playgroundModelDeps` from `providerProfiles` exactly
		 * as before.
		 */
		explicitPlaygroundModelDeps?: PlaygroundModelDeps,
		/**
		 * AC-2b: explicit test-injection seam for {@link PlaygroundChatter}.
		 * When supplied, used directly (so tests can inject a deterministic
		 * chatter resolver without a real ProviderProfileService). When omitted,
		 * the constructor derives it from `providerProfiles` via
		 * {@link ExperienceChatterService} (a no-provider build leaves chatter
		 * undefined — static flavor passes through unchanged).
		 */
		explicitPlaygroundChatter?: PlaygroundChatter,
		/**
		 * RM-7: explicit test-injection seam for the round-model deps. When
		 * supplied, used directly (so tests can inject a deterministic model
		 * seam without a real ProviderProfileService). When omitted, the
		 * constructor derives it from `providerProfiles` via
		 * {@link createRoundModelDeps}.
		 */
		explicitRoundModelDeps?: ReturnType<typeof createRoundModelDeps>,
	) {
		this.playgroundModelDeps = explicitPlaygroundModelDeps !== undefined
			? explicitPlaygroundModelDeps
			: providerProfiles !== undefined
				? createPlaygroundModelDeps({ providerProfiles })
				: undefined;
		this.playgroundChatter = explicitPlaygroundChatter !== undefined
			? explicitPlaygroundChatter
			: providerProfiles !== undefined
				? new ExperienceChatterService({ providerProfiles })
				: undefined;
		this.roundModelDeps = explicitRoundModelDeps !== undefined
			? explicitRoundModelDeps
			: providerProfiles !== undefined
				? createRoundModelDeps({ providerProfiles })
				: undefined;
	}

	private readonly playgroundModelDeps?: PlaygroundModelDeps;
	private readonly playgroundChatter?: PlaygroundChatter;
	private readonly roundModelDeps?: ReturnType<typeof createRoundModelDeps>;

	// ─── Response shaping ────────────────────────────────────────────────────

	private toResponse(session: ExperienceSessionView, projection: ExperienceProjection): ExperienceSessionResponse {
		return { ...session, view: projection };
	}

	/** Project the current state for the human seat (V1: one human participant,
	 *  or the observer view when there is no roster). */
	private async projectForHuman(
		sessionId: string,
		participants: ExperienceParticipant[],
		participantId?: string,
	): Promise<ExperienceProjection> {
		const viewer = resolveHumanViewer(participants, participantId);
		const view = await this.lifecycle.getProjectedView(sessionId, viewer);
		if (!view.ok) throw mapError(view.error);
		return view.data;
	}

	// ─── Config ──────────────────────────────────────────────────────────────

	getExperienceConfig = async (chatId: string) => this.resources.getConfig(chatId);

	updateExperienceConfig = async (
		chatId: string,
		body: {
			enabled?: boolean;
			scriptId?: string | null;
			visualId?: string | null;
			contextSourceCharacterId?: string | null;
			contextSourceChatId?: string | null;
			contextSourcePersonaId?: string | null;
			capabilityGrants?: import("@vibe-tavern/domain").ExperienceCapability[];
			contextMode?: import("@vibe-tavern/domain").ExperienceContextMode;
			launcherVisible?: boolean;
		},
	) => {
		const result = await this.resources.updateConfig(chatId, body);
		if (!result.ok) throw mapError(result.error);
		return result.data;
	};

	// ─── Visual resources ────────────────────────────────────────────────────

	listExperienceVisuals = async (scopeType: string, ownerId?: string) =>
		this.resources.listVisualsForScope(scopeType, ownerId ?? null);

	getExperienceVisual = async (id: string) => this.resources.getVisual(id);

	createExperienceVisual = async (body: {
		name: string;
		source: string;
		apiVersion: number;
		compatibleManifestIds?: string[];
		scopeType?: string;
		characterId?: string | null;
	}) => {
		const result = await this.resources.createVisual(body);
		if (!result.ok) throw mapError(result.error);
		return result.data;
	};

	updateExperienceVisual = async (
		id: string,
		patch: {
			name?: string;
			source?: string;
			apiVersion?: number;
			compatibleManifestIds?: string[];
		},
	) => {
		const result = await this.resources.updateVisual(id, patch);
		if (!result.ok) throw mapError(result.error);
		return result.data;
	};

	deleteExperienceVisual = async (id: string) => {
		const result = await this.resources.deleteVisual(id);
		if (!result.ok) throw mapError(result.error);
	};

	// ─── Session lifecycle ───────────────────────────────────────────────────

	startExperienceSession = async (
		chatId: string,
		body: {
			branchId: string;
			settings?: unknown;
			participants: ExperienceParticipant[];
		},
	) => {
		const started = await this.lifecycle.startSession({
			chatId,
			branchId: body.branchId,
			settings: body.settings,
			participants: body.participants,
		});
		if (!started.ok) throw mapError(started.error);
		const projection = await this.projectForHuman(started.data.sessionId, started.data.participants);
		return this.toResponse(started.data, projection);
	};

	getExperienceSession = async (sessionId: string) => {
		const resumed = await this.lifecycle.resumeSession(sessionId);
		if (!resumed.ok) throw mapError(resumed.error);
		const projection = await this.projectForHuman(sessionId, resumed.data.participants);
		return this.toResponse(resumed.data, projection);
	};

	/** Branch-scoped active-session discovery (IR-70A): resolve the branch's
	 *  active session and project it for the human viewer, returning the same
	 *  response shape as {@link getExperienceSession}. */
	getActiveExperienceSession = async (chatId: string, branchId: string) => {
		const found = await this.lifecycle.getActiveSessionForBranch(chatId, branchId);
		if (!found.ok) throw mapError(found.error);
		const projection = await this.projectForHuman(found.data.sessionId, found.data.participants);
		return this.toResponse(found.data, projection);
	};

	restartExperienceSession = async (
		sessionId: string,
		body: { settings?: unknown; participants?: ExperienceParticipant[] },
	) => {
		const restarted = await this.lifecycle.restartSession(sessionId, { settings: body.settings, participants: body.participants });
		if (!restarted.ok) throw mapError(restarted.error);
		const projection = await this.projectForHuman(restarted.data.sessionId, restarted.data.participants);
		return this.toResponse(restarted.data, projection);
	};

	/** Canonical explicit user finish. When `quiet` is false the report service
	 * appends the durable public system event, releases the slot, and freezes
	 * the terminal snapshot in one synchronous SQLite transaction. When `quiet`
	 * is true the session ends with NO public artifact (pos 2 quiet close). */
	endExperienceSession = async (sessionId: string, body: { expectedRevision: number; quiet?: boolean }) => {
		const finished = await this.lifecycle.finishWithReport(sessionId, body.expectedRevision, body.quiet === true);
		if (!finished.ok) throw mapError(finished.error);
		return finished.data;
	};

	/** Submit one action intention, then auto-resolve any script seats, returning
	 *  the final projected view + emitted events + whose turn is next. The
	 *  `signal` is a forward-looking surface (Wave 4 model effects make actions
	 *  genuinely long-running); the synchronous V1 services resolve within the
	 *  bounded script-turn loop and do not yet cooperate with abort. */
	submitExperienceAction = async (
		sessionId: string,
		action: import("@vibe-tavern/domain").ExperienceAction,
		_signal?: AbortSignal,
	): Promise<ExperienceActionResponse> => {
		const submitted = await this.lifecycle.submitAction(sessionId, action);
		if (!submitted.ok) throw mapError(submitted.error);
		let result: AppliedAction = submitted.data;
		if (result.session.status === "active") {
			const advanced = await this.lifecycle.advanceScriptTurns(sessionId);
			if (!advanced.ok) throw mapError(advanced.error);
			result = advanced.data;
		}
		return { ...this.toResponse(result.session, result.projection), events: result.events, await: result.await };
	};

	// ─── Per-viewer projection reads ─────────────────────────────────────────

	getExperienceView = async (sessionId: string, participantId?: string) => {
		const resumed = await this.lifecycle.resumeSession(sessionId);
		if (!resumed.ok) throw mapError(resumed.error);
		return this.projectForHuman(sessionId, resumed.data.participants, participantId);
	};

	getExperienceActions = async (sessionId: string, participantId?: string) => {
		const resumed = await this.lifecycle.resumeSession(sessionId);
		if (!resumed.ok) throw mapError(resumed.error);
		const viewer = resolveHumanViewer(resumed.data.participants, participantId);
		const legal = await this.lifecycle.getLegalActions(sessionId, viewer);
		if (!legal.ok) throw mapError(legal.error);
		return legal.data;
	};

	// ─── Queued-attachment read (IR-70A) ───────────────────────────────────────

	/** Read the session's current queued attachment through the privacy-safe DTO,
	 *  or `null` when none is queued. The service verifies the session exists and
	 *  strips `hiddenStateCheckpointJson` before returning — this method carries
	 *  only public display/commit-intent fields. */
	getExperienceQueuedAttachment = async (sessionId: string) => {
		const attachment = await this.lifecycle.getQueuedAttachment(sessionId);
		if (!attachment.ok) throw mapError(attachment.error);
		return attachment.data;
	};

	queueExperienceReport = async (sessionId: string, body: { expectedRevision: number }) => {
		const queued = await this.lifecycle.queueReport(sessionId, body.expectedRevision);
		if (!queued.ok) throw mapError(queued.error);
		return queued.data;
	};

	getExperienceReportStatus = async (sessionId: string) => {
		const status = await this.lifecycle.getReportStatus(sessionId);
		if (!status.ok) throw mapError(status.error);
		return status.data;
	};

	// ─── Replay ──────────────────────────────────────────────────────────────

	undoExperienceSession = async (sessionId: string, body: { targetRevision: number }) => {
		const undone = await this.replay.undoToRevision(sessionId, body.targetRevision);
		if (!undone.ok) throw mapError(undone.error);
		const { session, projection, events, await: awaitTurn } = undone.data;
		return { ...this.toResponse(session, projection), events, await: awaitTurn };
	};

	previewExperienceRecalculation = async (sessionId: string, body: { rulesCode: string }) => {
		const preview = await this.replay.previewRecalculation(sessionId, body.rulesCode);
		if (!preview.ok) throw mapError(preview.error);
		return preview.data;
	};

	// ─── Effects (read-only; retry/resolve lands in Wave 4) ───────────────────

	getExperienceEffects = async (sessionId: string) => {
		const effects = await this.lifecycle.getPendingEffects(sessionId);
		if (!effects.ok) throw mapError(effects.error);
		return effects.data;
	};

	/** Run one model effect to a terminal state and feed the result back into the
	 *  reducer. The route passes the HTTP request signal so a client disconnect
	 *  persists `cancelled` (Wave 4 durable interruption policy).
	 *
	 *  `timer` effects are HOST-scheduled (fix step 2c): they must fire with the
	 *  page closed, so this path never runs them — it returns the row with
	 *  `hostScheduled: true` and the route answers 202. The frontend learns about
	 *  applied ticks through its existing session resync. */
	runExperienceEffect = async (
		effectId: string,
		signal?: AbortSignal,
	): Promise<import("../contract/runtime-api.js").ExperienceEffectRunResponse> => {
		const existing = await this.lifecycle.getEffect(effectId);
		if (!existing.ok) throw mapError(existing.error);
		if (existing.data.kind === "timer") {
			return { effect: existing.data, delivered: false, hostScheduled: true };
		}
		const run = await this.modelEffect.runEffect(effectId, signal);
		if (!run.ok) throw mapError(run.error);
		const outcome = run.data;
		const effect = await this.lifecycle.getEffect(effectId);
		if (!effect.ok) throw mapError(effect.error);
		return {
			effect: effect.data,
			delivered: outcome.delivered ?? false,
			...(outcome.error !== undefined ? { error: outcome.error } : {}),
			...(outcome.session && outcome.projection ? { session: this.toResponse(outcome.session, outcome.projection) } : {}),
		};
	};

	/** Explicit user retry (lobby effect diagnostics): a failed/cancelled/
	 *  unknown effect returns to `pending`; the host runner (chat-page lifetime)
	 *  picks the model rows back up, the scheduler owns timer rows — this path
	 *  never runs the effect itself. Typed 404/409 via the shared envelope. */
	retryExperienceEffect = async (effectId: string): Promise<import("@vibe-tavern/db").ExperienceEffectRow> => {
		const retried = await this.lifecycle.retryEffect(effectId);
		if (!retried.ok) throw mapError(retried.error);
		return retried.data;
	};

	// ─── Context capture + status (IR-70D) ────────────────────────────────────

	/** Explicit cancellable context capture. Requires `rp_context`. The signal
	 *  passes through so a client disconnect persists nothing and preserves the
	 *  prior bundle. */
	captureExperienceContext = async (
		sessionId: string,
		body: { mode?: import("@vibe-tavern/domain").ExperienceContextMode; providerProfileId?: string; model?: string; recentMessageLimit?: number; contextSourceCharacterId?: string | null; contextSourceChatId?: string | null; contextSourcePersonaId?: string | null },
		signal?: AbortSignal,
	): Promise<ExperienceContextStatusDto> => {
		// Source override fields are carried on the body but not resolved here —
		// CS-3 wires the character/chat ones into `CaptureContextInput`; Wave 3
		// (persona) lands in PS-3. The spread below forwards them harmlessly
		// (the domain input ignores unknown keys until then).
		const row = await this.contextService.captureContext({ sessionId, ...body, signal });
		return {
			sessionId: row.sessionId,
			mode: row.mode as import("@vibe-tavern/domain").ExperienceContextMode,
			branchFrontierRevision: row.branchFrontierRevision,
			messageFrontierPosition: row.messageFrontierPosition,
			providerProfileId: row.providerProfileId,
			modelId: row.modelId,
			sourceCharacterId: row.sourceCharacterId,
			sourceChatId: row.sourceChatId,
			sourcePersonaId: row.sourcePersonaId,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	};

	/** Read the session's current frozen context-bundle metadata or null. */
	getExperienceContextStatus = async (sessionId: string): Promise<ExperienceContextStatusDto | null> => {
		const status = await this.contextService.getContextStatus(sessionId);
		return status;
	};

	// ─── Prompt overrides (IR-70D) ────────────────────────────────────────────

	getExperiencePromptOverrides = async (sessionId: string): Promise<ExperiencePromptOverridesResponse> => {
		const result = await this.resources.getOverridesForSession(sessionId);
		if (!result.ok) throw mapError(result.error);
		return result.data;
	};

	updateExperienceGlobalOverride = async (sessionId: string, body: { content: string }): Promise<ExperiencePromptOverridesResponse> => {
		const result = await this.resources.setGlobalOverrideForSession(sessionId, body.content);
		if (!result.ok) throw mapError(result.error);
		return result.data;
	};

	updateExperienceCharacterOverride = async (sessionId: string, body: { content: string }): Promise<ExperiencePromptOverridesResponse> => {
		const result = await this.resources.setCharacterOverrideForSession(sessionId, body.content);
		if (!result.ok) throw mapError(result.error);
		return result.data;
	};

	// ─── Stateless unsaved-source tester (Wave 8 / IR-81B) ────────────────────
	// The tester is stateless: it reuses the pure kernel functions directly and
	// touches no store, session, chat config, or persistent service. These
	// adapter methods are thin delegates that map the typed tester error to a
	// DomainError the global onError handler renders (409 stale_revision /
	// 422 every authoring, validation, capability, or VM fault).

	runExperienceTest = async (body: ExperienceTestRunInput) => {
		const result = runExperienceTest(body);
		if (!result.ok) throw mapTestError(result.error);
		return result.data;
	};

	simulateExperienceTest = async (body: ExperienceTestSimulateInput) => {
		const result = simulateExperienceTest(body);
		if (!result.ok) throw mapTestError(result.error);
		return result.data;
	};

	// ── Interactive playground session driver (Wave 8 / IR-84A) ───────────────
	// The driver is an in-memory session driver: start creates the session and
	// advances leading script seats; advance applies one human action then
	// advances script seats. Both reuse the real kernel with ZERO persistence
	// and ZERO chat/session/DB binding. The typed error envelope is the same
	// shape the tester uses (409 stale_revision / 422 every authoring, validation,
	// capability, or VM fault, with captured console on the error path), so the
	// same mapTestError renders it.

	startExperiencePlayground = async (body: ExperiencePlaygroundStartInput) => {
		const result = startExperiencePlayground(
			body,
			this.playgroundChatter !== undefined ? { chatter: this.playgroundChatter } : undefined,
		);
		if (!result.ok) throw mapTestError(result.error);
		// IR-90E: if a model boundary was hit and a model seam is available,
		// execute the ephemeral model continuation before returning.
		return this.continueModelTurn(result.data);
	};

	advanceExperiencePlayground = async (body: ExperiencePlaygroundAdvanceInput) => {
		const result = advanceExperiencePlayground(body);
		if (!result.ok) throw mapTestError(result.error);
		return this.continueModelTurn(result.data);
	};

	/** Timer beats are a SEPARATE call (never chained into start/advance): the
	 *  sleep happens server-side, so chaining it would freeze the click's
	 *  response for afterMs and lag every input. The Try-it panel issues one
	 *  beat per response reporting pendingTimers > 0 (see
	 *  executeTimerTurnExperiencePlayground for the full semantics). */
	runExperiencePlaygroundTimer = async (body: { readonly playgroundSessionId: string }) => {
		const result = await executeTimerTurnExperiencePlayground(body);
		if (!result.ok) throw mapTestError(result.error);
		return result.data;
	};

	/** IR-90E: chain the ephemeral model turn when a start/advance returns a
	 *  pending model effect. The model turn executes the pending model effect
	 *  through the REAL provider executor (injected) with ZERO store writes,
	 *  feeding the result back via the real projected action/effect contract.
	 *  The Model Conversation rules give every seat the same legal actions, so
	 *  the boundary can be `awaiting_human` even when a model effect is pending —
	 *  the trigger is the presence of a model effect in this turn's delta, not
	 *  the stop reason. */
	private async continueModelTurn(data: ExperiencePlaygroundData): Promise<ExperiencePlaygroundData> {
		const hasPendingModelEffect = data.effects.some((e) => e.kind === "model");
		if (!hasPendingModelEffect || this.playgroundModelDeps === undefined) return data;
		const modelResult = await executeModelTurnExperiencePlayground(
			{ playgroundSessionId: data.playgroundSessionId },
			this.playgroundModelDeps,
		);
		if (!modelResult.ok) throw mapTestError(modelResult.error);
		return modelResult.data;
	}

	// ── Realtime round commit + model seam (RM-7 / RM-8) ────────────────────

	/** RM-7 contract, RM-8 service: replay-verify the round log, then ONE
	 *  terminal transition + the finish-writeback chat card. A tampered or
	 *  non-reproducible claim fails typed 422 `round_verification_failed`
	 *  with nothing applied (see ExperienceRoundService). */
	commitExperienceRound = async (
		sessionId: string,
		body: ExperienceRoundCommitRequestDto,
	): Promise<ExperienceQueuedAttachmentResponse> => {
		const committed = await this.lifecycle.commitRound(sessionId, body);
		if (!committed.ok) throw mapError(committed.error);
		return committed.data;
	};

	/** RM-7: one-shot non-streaming generation for a model seat. Session-less
	 *  and stateless — read-only provider resolution, NO effect row, the reply
	 *  is DATA the host posts back into the frame. The abort signal forwards to
	 *  the executor (client disconnect cancels the HTTP call). */
	runExperienceRoundModel = async (
		body: ExperienceRoundModelRequestDto,
		signal?: AbortSignal,
	): Promise<ExperienceRoundModelResponseDto> => {
		if (this.roundModelDeps === undefined) {
			throw new DomainError({
				kind: "Unprocessable",
				message: "No provider profiles available; cannot run a model seat",
				details: { code: "no_provider" },
			});
		}
		const input: ExperienceRoundModelInput = {
			seatId: body.seatId,
			...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
			providerProfileId: body.providerProfileId,
			modelId: body.modelId,
			prompt: body.prompt,
			signal,
		};
		const result = await this.roundModelDeps.run(input);
		if (!result.ok) throw mapRoundModelError(result.error);
		return result.data;
	};
}

/**
 * Map a typed round-model failure to a {@link DomainError}. 422 → Unprocessable
 * (invalid prompt / unknown provider / missing key / bad output shape), 500 →
 * Internal (the provider IO failed). The structured code + message ride in
 * `details` so the client can react to the specific failure.
 */
function mapRoundModelError(e: { code: string; message: string; status: 422 | 500 }): never {
	const kind = e.status === 422 ? "Unprocessable" : "Internal";
	throw new DomainError({ kind, message: e.message, details: { code: e.code } });
}

/**
 * Map a typed {@link ExperienceApiError} (which carries its own HTTP status) to
 * a {@link DomainError} the global onError handler renders. The experience
 * contract uses 422 for semantic rejections of well-formed input (illegal
 * action, missing method, denied capability), distinct from 400 malformed —
 * hence the `Unprocessable` kind. The structured `code` + any extra fields
 * (currentRevision, failedActionIndex, granted/needs, …) are preserved in
 * `details` so the client can react to the specific failure.
 */
function mapError(e: ExperienceApiError): never {
	const kind =
		e.status === 404 ? "NotFound" :
		e.status === 409 ? "Conflict" :
		e.status === 422 ? "Unprocessable" :
		"Internal";
	const { status: _drop, code, message, ...rest } = e;
	void _drop;
	throw new DomainError({ kind, message, details: { code, ...rest } });
}

/**
 * Map a typed {@link ExperienceTestError} (the stateless unsaved-source tester's
 * failure envelope) to a {@link DomainError}. The tester carries its own
 * host-managed status (409 for a stale-revision CAS conflict, 422 for every
 * authoring / validation / capability / VM fault), distinct from the persisted
 * service's {@link ExperienceApiError}; unlike that vocabulary, the tester
 * surface preserves the captured VM console on the error path so an author sees
 * `console.log` output before a throw. The structured `code` + kernel `kind` +
 * any extra fields (currentRevision, participantId, granted/needs) are carried
 * in `details` alongside the console.
 */
function mapTestError(e: ExperienceTestError): never {
	const kind = e.status === 409 ? "Conflict" : "Unprocessable";
	throw new DomainError({
		kind,
		message: e.message,
		details: {
			code: e.code,
			console: e.console,
			...(e.kind !== undefined ? { kind: e.kind } : {}),
			...(e.currentRevision !== undefined ? { currentRevision: e.currentRevision } : {}),
			...(e.participantId !== undefined ? { participantId: e.participantId } : {}),
			...(e.granted !== undefined ? { granted: e.granted } : {}),
			...(e.needs !== undefined ? { needs: e.needs } : {}),
		},
	});
}
