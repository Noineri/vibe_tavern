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
	SceneTrackerConfig,
	SceneTrackerDsl,
	SceneTrackerRecord,
	Timestamp,
} from "@vibe-tavern/domain";
import { computeSceneSourceHash, normalizeSceneTrackerConfig } from "@vibe-tavern/domain";
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

/** One prior valid selected-variant record fed to the model as continuity input. */
export interface SceneContinuityRecord {
	variantId: MessageVariantId;
	sceneState: Record<string, unknown>;
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
	const schemaJson = JSON.stringify(schema);
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
}
