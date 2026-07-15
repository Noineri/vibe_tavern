/**
 * Scene Tracker service (SCENE_TRACKER_PLAN SCN-5).
 *
 * Owns the canonical per-variant Scene record lifecycle: generate (LLM, strict
 * schema-validated JSON), manual edit (validate-only, no LLM), delete, and
 * explicit cancel. Every record is owned by an immutable message variant
 * (`{ chatId, branchId, messageId, variantId }`), NOT chat-global like the
 * Objective Tracker. The two lanes are target-keyed (by `variantId`): a long LLM
 * lane that serializes generate/update per target, and a short atomic
 * read-modify-write commit lane shared by generate/edit/delete so a concurrent
 * edit never loses an LLM result (or vice versa).
 *
 * The generate path mirrors `ObjectiveService`: the LLM call goes through
 * `nonstreamingProviderExecute` (injected, default = the real executor) so the
 * full generate → parse → persist path is unit-testable without `mock.module()`
 * (AGENTS.md §1.4 — inject the dep, don't mock it globally). The prompt is built
 * by `getInsightsAssembler("scene")`, which reuses the chat-turn pipeline so the
 * Scene model sees the SAME RP world the main model sees — under the same preset
 * toggles — minus only the Objective and Scene self-injection layers (see
 * `insights-assembler.ts`); this avoids recursive/stale derived-state feedback.
 *
 * Freshness: each generation captures a `{ schemaHash, configRevision,
 * sourceHash }` baseline BEFORE the LLM await and re-validates it inside the
 * atomic commit lane. If the schema/config/variant-content drifted while the
 * model was working, the result is discarded and any prior record is preserved
 * (in-place Update overwrites ONLY on success; failure/cancel never persists).
 * `variantIndex` is never an identity — all ownership is the immutable variant id.
 *
 * This unit ships the service core + target/per-chat join seams. The chat-level
 * `waitForForwardState` composition (resolve latest selected variant → join/start
 * a target job) is Wave 4 (SCN-8); the typed HTTP routes are SCN-9; the derived
 * `insightsCurrentSceneJson` cache rebuild is SCN-6.
 */
import type {
	AssemblePromptResponse,
	ChatBranchId,
	ChatId,
	MessageId,
	MessageVariantId,
	SceneBackfillErrorEntry,
	SceneBackfillSummary,
	SceneTrackerConfig,
	SceneTrackerDsl,
	SceneTrackerRecord,
	Timestamp,
} from "@vibe-tavern/domain";
import { brandId, computeSceneSourceHash, normalizeSceneTrackerConfig, stripLabels, SCENE_BACKFILL_MODE } from "@vibe-tavern/domain";
import type { SceneBackfillMode } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { getInsightsAssembler } from "@vibe-tavern/prompt-pipeline";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import { buildSceneDataSchema, validateSceneData } from "@vibe-tavern/api-contracts";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderExecutionInput } from "../../infrastructure/ai/provider-execution-types.js";
import { resolveInsightsPrompt } from "./insights-prompts.js";
import { insightsAssemblyToPromptResponse } from "./objective-service.js";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import { parseStructuredOutput } from "./structured-output.js";
import { isSceneRecordCurrent } from "./scene-cache.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

type Execute = typeof nonstreamingProviderExecute;
type ResolvePrompt = typeof resolveInsightsPrompt;
type ResolvedProfile = ProviderExecutionInput["profile"];

/** Immutable Scene ownership identity. `variantId` is the canonical key. */
export interface SceneTarget {
	chatId: ChatId;
	branchId: ChatBranchId;
	messageId: MessageId;
	variantId: MessageVariantId;
}

export interface SceneAutoGenerateTrigger {
	chatId: string;
	branchId: string;
	messageId: string;
}

/** The chat-level Insights config gates Scene auto-generation (mirrors Objective's gate). */
function isTrackerEnabled(insightsConfig: Record<string, unknown>): boolean {
	return insightsConfig?.trackerEnabled === true;
}

/** One prior valid selected-variant record fed to the model as continuity input. */
export interface SceneContinuityRecord {
	variantId: MessageVariantId;
	sceneState: Record<string, unknown>;
}

/** One frozen manifest item in a Scene history-backfill run (SCN-14): a selected
 *  assistant variant captured oldest-to-newest at run start, with its then-
 *  current source/schema/config fingerprint so resume/retry can revalidate the
 *  item is still generatable before spending an LLM call on it. Plain-string ids
 *  — this is serialized to JSON in the run row, not a branded domain record. */
export interface SceneBackfillManifestItem {
	/** Position in the frozen manifest (0 = oldest). */
	index: number;
	branchId: string;
	messageId: string;
	variantId: string;
	sourceHash: string;
	schemaHash: string;
	configRevision: number;
}

/** Service-level backfill run status (SCN-14). Structurally compatible with the
 *  contract {@link SceneBackfillStatusResponse}; the adapter returns it as-is.
 *  The error/summary shapes are shared from `@vibe-tavern/domain`. */
export interface SceneBackfillStatus {
	runId: string;
	chatId: string;
	mode: string;
	status: string;
	total: number;
	processed: number;
	current: { messageId: string; variantId: string } | null;
	errors: SceneBackfillErrorEntry[];
	summary: SceneBackfillSummary | null;
	cancelRequested: boolean;
}

export interface SceneGenerateInput {
	target: SceneTarget;
	profile: ResolvedProfile;
	model: string;
	/** Full RP world context WITHOUT the objectiveTask/sceneState self-injection
	 *  layers (the scene assembler strips them). Built by the caller the same way
	 *  a chat turn is, sliced per `contextWindow`. */
	context: PromptAssemblyContext;
	/** Previous valid selected-variant records (oldest→newest) for continuity. */
	continuity?: SceneContinuityRecord[];
	signal?: AbortSignal;
}

