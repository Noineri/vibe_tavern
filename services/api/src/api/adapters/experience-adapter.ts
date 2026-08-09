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
} from "../contract/runtime-api.js";
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
import { DomainError } from "../../shared/errors.js";

export class ExperienceAdapter implements ExperienceRuntimeApi {
	constructor(
		private readonly lifecycle: ExperienceService,
		private readonly resources: ExperienceResourceService,
		private readonly replay: ExperienceReplayService,
		private readonly modelEffect: ExperienceModelEffectService,
		private readonly contextService: ExperienceContextService,
	) {}

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

	/** Canonical explicit user finish. The report service appends the durable
	 * public system event, releases the slot, and freezes the terminal snapshot
	 * in one synchronous SQLite transaction. */
	endExperienceSession = async (sessionId: string, body: { expectedRevision: number }) => {
		const finished = await this.lifecycle.finishWithReport(sessionId, body.expectedRevision);
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
	 *  persists `cancelled` (Wave 4 durable interruption policy). */
	runExperienceEffect = async (
		effectId: string,
		signal?: AbortSignal,
	): Promise<import("../contract/runtime-api.js").ExperienceEffectRunResponse> => {
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

	// ─── Context capture + status (IR-70D) ────────────────────────────────────

	/** Explicit cancellable context capture. Requires `rp_context`. The signal
	 *  passes through so a client disconnect persists nothing and preserves the
	 *  prior bundle. */
	captureExperienceContext = async (
		sessionId: string,
		body: { mode?: import("@vibe-tavern/domain").ExperienceContextMode; providerProfileId?: string; model?: string; recentMessageLimit?: number },
		signal?: AbortSignal,
	): Promise<ExperienceContextStatusDto> => {
		const row = await this.contextService.captureContext({ sessionId, ...body, signal });
		return {
			sessionId: row.sessionId,
			mode: row.mode as import("@vibe-tavern/domain").ExperienceContextMode,
			branchFrontierRevision: row.branchFrontierRevision,
			messageFrontierPosition: row.messageFrontierPosition,
			providerProfileId: row.providerProfileId,
			modelId: row.modelId,
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