/** Stamped on a record at generate/edit time; re-checked in the commit lane. */
interface SceneFreshness {
	schemaHash: string;
	configRevision: number;
	sourceHash: string;
}

/** A minimal view of a variant the service needs (content for source hashing). */
interface VariantContent {
	id: string;
	content: string;
}

/** Thrown as the abort reason when a target is explicitly cancelled. */
export class SceneTargetCancelledError extends Error {
	constructor(target: SceneTarget) {
		super(`Scene generation cancelled for variant '${target.variantId}'.`);
		this.name = "SceneTargetCancelledError";
	}
}

/** Thrown when the target variant disappeared (deleted) during a job. */
export class SceneTargetGoneError extends Error {
	constructor(target: SceneTarget) {
		super(`Scene target variant '${target.variantId}' no longer exists.`);
		this.name = "SceneTargetGoneError";
	}
}

/**
 * Compose the final Scene instruction: override-or-default base + the bounded
 * schema descriptor (so the model knows exactly which fields to fill) + the
 * continuity window (prior states to evolve from). The base is `scene-generate.md`
 * unless a per-chat override is set; this function only appends dynamic context.
 */
export function composeSceneInstruction(
	base: string,
	schema: SceneTrackerDsl,
	continuity: readonly SceneContinuityRecord[],
): string {
	const schemaJson = JSON.stringify(stripLabels(schema));
	const continuityJson =
		continuity.length > 0 ? JSON.stringify(continuity.map((record) => record.sceneState)) : "[]";
	return (
		`${base}\n\n` +
		`Scene schema (produce one JSON object with exactly these fields, no extras): ${schemaJson}\n\n` +
		`Recent scene continuity (prior states — evolve them to match the current scene): ${continuityJson}\n\n` +
		`Required output: one JSON object matching the schema exactly.`
	);
}

/** Forward an external AbortSignal onto a service-owned controller (one-shot). */
function linkAbort(external: AbortSignal | undefined, controller: AbortController): void {
	if (!external) return;
	if (external.aborted) {
		controller.abort(external.reason);
		return;
	}
	external.addEventListener(
		"abort",
		() => controller.abort(external.reason),
		{ once: true },
	);
}

// ─── SCN-14 backfill helpers (module-level, pure) ───────────────────────────

/** Inclusive-start, exclusive-end integer range (empty when start >= end). */
function range(start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i < end; i += 1) out.push(i);
	return out;
}

/** Unique integers sorted ascending (for the retry-index union). */
function uniqueSorted(values: number[]): number[] {
	return [...new Set(values)].sort((a, b) => a - b);
}

/** Parse a run row's errorsJson defensively; an unparseable/corrupt blob → []. */
function parseBackfillErrors(json: string): SceneBackfillErrorEntry[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? (parsed as SceneBackfillErrorEntry[]) : [];
	} catch {
		return [];
	}
}

/** Stable error-message extraction for recorded per-item errors. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Small FIFO keyed coordinator. Identical to `ObjectiveKeyedCoordinator` but the
 * key is the target (variant id) for Scene, not the chat — Scene work is
 * serialized per variant so two variants generate concurrently while one variant
 * never runs two LLM jobs (or a generate + its commit) at once.
 */
class TrackerKeyedCoordinator {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const slot = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => slot);
		this.tails.set(key, tail);

		await previous.catch(() => undefined);
		try {
			return await task();
		} finally {
			release?.();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

export class SceneTrackerService {
	/** Target-keyed in-flight generate jobs (resolved/rejected → undefined). Used
	 *  by the join seams; the chat-level wait composes over these in SCN-8. */
	private readonly targetJobs = new Map<string, Promise<void>>();
	/** One owned AbortController per active target so {@link cancelTarget} can
	 *  reach an in-flight generation without the caller's signal. */
	private readonly targetControllers = new Map<string, AbortController>();
	/** Long lane: generate/update LLM work is serialized per target variant. */
	private readonly llmCoordinator = new TrackerKeyedCoordinator();
	/** Short lane: every record read-modify-write commit is atomic per target. */
	private readonly commitCoordinator = new TrackerKeyedCoordinator();

	constructor(
		private readonly stores: StoreContainer,
		// sessionRuntime is used by the Wave 4 auto-start path (SCN-8) to build
		// the pipeline context; the SCN-5 core is exercised with `null as never`,
		// mirroring how `ObjectiveService` is tested.
		private readonly sessionRuntime: SessionRuntime,
		private readonly providerProfiles: ProviderProfileService,
		private readonly execute: Execute = nonstreamingProviderExecute,
		private readonly resolvePrompt: ResolvePrompt = resolveInsightsPrompt,
	) {}

	/** Load the chat's Scene config (normalized to fixed defaults when absent). */
	async getConfig(chatId: ChatId): Promise<SceneTrackerConfig> {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) return normalizeSceneTrackerConfig(undefined);
		return normalizeSceneTrackerConfig(chat.insightsConfig.tracker);
	}

	/** Read the target variant's current canonical record (null when absent).
	 *  The store holds plain-string records; the brand is applied at this
	 *  DB→domain read boundary (the inverse of the branded→plain write path). */
	async getRecord(target: SceneTarget): Promise<SceneTrackerRecord | null> {
		return (await this.stores.messages.getSceneRecord(target.variantId)) as SceneTrackerRecord | null;
	}

	/** Read the target variant's content (for source hashing + existence check). */
	private async getTargetVariant(target: SceneTarget): Promise<VariantContent | null> {
		const variants = await this.stores.messages.getVariants(target.messageId);
		const variant = variants.find((item) => item.id === (target.variantId as string));
		return variant ? { id: variant.id, content: variant.content } : null;
	}

	/**
	 * Generate a Scene record for the target variant via the LLM. Overwrites the
	 * prior record ONLY on success; any failure (provider error, malformed output,
	 * cancellation, or a schema/config/content drift detected at commit) discards
	 * the result and leaves the prior record untouched. Runs under the target LLM
	 * lane, then commits under the target atomic lane. The owned controller is
	 * reachable by {@link cancelTarget}; passing an external `signal` forwards it.
	 */
	async generateScene(input: SceneGenerateInput): Promise<SceneTrackerRecord> {
		const key = input.target.variantId as string;
		const controller = new AbortController();
		linkAbort(input.signal, controller);
		this.targetControllers.set(key, controller);

		const run = this.llmCoordinator.run(key, () => this.runGeneration(input, controller.signal));
		const swallowed = run.then(
			() => undefined,
			() => undefined,
		);
		this.targetJobs.set(key, swallowed);
		try {
			return await run;
		} finally {
			this.targetControllers.delete(key);
			if (this.targetJobs.get(key) === swallowed) this.targetJobs.delete(key);
		}
	}

	/** Generate core: build prompt → execute → strict-parse → freshness-guarded commit. */
	private async runGeneration(
		input: SceneGenerateInput,
		signal: AbortSignal,
	): Promise<SceneTrackerRecord> {
		signal.throwIfAborted();
		const config = await this.getConfig(input.target.chatId);
		const variant = await this.getTargetVariant(input.target);
		if (!variant) throw new SceneTargetGoneError(input.target);

		// Capture the freshness baseline BEFORE the await. A schema/config/content
		// edit during the LLM call invalidates this result at commit time.
		const baseline: SceneFreshness = {
			schemaHash: config.schemaHash,
			configRevision: config.revision,
			sourceHash: computeSceneSourceHash(variant.content),
		};

		const instructionBase = await this.resolvePrompt("sceneGenerate", config.generatePrompt);
		const instruction = composeSceneInstruction(instructionBase, config.schema, input.continuity ?? []);
		const prompt = this.buildPrompt(input.context, instruction);
		const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal });
		signal.throwIfAborted();

		// Generated output is ALWAYS strict schema-validated JSON against the
		// schema captured above; a mismatch throws and nothing is persisted.
		const sceneState = parseStructuredOutput(result.text, buildSceneDataSchema(config.schema));
		return this.commitRecord(input.target, baseline, sceneState, input.model, signal);
	}

	/**
	 * Atomic commit lane. Re-reads the live freshness and discards (throws) when
	 * schema/config/content drifted during the await, so a stale LLM result never
	 * overwrites a newer reality. Never clears on discard — the prior record, if
	 * any, is preserved (in-place Update overwrites only on success).
	 */
	private async commitRecord(
		target: SceneTarget,
		baseline: SceneFreshness,
		sceneState: Record<string, unknown>,
		model: string | null,
		signal: AbortSignal | undefined,
	): Promise<SceneTrackerRecord> {
		return this.commitCoordinator.run(target.variantId as string, async () => {
			signal?.throwIfAborted();
			const freshConfig = await this.getConfig(target.chatId);
			const freshVariant = await this.getTargetVariant(target);
			if (!freshVariant) throw new SceneTargetGoneError(target);

			const fresh: SceneFreshness = {
				schemaHash: freshConfig.schemaHash,
				configRevision: freshConfig.revision,
				sourceHash: computeSceneSourceHash(freshVariant.content),
			};
			if (
				fresh.schemaHash !== baseline.schemaHash ||
				fresh.configRevision !== baseline.configRevision ||
				fresh.sourceHash !== baseline.sourceHash
			) {
				throw new Error(
					`Scene target '${target.variantId}' is stale (schema/config/content changed during generation); result discarded.`,
				);
			}

			const record: SceneTrackerRecord = {
				variantId: target.variantId,
				schemaHash: baseline.schemaHash,
				configRevision: baseline.configRevision,
				sourceHash: baseline.sourceHash,
				sceneState,
				modelId: model,
				generatedAt: new Date().toISOString() as Timestamp,
			};
			await this.stores.messages.setSceneRecord(target.variantId, record);
			return record;
		});
	}

	/**
	 * Manual edit: validate user-supplied scene state against the current schema
	 * and commit (no LLM). Stamps the live schema/config/source metadata so the
	 * edited record is freshness-equivalent to a generated one. Throws on
	 * validation failure or if the target variant no longer exists.
	 */
	async editScene(target: SceneTarget, sceneState: Record<string, unknown>): Promise<SceneTrackerRecord> {
		return this.commitCoordinator.run(target.variantId as string, async () => {
			const config = await this.getConfig(target.chatId);
			const variant = await this.getTargetVariant(target);
			if (!variant) throw new SceneTargetGoneError(target);

			const parsed = validateSceneData(config.schema, sceneState);
			if (!parsed.success) {
				const detail = parsed.error.issues
					.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
					.join("; ");
				throw new Error(`Scene edit failed validation: ${detail}`);
			}

			const record: SceneTrackerRecord = {
				variantId: target.variantId,
				schemaHash: config.schemaHash,
				configRevision: config.revision,
				sourceHash: computeSceneSourceHash(variant.content),
				sceneState: parsed.data,
				modelId: null,
				generatedAt: new Date().toISOString() as Timestamp,
			};
			await this.stores.messages.setSceneRecord(target.variantId, record);
			return record;
		});
	}

	/** Remove the target variant's record. No-op-safe under the commit lane. */
	async deleteScene(target: SceneTarget): Promise<void> {
		return this.commitCoordinator.run(target.variantId as string, async () => {
			await this.stores.messages.clearSceneRecord(target.variantId);
		});
	}

	/**
	 * Explicitly cancel an in-flight generation for the target. Aborts the owned
	 * controller; the generation rejects and NOTHING is persisted (the abort is
	 * checked before the commit, and the commit lane never runs). The prior
	 * record, if any, is preserved. No-op when no generation is active.
	 */
	cancelTarget(target: SceneTarget): void {
		const key = target.variantId as string;
		const controller = this.targetControllers.get(key);
		if (!controller) return;
		controller.abort(new SceneTargetCancelledError(target));
		logSendDebug("insights.scene.cancel", { variantId: target.variantId });
	}

	/**
	 * Resolve the Scene generate provider + model from the stored config — mirrors
	 * `ObjectiveService.resolveInsightProvider`: `useChatModel` → the active
	 * profile + its default model; otherwise the pinned profile + optional model
	 * override. Returns null when no usable profile/model is configured.
	 */
	async resolveSceneProvider(
		config: SceneTrackerConfig,
	): Promise<{ profile: NonNullable<Awaited<ReturnType<ProviderProfileService["resolveActiveProviderProfile"]>>>; model: string } | null> {
		const profile = config.useChatModel
			? await this.providerProfiles.resolveActiveProviderProfile()
			: (config.providerProfileId ? await this.providerProfiles.getProviderProfile(config.providerProfileId) : null);
		if (!profile?.id) return null;
		const model = config.useChatModel
			? profile.defaultModel?.trim()
			: (config.model?.trim() || profile.defaultModel?.trim());
		if (!model) return null;
		return { profile: profile as NonNullable<Awaited<ReturnType<ProviderProfileService["resolveActiveProviderProfile"]>>>, model };
	}

	/**
	 * Collect the last `continuityLastN` valid selected-variant records from the
	 * branch, scanning backwards from the target (most recent first), returning
	 * them in conversation order (oldest→newest). A record is "valid" when its
	 * stamped `schemaHash`/`configRevision` match the current config — stale or
	 * wrong-schema records are excluded so continuity never feeds the model a
	 * shape it can no longer produce. Bounded: stops after N valid records.
	 */
	async collectContinuity(
		branchId: ChatBranchId,
		targetMessageId: MessageId,
		config: SceneTrackerConfig,
	): Promise<SceneContinuityRecord[]> {
		const limit = Math.max(0, config.continuityLastN);
		if (limit === 0) return [];

		const messages = await this.stores.messages.getMessages(branchId);
		const targetIdx = messages.findIndex((message) => message.id === (targetMessageId as string));
		const start = targetIdx >= 0 ? targetIdx - 1 : messages.length - 1;

		const collected: SceneContinuityRecord[] = [];
		for (let index = start; index >= 0 && collected.length < limit; index -= 1) {
			const message = messages[index];
			if (!message || message.role !== "assistant") continue;
			const selected = await this.stores.messages.getSelectedVariant(message.id);
			if (!selected) continue;
			const record = await this.stores.messages.getSceneRecord(selected.id);
			if (!record) continue;
			if (record.schemaHash !== config.schemaHash || record.configRevision !== config.revision) continue;
			collected.push({ variantId: selected.id as MessageVariantId, sceneState: record.sceneState });
		}
		return collected.reverse(); // oldest → newest for the prompt
	}

	/** Build the Scene one-shot prompt (RP world context + instruction) via the assembler registry. */
	private buildPrompt(context: PromptAssemblyContext, instruction: string): AssemblePromptResponse {
		const assembly = getInsightsAssembler("scene").assemble(context, instruction);
		return insightsAssemblyToPromptResponse(assembly);
	}

	// ─── target / per-chat join seams (consumed by SCN-8 auto-start + SCN-9 routes) ───

	/** The in-flight job for a target, if any (never rejects — failures are swallowed). */
	getTargetJob(target: SceneTarget): Promise<void> | undefined {
		return this.targetJobs.get(target.variantId as string);
	}

	/** Whether a generation is currently active for the target. */
	hasTargetJob(target: SceneTarget): boolean {
		return this.targetJobs.has(target.variantId as string);
	}

	/**
	 * Register an externally-managed target job (e.g. the SCN-8 auto-start that
	 * wraps generate). Failures are swallowed so a join never rejects. Replaces
	 * any existing job for the target.
	 */
	joinTargetJob(target: SceneTarget, job: Promise<unknown>): void {
		this.targetJobs.set(
			target.variantId as string,
			job.then(
				() => undefined,
				() => undefined,
			),
		);
	}

	// ─── SCN-8: auto-start + chat-level wait ─────────────────────────────────

	/**
	 * Event-driven auto-start (SCN-8). Fired by the Insights feature on each
	 * assistant `message.appended`. Resolves the appended message's selected
	 * variant; if the tracker is on and the variant's record is missing/stale,
	 * starts a background generation (fire-and-forget). Skips silently when the
	 * tracker is off, the variant has no selected variant, the record is already
	 * current, or no provider/model resolves. Errors are logged, never thrown —
	 * the EventBus caller never sees them (mirrors Objective.triggerAutoCheck).
	 */
	async triggerAutoGenerate(trigger: SceneAutoGenerateTrigger): Promise<void> {
		try {
			const chat = await this.stores.chats.getById(trigger.chatId);
			if (!chat || !isTrackerEnabled(chat.insightsConfig)) return;
			const config = await this.getConfig(trigger.chatId as ChatId);
			const selected = await this.stores.messages.getSelectedVariant(trigger.messageId);
			if (!selected) return;
			const record = await this.stores.messages.getSceneRecord(selected.id);
			if (record && isSceneRecordCurrent(record, config)) return; // already current
			const target: SceneTarget = {
				chatId: brandId<ChatId>(trigger.chatId),
				branchId: brandId<ChatBranchId>(trigger.branchId),
				messageId: brandId<MessageId>(trigger.messageId),
				variantId: brandId<MessageVariantId>(selected.id),
			};
			void this.ensureTargetJob(target);
		} catch (error: unknown) {
			logSendDebug("insights.scene.auto.error", {
				chatId: trigger.chatId as string,
				messageId: trigger.messageId as string,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Wait for the active branch's latest assistant selected-variant Scene to
	 * become current before the next main-model response (SCN-8). Resolves the
	 * latest target then delegates to {@link waitForTarget}. Cancelling the
	 * waiter DETACHES it — the shared background job keeps running. Never
	 * rejects: the underlying target job swallows failures, so a Scene generation
	 * error resolves the wait (the main model proceeds with latest-valid/no
	 * Scene) rather than blocking chat.
	 */
	async waitForForwardState(chatId: ChatId, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const chat = await this.stores.chats.getById(chatId);
		if (!chat || !isTrackerEnabled(chat.insightsConfig)) return;

		const latest = await this.stores.messages.getLatestSelectedVariant(chat.activeBranchId);
		if (!latest) return; // no latest assistant selected variant → nothing to track
		const target: SceneTarget = {
			chatId,
			branchId: brandId<ChatBranchId>(chat.activeBranchId),
			messageId: brandId<MessageId>(latest.messageId),
			variantId: brandId<MessageVariantId>(latest.variantId),
		};
		await this.waitForTarget(target, signal);
	}

	/**
	 * Wait for an EXACT target variant's Scene to settle (SCN-9 completion-refresh
	 * + the SCN-8 chokepoint via {@link waitForForwardState}). Joins an active
	 * target job; if none is active, returns immediately when the record is
	 * already current, otherwise starts a missing/stale job and joins it. Cancelling
	 * the waiter DETACHES it — the shared job keeps running. Never rejects (the
	 * underlying job swallows failures), so a generation error resolves the wait.
	 */
	async waitForTarget(target: SceneTarget, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		let job = this.getTargetJob(target);
		if (!job) {
			// No active job: if the record is already current, nothing to do;
			// otherwise (missing/stale) start one and join it.
			const config = await this.getConfig(target.chatId);
			const record = await this.stores.messages.getSceneRecord(target.variantId);
			if (record && isSceneRecordCurrent(record, config)) return;
			job = this.ensureTargetJob(target);
		}
		await this.waitCancellable(job, signal);
	}

	/**
	 * Full manual generation for a target (SCN-9 route path). Resolves the
	 * provider/model from the stored Scene config, builds the RP pipeline context
	 * (same shape a chat turn uses, sliced per `contextWindow`), collects
	 * continuity, and runs {@link generateScene}. Throws on any failure — no
	 * provider/model configured, provider error, malformed/oversized output,
	 * cancellation, or a schema/config/content drift detected at commit — so the
	 * route surfaces it. The prior record is preserved on every failure path
	 * (generateScene overwrites only on success). Mirrors {@link startAutoGenerate}'s
	 * setup but does NOT swallow — this is an explicit user action.
	 */
	async generateForTarget(target: SceneTarget, signal?: AbortSignal): Promise<SceneTrackerRecord> {
		const config = await this.getConfig(target.chatId);
		const resolved = await this.resolveSceneProvider(config);
		if (!resolved) {
			throw new Error("No provider/model configured for the Scene insight. Set one in Build Mode → Insights.");
		}
		const continuity = await this.collectContinuity(target.branchId, target.messageId, config);
		const built = await this.sessionRuntime.chatLifecycle.buildPipelineContext({
			chatId: target.chatId,
			branchId: target.branchId,
			model: resolved.model,
			recentMessageLimit: config.contextWindow,
		});
		return this.generateScene({
			target,
			profile: resolved.profile,
			model: resolved.model,
			context: built.context,
			continuity,
			signal,
		});
	}

	/**
	 * Non-persisting preview (SCN-11): run the full generate pipeline with a DRAFT
	 * config against the target variant and return the would-be record WITHOUT
	 * committing. No `setSceneRecord`, no coordinator lane, no `targetJobs`
	 * registration — a preview is an independent trial that must not join or
	 * block a real generation, and is cancellable only via the external signal.
	 * The config editor uses it to validate a schema/prompt/model change against
	 * the live RP world before saving. Mirrors {@link generateForTarget}'s setup
	 * but takes the config as an ARGUMENT (not from the store) and skips the
	 * commit + freshness re-check (a draft config is expected to differ from the
	 * stored one). Throws on any failure — the route surfaces it; the prior
	 * record is untouched because nothing is written.
	 */
	async previewForTarget(
		target: SceneTarget,
		draftConfig: SceneTrackerConfig,
		signal?: AbortSignal,
	): Promise<SceneTrackerRecord> {
		signal?.throwIfAborted();
		const resolved = await this.resolveSceneProvider(draftConfig);
		if (!resolved) {
			throw new Error("No provider/model configured for the Scene insight. Set one in Build Mode → Insights.");
		}
		const variant = await this.getTargetVariant(target);
		if (!variant) throw new SceneTargetGoneError(target);
		const continuity = await this.collectContinuity(target.branchId, target.messageId, draftConfig);
		const built = await this.sessionRuntime.chatLifecycle.buildPipelineContext({
			chatId: target.chatId,
			branchId: target.branchId,
			model: resolved.model,
			recentMessageLimit: draftConfig.contextWindow,
		});
		const instructionBase = await this.resolvePrompt("sceneGenerate", draftConfig.generatePrompt);
		const instruction = composeSceneInstruction(instructionBase, draftConfig.schema, continuity);
		const prompt = this.buildPrompt(built.context, instruction);
		const result = await this.execute({ profile: resolved.profile, model: resolved.model, prompt, signal });
		signal?.throwIfAborted();
		const sceneState = parseStructuredOutput(result.text, buildSceneDataSchema(draftConfig.schema));
		return {
			variantId: target.variantId,
			schemaHash: draftConfig.schemaHash,
			configRevision: draftConfig.revision,
			sourceHash: computeSceneSourceHash(variant.content),
			sceneState,
			modelId: resolved.model,
			generatedAt: new Date().toISOString() as Timestamp,
		};
	}

	/**
	 * Resolve-or-join the target's generation job. Registers EARLY (before the
	 * provider/context setup awaits) via {@link joinTargetJob} so a concurrent
	 * caller — the wait path racing the event-driven auto-start — joins the same
	 * job instead of starting a duplicate. The returned promise never rejects.
	 */
	private ensureTargetJob(target: SceneTarget): Promise<void> {
		const existing = this.getTargetJob(target);
		if (existing) return existing;
		const run = this.startAutoGenerate(target).then(
			() => undefined,
			() => undefined,
		);
		this.joinTargetJob(target, run);
		return run;
	}

	/**
	 * Full auto-generation setup for a target: resolve the provider/model, build
	 * the RP pipeline context (same shape a chat turn uses, sliced per
	 * `contextWindow`), collect continuity, and run {@link generateScene}. The
	 * generation registers + cleans up its own target job; this wrapper only adds
	 * the resolution/context build around it. Logs + returns on skip (no provider).
	 */
	private async startAutoGenerate(target: SceneTarget): Promise<void> {
		const config = await this.getConfig(target.chatId);
		const resolved = await this.resolveSceneProvider(config);
		if (!resolved) {
			logSendDebug("insights.scene.auto.skip", {
				chatId: target.chatId as string,
				variantId: target.variantId as string,
				reason: config.useChatModel ? "no_provider" : "no_provider_or_model",
			});
			return;
		}
		const continuity = await this.collectContinuity(target.branchId, target.messageId, config);
		const built = await this.sessionRuntime.chatLifecycle.buildPipelineContext({
			chatId: target.chatId,
			branchId: target.branchId,
			model: resolved.model,
			recentMessageLimit: config.contextWindow,
		});
		await this.generateScene({
			target,
			profile: resolved.profile,
			model: resolved.model,
			context: built.context,
			continuity,
		});
	}

	/** Wait on a (never-rejecting) job, detached by an abort signal. Mirrors
	 *  ObjectiveService.waitForForwardState's settle pattern: abort rejects the
	 *  WAITER (so the caller can cancel the send) but the job itself is untouched. */
	private waitCancellable(job: Promise<void>, signal?: AbortSignal): Promise<void> {
		if (!signal) return job;
		// The signal may have aborted DURING the setup awaits above (getById /
		// getLatestSelectedVariant / getConfig / getSceneRecord). addEventListener
		// won't fire for an already-aborted signal, so check up front — otherwise
		// the wait would hang with a lost abort.
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (callback: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				callback();
			};
			const onAbort = () => settle(() => reject(signal.reason));
			signal.addEventListener("abort", onAbort, { once: true });
			void job.then(
				() => settle(resolve),
				(error: unknown) => settle(() => reject(error)),
			);
		});
	}

	// ─── SCN-14: durable history backfill ──────────────────────────────────────
	// A server-authoritative BATCH over the per-target coordinator. Start freezes
	// an oldest-to-newest manifest of selected assistant variants; the loop
	// processes items SEQUENTIALLY (rate-limit-safe), revalidating each item's
	// frozen variant/source/schema/config/branch fingerprint before generation,
	// continuing through per-item errors, and advancing a durable cursor + errors
	// list after every item so a reload/restart resumes from the right place. The
	// batch NEVER blocks ordinary chat: it runs fire-and-forget in the background,
	// and each item's generation registers a normal per-target job — so the ONLY
	// interaction with a chat send is that the latest selected target (if it is in
	// the manifest) can independently join the normal send wait, exactly like any
	// other Scene generation. Cancel aborts the active item (its result never
	// persists — the commit lane checks the signal) and stops the loop.

	/** One owned AbortController per ACTIVE run so {@link cancelBackfill} can reach
	 *  the in-flight item's generation without the caller's signal. */
	private readonly activeBackfills = new Map<string, AbortController>();
	/** The manifest item being generated RIGHT NOW (in-memory only; drives status
	 *  `current`). Absent on reload until the run reattaches. */
	private readonly currentBackfillItem = new Map<string, { messageId: string; variantId: string }>();

	/** Start a backfill run for the chat's active branch. Freezes the manifest,
	 *  writes the run row, kicks off the background loop, and returns the initial
	 *  status. Idempotent: if a non-terminal run already exists for the chat it is
	 *  reattached (and resumed if stale) instead of starting a duplicate. Throws
	 *  when the chat is missing, the tracker is off, or no provider/model resolves. */
	async startBackfill(chatId: ChatId, mode: SceneBackfillMode): Promise<SceneBackfillStatus> {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw new Error(`Chat '${chatId}' was not found.`);
		if (!isTrackerEnabled(chat.insightsConfig)) {
			throw new Error("Scene Tracker is off — enable it in Build Mode → Insights before backfilling history.");
		}
		const config = await this.getConfig(chatId);
		const resolved = await this.resolveSceneProvider(config);
		if (!resolved) {
			throw new Error("No provider/model configured for the Scene insight. Set one in Build Mode → Insights.");
		}
		// Reattach to an in-flight run instead of starting a duplicate.
		const active = await this.stores.messages.getActiveSceneBackfillRun(chatId as string);
		if (active) {
			this.ensureRunProcessing(chatId, active);
			return this.runToStatus(active);
		}
		const manifest = await this.buildBackfillManifest(chat.activeBranchId, mode, config);
		const run = await this.stores.messages.createSceneBackfillRun({
			chatId: chatId as string,
			mode,
			manifestJson: JSON.stringify(manifest),
			totalItems: manifest.length,
		});
		if (manifest.length === 0) {
			// Empty manifest → nothing to do; finalize immediately as completed.
			const summary: SceneBackfillSummary = { total: 0, succeeded: 0, skipped: 0, failed: 0 };
			await this.stores.messages.updateSceneBackfillRun(run.id, { status: "completed", summaryJson: JSON.stringify(summary) });
		} else {
			this.kickoffBackfill(chatId, run.id, manifest.map((item) => item.index));
		}
		const fresh = await this.stores.messages.getSceneBackfillRun(run.id);
		return this.runToStatus(fresh!);
	}

	/** Server-authoritative status for progress polling / reload reattachment
	 *  (SCN-14). A 'running'/'pending' run with no in-memory handle was
	 *  interrupted by a restart — its unprocessed tail is resumed here (restart-
	 *  safe). Returns the live row + the in-memory `current` item. */
	async getBackfillStatus(chatId: ChatId, runId: string): Promise<SceneBackfillStatus> {
		const run = await this.loadOwnedRun(chatId, runId);
		this.ensureRunProcessing(chatId, run);
		return this.runToStatus(run);
	}

	/** Explicitly cancel a run (SCN-14). Sets the durable cancel flag AND aborts
	 *  the active item's generation — its result never persists (the commit lane
	 *  checks the signal), and the loop stops before the next item. No-op when the
	 *  run is terminal or not in memory. */
	cancelBackfill(chatId: ChatId, runId: string): void {
		void this.stores.messages.updateSceneBackfillRun(runId, { cancelRequested: true }).catch(() => undefined);
		this.activeBackfills.get(runId)?.abort();
		logSendDebug("insights.scene.backfill.cancel", { runId });
	}

	/** Retry/resume a TERMINAL run's failed + unprocessed items (SCN-14). The
	 *  retry set is the union of errored manifest indices and the unprocessed
	 *  tail (cursor..total); succeeded items are never regenerated. Reopens the
	 *  run (clears cancel + summary) and kicks off the loop. No-op (returns the
	 *  current status) when the run is still active or there is nothing to retry. */
	async retryBackfill(chatId: ChatId, runId: string): Promise<SceneBackfillStatus> {
		const run = await this.loadOwnedRun(chatId, runId);
		if (run.status === "running" || run.status === "pending" || this.activeBackfills.has(runId)) {
			return this.runToStatus(run);
		}
		const errors = parseBackfillErrors(run.errorsJson);
		const retryIndices = uniqueSorted([...errors.map((entry) => entry.index), ...range(run.cursor, run.totalItems)]);
		if (retryIndices.length === 0) return this.runToStatus(run);
		this.kickoffBackfill(chatId, runId, retryIndices);
		const fresh = await this.stores.messages.getSceneBackfillRun(runId);
		return this.runToStatus(fresh!);
	}

	/** Resume a non-terminal run if it is not already in flight (restart-safe /
	 *  reload reattachment). Processes the unprocessed tail (cursor..total). */
	private ensureRunProcessing(chatId: ChatId, run: { id: string; status: string; cursor: number; totalItems: number }): void {
		if (run.status !== "running" && run.status !== "pending") return;
		if (this.activeBackfills.has(run.id)) return;
		const tail = range(run.cursor, run.totalItems);
		if (tail.length === 0) {
			// Status says running/pending but nothing remains + not in memory → finalize.
			void this.finalizeRun(run.id);
			return;
		}
		this.kickoffBackfill(chatId, run.id, tail);
	}

	/** Fire-and-forget a processing pass over `indices`. Double-start guard is
	 *  inside {@link runBackfillLoop} (synchronous check-and-set). */
	private kickoffBackfill(chatId: ChatId, runId: string, indices: number[]): void {
		if (this.activeBackfills.has(runId)) return;
		void this.runBackfillLoop(chatId, runId, indices);
	}

	/** The sequential processing loop (SCN-14). Processes `indices` in order,
	 *  revalidating + generating each, continuing through per-item errors, and
	 *  persisting the cursor + errors after every item. Cancel (DB flag or the
	 *  owned controller) stops before the next item; the active item's result is
	 *  discarded (its generation aborts before the commit lane persists). */
	private async runBackfillLoop(chatId: ChatId, runId: string, indices: number[]): Promise<void> {
		// Synchronous double-start guard: two callers (start + status-resume, or
		// retry + status-resume) cannot both enter. The set happens before the
		// first await, so by the time this call returns the slot is reserved.
		if (this.activeBackfills.has(runId)) return;
		const controller = new AbortController();
		this.activeBackfills.set(runId, controller);
		try {
			const initial = await this.stores.messages.getSceneBackfillRun(runId);
			if (!initial) return;
			await this.stores.messages.updateSceneBackfillRun(runId, { status: "running", cancelRequested: false, summaryJson: null });
			const manifest = JSON.parse(initial.manifestJson) as SceneBackfillManifestItem[];
			const mode = initial.mode as SceneBackfillMode;
			let errors = parseBackfillErrors(initial.errorsJson);
			let cursor = initial.cursor;

			for (const idx of indices) {
				if (controller.signal.aborted) break;
				const polled = await this.stores.messages.getSceneBackfillRun(runId);
				if (polled?.cancelRequested) break;

				const item = manifest[idx];
				if (!item) continue;

				this.currentBackfillItem.set(runId, { messageId: item.messageId, variantId: item.variantId });
				const outcome = await this.processBackfillItem(chatId, item, mode, controller.signal);
				this.currentBackfillItem.delete(runId);

				if (outcome.cancelled) break;

				// Drop any prior error for this index; record a new one on failure/skip.
				errors = errors.filter((entry) => entry.index !== idx);
				if (outcome.error) {
					errors.push({ index: idx, variantId: item.variantId, messageId: item.messageId, kind: outcome.error.kind, message: outcome.error.message });
				}
				cursor = Math.max(cursor, idx + 1);
				await this.stores.messages.updateSceneBackfillRun(runId, { cursor, errorsJson: JSON.stringify(errors) });
			}

			await this.finalizeRun(runId);
		} catch (error: unknown) {
			// An unrecoverable LOOP error (not a per-item error — those are caught
			// inside processBackfillItem). Mark the run failed so it is retryable.
			logSendDebug("insights.scene.backfill.error", { runId, message: errorMessage(error) });
			await this.stores.messages.updateSceneBackfillRun(runId, { status: "failed" }).catch(() => undefined);
		} finally {
			this.activeBackfills.delete(runId);
			this.currentBackfillItem.delete(runId);
		}
	}

	/** Process one manifest item: revalidate the frozen fingerprint, then generate
	 *  (fill-missing skips items that became current). Returns the outcome — a
	 *  `cancelled` outcome stops the loop without persisting the active item; an
	 *  `error` outcome is recorded and the loop continues (continue-through-errors). */
	private async processBackfillItem(
		chatId: ChatId,
		item: SceneBackfillManifestItem,
		mode: SceneBackfillMode,
		signal: AbortSignal,
	): Promise<{ cancelled?: boolean; error?: { kind: "failed" | "skipped"; message: string } }> {
		try {
			signal.throwIfAborted();
			// revalidate: message still in its frozen branch.
			const branchMessages = await this.stores.messages.getMessages(item.branchId);
			if (!branchMessages.some((message) => message.id === item.messageId)) {
				return { error: { kind: "skipped", message: "Message no longer in its branch." } };
			}
			// revalidate: variant still exists on the message.
			const variants = await this.stores.messages.getVariants(item.messageId);
			const variant = variants.find((candidate) => candidate.id === item.variantId);
			if (!variant) return { error: { kind: "skipped", message: "Variant no longer exists." } };
			// revalidate: schema/config fingerprint unchanged since freeze.
			const config = await this.getConfig(chatId);
			if (config.schemaHash !== item.schemaHash || config.revision !== item.configRevision) {
				return { error: { kind: "skipped", message: "Scene schema/config changed since the run started." } };
			}
			// revalidate: variant content unchanged since freeze.
			if (computeSceneSourceHash(variant.content) !== item.sourceHash) {
				return { error: { kind: "skipped", message: "Variant content changed since the run started." } };
			}
			// fill-missing: a current record appeared (e.g. via auto-gen) → success no-op.
			const record = await this.stores.messages.getSceneRecord(item.variantId);
			if (mode === SCENE_BACKFILL_MODE.fillMissing && record && isSceneRecordCurrent(record, config)) {
				return {};
			}
			// Generate. Reuses the shared per-target coordinator + target-job registry,
			// so the latest selected target can independently join a normal send wait.
			const target: SceneTarget = {
				chatId,
				branchId: brandId<ChatBranchId>(item.branchId),
				messageId: brandId<MessageId>(item.messageId),
				variantId: brandId<MessageVariantId>(item.variantId),
			};
			await this.generateForTarget(target, signal);
			return {};
		} catch (error: unknown) {
			if (signal.aborted || error instanceof SceneTargetCancelledError) return { cancelled: true };
			if (error instanceof SceneTargetGoneError) {
				return { error: { kind: "skipped", message: "Target variant disappeared during generation." } };
			}
			return { error: { kind: "failed", message: errorMessage(error) } };
		}
	}

	/** Freeze the oldest-to-newest manifest of selected assistant variants for the
	 *  branch (SCN-14). fill-missing omits items that already have a current
	 *  record; rebuild includes every selected assistant variant. Each item
	 *  captures the source/schema/config fingerprint at freeze time. */
	private async buildBackfillManifest(
		branchId: string,
		mode: SceneBackfillMode,
		config: SceneTrackerConfig,
	): Promise<SceneBackfillManifestItem[]> {
		const messages = await this.stores.messages.getMessages(branchId);
		const items: SceneBackfillManifestItem[] = [];
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const selected = await this.stores.messages.getSelectedVariant(message.id);
			if (!selected) continue;
			if (mode === SCENE_BACKFILL_MODE.fillMissing) {
				const record = await this.stores.messages.getSceneRecord(selected.id);
				if (record && isSceneRecordCurrent(record, config)) continue;
			}
			items.push({
				index: items.length,
				branchId,
				messageId: message.id,
				variantId: selected.id,
				sourceHash: computeSceneSourceHash(selected.content),
				schemaHash: config.schemaHash,
				configRevision: config.revision,
			});
		}
		return items;
	}

	/** Write the terminal status + partial-success summary for a run (SCN-14).
	 *  `cancelled` if the durable flag is set; otherwise `completed` (per-item
	 *  failures are reflected in the summary, not the status). */
	private async finalizeRun(runId: string): Promise<void> {
		const run = await this.stores.messages.getSceneBackfillRun(runId);
		if (!run) return;
		const errors = parseBackfillErrors(run.errorsJson);
		const failed = errors.filter((entry) => entry.kind === "failed").length;
		const skipped = errors.filter((entry) => entry.kind === "skipped").length;
		// All error entries correspond to processed items (index < cursor), so
		// succeeded = processed minus the errored/skipped count.
		const succeeded = Math.max(0, run.cursor - errors.length);
		const summary: SceneBackfillSummary = { total: run.totalItems, succeeded, skipped, failed };
		const status = run.cancelRequested ? "cancelled" : "completed";
		await this.stores.messages.updateSceneBackfillRun(runId, { status, summaryJson: JSON.stringify(summary) });
	}

	/** Load a run, validating it belongs to the chat. Throws if missing/mismatched. */
	private async loadOwnedRun(chatId: ChatId, runId: string) {
		const run = await this.stores.messages.getSceneBackfillRun(runId);
		if (!run || run.chatId !== (chatId as string)) {
			throw new Error(`Backfill run '${runId}' was not found for chat '${chatId}'.`);
		}
		return run;
	}

	/** Map a run row to the service-level status DTO, reading the live `current`
	 *  item from the in-memory map. */
	private runToStatus(run: { id: string; chatId: string; mode: string; status: string; totalItems: number; cursor: number; errorsJson: string; summaryJson: string | null; cancelRequested: boolean }): SceneBackfillStatus {
		return {
			runId: run.id,
			chatId: run.chatId,
			mode: run.mode,
			status: run.status,
			total: run.totalItems,
			processed: run.cursor,
			current: this.currentBackfillItem.get(run.id) ?? null,
			errors: parseBackfillErrors(run.errorsJson),
			summary: run.summaryJson ? (JSON.parse(run.summaryJson) as SceneBackfillSummary) : null,
			cancelRequested: run.cancelRequested,
		};
	}
}
