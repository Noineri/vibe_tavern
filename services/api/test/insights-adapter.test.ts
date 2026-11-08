import { describe, expect, it } from "bun:test";
import type { Message } from "@vibe-tavern/db";
import type { ObjectiveState, SceneTrackerRecord } from "@vibe-tavern/domain";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import { OBJECTIVE_MODE, OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import type { SceneBackfillStatus } from "@vibe-tavern/api-contracts";
import { InsightsAdapter } from "../src/api/adapters/insights-adapter.js";
import { countTokensDefault } from "../src/infrastructure/ai/tokenizer-service.js";
import { defaultObjectiveState } from "@vibe-tavern/domain";
import type { SceneTrackerService, SceneTarget } from "../src/domain/insights/tracker-service.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import {
	makeChatBranchRow,
	makeChatRow,
	makeConfigPatchResponse,
	makeInsightsStores,
	makeMessageRow,
	makeObjectiveService,
	makePromptContext,
	makeSceneTracker,
	makeSceneTrackerRecord,
	makeSessionRuntime,
	makeVariantRow,
} from "./insights-test-builders.js";
import { makeProviderProfileRow } from "./copilot-test-builders.js";

const COMPLETION_TARGET = { branchId: "branch_1", messageId: "msg_1" };
const SCENE_TARGET = { branchId: "branch_1", messageId: "msg_1", variantId: "var_1" };

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

/** A minimal assistant message + a single selected variant for DTO building. */
const MESSAGE_ROW = makeMessageRow({ id: "msg_1" });
const VARIANT_ROW = makeVariantRow();

type TrackerMock = Partial<SceneTrackerService>;

function noopTracker(overrides: TrackerMock = {}): TrackerMock {
	return {
		waitForForwardState: async () => undefined,
		waitForTarget: async () => undefined,
		generateForTarget: async () => ({}) as never,
		previewForTarget: async () => ({}) as never,
		editScene: async () => ({}) as never,
		deleteScene: async () => undefined,
		cancelTarget: () => undefined,
		getRecord: async () => null,
		hasTargetJob: () => false,
		...overrides,
	} as TrackerMock;
}

/** The tracker double the adapter receives: the noop fixture wrapped in the
 *  strict seam (replaces the old `noopTracker(...) as SceneTrackerService`
 *  single-cast hand-offs). */
function trackerDouble(overrides: TrackerMock = {}) {
	return makeSceneTracker(noopTracker(overrides));
}

function completionAdapter(options?: {
	state?: ObjectiveState;
	messageAtRead?: (read: number) => Message | null;
	waitForForwardState?: (chatId: string, signal?: AbortSignal) => Promise<void>;
	tracker?: TrackerMock;
}) {
	let messageReads = 0;
	const stores = makeInsightsStores({
		chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
		messages: {
			getMessageById: async () => {
				messageReads += 1;
				if (options?.messageAtRead) return options.messageAtRead(messageReads);
				return makeMessageRow({
					id: COMPLETION_TARGET.messageId,
					chatId: "chat_1",
					branchId: COMPLETION_TARGET.branchId,
					role: "assistant",
				});
			},
		},
	});
	const objectiveService = makeObjectiveService({
		waitForForwardState: options?.waitForForwardState ?? (async () => undefined),
		getState: async () => options?.state ?? defaultObjectiveState(),
	});
	return new InsightsAdapter(stores, {} as SessionRuntime, objectiveService, trackerDouble(options?.tracker));
}

describe("InsightsAdapter Objective context", () => {
	it("uses the stored contextWindow for manual generation", async () => {
		const state: ObjectiveState = { ...defaultObjectiveState(), contextWindow: 4 };
		let recentMessageLimit: number | undefined;
		let receivedContext: unknown;
		const context: PromptAssemblyContext = makePromptContext({ identity: { chatId: "chat_1" } });

		const stores = makeInsightsStores({
			chats: { getById: async () => makeChatRow() },
		});
		const sessionRuntime = makeSessionRuntime({
			chatLifecycle: {
				buildPipelineContext: async (input: { recentMessageLimit?: number }) => {
					recentMessageLimit = input.recentMessageLimit;
					return { context };
				},
			},
			buildConfigPatchResponse: async () => makeConfigPatchResponse(),
		});
		const objectiveService = makeObjectiveService({
			getState: async () => state,
			resolveInsightProvider: async () => ({ profile: makeProviderProfileRow({ defaultModel: "test-model" }), model: "test-model" }),
			generateTasks: async (input: { context: unknown }) => {
				receivedContext = input.context;
				return state;
			},
		});

		const adapter = new InsightsAdapter(stores, sessionRuntime, objectiveService, trackerDouble());
		await adapter.generateObjectiveTasks("chat_1", {});

		expect(recentMessageLimit).toBe(4);
		expect(receivedContext).toBe(context);
	});
});

describe("InsightsAdapter Objective goals operations (OGM)", () => {
  it("delegates mode/long-term/short-term mutations and refreshes activeChat", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const refreshes: Array<{ chatId: string; flags: unknown }> = [];
    const stores = makeInsightsStores({
      chats: { getById: async () => makeChatRow() },
    });
    const sessionRuntime = makeSessionRuntime({
      buildConfigPatchResponse: async (chatId: string, flags: unknown) => {
        refreshes.push({ chatId, flags });
        return makeConfigPatchResponse();
      },
    });
    const objectiveService = makeObjectiveService({
      setObjectiveMode: async (...args: unknown[]) => { calls.push({ method: "mode", args }); return defaultObjectiveState(); },
      updateLongTermGoal: async (...args: unknown[]) => { calls.push({ method: "long-term", args }); return defaultObjectiveState(); },
      addShortTermGoal: async (...args: unknown[]) => { calls.push({ method: "short-add", args }); return defaultObjectiveState(); },
      updateShortTermGoal: async (...args: unknown[]) => { calls.push({ method: "short-update", args }); return defaultObjectiveState(); },
      deleteShortTermGoal: async (...args: unknown[]) => { calls.push({ method: "short-delete", args }); return defaultObjectiveState(); },
      selectShortTermGoal: async (...args: unknown[]) => { calls.push({ method: "short-select", args }); return defaultObjectiveState(); },
    });
    const adapter = new InsightsAdapter(stores, sessionRuntime, objectiveService, trackerDouble());

    await adapter.setObjectiveMode("chat_1", { mode: OBJECTIVE_MODE.goals });
    await adapter.updateObjectiveLongTermGoal("chat_1", { description: "Free the city", status: OBJECTIVE_TASK_STATUS.active });
    await adapter.addObjectiveShortTermGoal("chat_1", { description: "Reach the gate" });
    await adapter.updateObjectiveShortTermGoal("chat_1", "goal_1", { status: OBJECTIVE_TASK_STATUS.completed });
    await adapter.deleteObjectiveShortTermGoal("chat_1", "goal_1");
    await adapter.selectObjectiveShortTermGoal("chat_1", { goalId: "goal_2" });

    expect(calls).toEqual([
      { method: "mode", args: ["chat_1", OBJECTIVE_MODE.goals] },
      { method: "long-term", args: ["chat_1", { description: "Free the city", status: OBJECTIVE_TASK_STATUS.active }] },
      { method: "short-add", args: ["chat_1", "Reach the gate"] },
      { method: "short-update", args: ["chat_1", "goal_1", { status: OBJECTIVE_TASK_STATUS.completed }] },
      { method: "short-delete", args: ["chat_1", "goal_1"] },
      { method: "short-select", args: ["chat_1", "goal_2"] },
    ]);
    expect(refreshes).toHaveLength(6);
    expect(refreshes.every((entry) => entry.chatId === "chat_1" && JSON.stringify(entry.flags) === JSON.stringify({ activeChat: true }))).toBe(true);
  });
});

describe("InsightsAdapter completion refresh", () => {
	it("returns the current scoped insight patch immediately when no job exists", async () => {
		const state = { ...defaultObjectiveState(), objectiveDescription: "Reach the gate" };
		const adapter = completionAdapter({ state });

		await expect(adapter.refreshInsightsCompletion("chat_1", { target: COMPLETION_TARGET })).resolves.toEqual({
			target: { chatId: "chat_1", ...COMPLETION_TARGET },
			patch: { objectiveState: state },
		});
	});

	it("waits for an in-flight job before reading the refreshed state", async () => {
		const gate = deferred();
		const state = { ...defaultObjectiveState(), objectiveDescription: "Committed state" };
		let stateReads = 0;
		const stores = makeInsightsStores({
			chats: { getById: async () => makeChatRow() },
			messages: { getMessageById: async () => makeMessageRow({ id: COMPLETION_TARGET.messageId, branchId: COMPLETION_TARGET.branchId, role: "assistant" }) },
		});
		const service = makeObjectiveService({
			waitForForwardState: async () => gate.promise,
			getState: async () => { stateReads += 1; return state; },
		});
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, service, trackerDouble());

		const refreshing = adapter.refreshInsightsCompletion("chat_1", { target: COMPLETION_TARGET });
		await Promise.resolve();
		expect(stateReads).toBe(0);

		gate.resolve();
		await expect(refreshing).resolves.toEqual({
			target: { chatId: "chat_1", ...COMPLETION_TARGET },
			patch: { objectiveState: state },
		});
		expect(stateReads).toBe(1);
	});

	it("returns the committed state when the joined job already completed", async () => {
		const state = { ...defaultObjectiveState(), tasks: [{ id: "task_1", description: "Done", status: "completed" as const }] };
		const completed = Promise.resolve();
		const adapter = completionAdapter({
			state,
			waitForForwardState: async () => completed,
		});

		const response = await adapter.refreshInsightsCompletion("chat_1", { target: COMPLETION_TARGET });
		expect(response.patch.objectiveState).toEqual(state);
	});

	it("forwards cancellation to the waiter without cancelling the shared job", async () => {
		const sharedJob = deferred();
		let sharedCommitted = false;
		void sharedJob.promise.then(() => { sharedCommitted = true; });
		const adapter = completionAdapter({
			waitForForwardState: async (_chatId, signal) => {
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => reject(signal?.reason);
					signal?.addEventListener("abort", onAbort, { once: true });
					void sharedJob.promise.then(resolve);
				});
			},
		});
		const controller = new AbortController();
		const cancellation = new Error("cancel refresh");

		const refreshing = adapter.refreshInsightsCompletion("chat_1", { target: COMPLETION_TARGET }, controller.signal);
		await Promise.resolve();
		controller.abort(cancellation);

		await expect(refreshing).rejects.toBe(cancellation);
		expect(sharedCommitted).toBe(false);
		sharedJob.resolve();
		await sharedJob.promise;
		await Promise.resolve();
		expect(sharedCommitted).toBe(true);
	});

	it("rejects a target owned by another chat before joining", async () => {
		let waitCalls = 0;
		const adapter = completionAdapter({
			messageAtRead: () => makeMessageRow({ id: COMPLETION_TARGET.messageId, branchId: COMPLETION_TARGET.branchId, chatId: "chat_2", role: "assistant" }),
			waitForForwardState: async () => { waitCalls += 1; },
		});

		await expect(adapter.refreshInsightsCompletion("chat_1", { target: COMPLETION_TARGET })).rejects.toThrow("does not belong");
		expect(waitCalls).toBe(0);
	});

	it("rejects a target that becomes stale while waiting", async () => {
		const gate = deferred();
		const adapter = completionAdapter({
			messageAtRead: (read) => read === 1
				? makeMessageRow({ id: COMPLETION_TARGET.messageId, branchId: COMPLETION_TARGET.branchId, chatId: "chat_1", role: "assistant" })
				: null,
			waitForForwardState: async () => gate.promise,
		});

		const refreshing = adapter.refreshInsightsCompletion("chat_1", { target: COMPLETION_TARGET });
		await Promise.resolve();
		gate.resolve();
		await expect(refreshing).rejects.toThrow("is no longer available");
	});
});

describe("InsightsAdapter Scene manual routes (SCN-9)", () => {
function sceneAdapter(options?: {
	generateForTarget?: (target: SceneTarget, signal?: AbortSignal) => Promise<SceneTrackerRecord>;
	previewForTarget?: (target: SceneTarget, config: unknown, signal?: AbortSignal) => Promise<SceneTrackerRecord>;
	editScene?: (target: SceneTarget, sceneState: Record<string, unknown>) => Promise<SceneTrackerRecord>;
	deleteScene?: (target: SceneTarget) => Promise<void>;
	cancelTarget?: (target: SceneTarget) => void;
	record?: SceneTrackerRecord | null;
	generating?: boolean;
	/** The active branch's latest selected assistant variant; defaults to SCENE_TARGET
	 *  (target is latest). Set to a newer message to exercise the retro-generation guard. */
	latestTarget?: { messageId: string; variantId: string } | null;
	activeBranchId?: string;
}) {
	const tracker = trackerDouble({
		generateForTarget: options?.generateForTarget ?? (async () => makeSceneTrackerRecord()),
		previewForTarget: options?.previewForTarget ?? (async () => makeSceneTrackerRecord()),
		editScene: options?.editScene ?? (async () => makeSceneTrackerRecord()),
		deleteScene: options?.deleteScene ?? (async () => undefined),
		cancelTarget: options?.cancelTarget ?? (() => undefined),
		getRecord: async () => options?.record ?? null,
		hasTargetJob: () => options?.generating ?? false,
	});
		const latestTarget = options?.latestTarget === undefined ? { messageId: "msg_1", variantId: "var_1" } : options.latestTarget;
		const stores = makeInsightsStores({
			chats: {
				getById: async (chatId: string) => makeChatRow({ id: chatId }),
				getActiveBranch: async () => makeChatBranchRow({ id: options?.activeBranchId ?? "branch_1" }),
			},
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [VARIANT_ROW],
				getLatestSelectedVariant: async () => latestTarget,
			},
		});
		// The scene harness never touches the objective service — a strict
		// empty double (throws loudly if a path ever reaches it; the erased
		// `{}` would have exploded as a TypeError deep in the service).
		const unusedObjectiveService = makeObjectiveService({});
		return new InsightsAdapter(stores, {} as SessionRuntime, unusedObjectiveService, tracker);
	}

	it("generate resolves the target, generates, and returns the scoped message patch", async () => {
		let received: SceneTarget | undefined;
		const adapter = sceneAdapter({
			generateForTarget: async (target) => { received = target; return makeSceneTrackerRecord({ sceneState: { mood: "calm" } }); },
		});
		const response = await adapter.generateScene("chat_1", { target: SCENE_TARGET });
		expect(received).toEqual({ chatId: "chat_1", branchId: "branch_1", messageId: "msg_1", variantId: "var_1" });
		expect(response.target).toEqual({ chatId: "chat_1", ...SCENE_TARGET });
		expect(response.message.id).toBe("msg_1");
		expect(response.message.variants).toHaveLength(1);
		// TC-4: the scene patch rides mapMessageDto like every other message
		// path — its DTO carries the count of the wire content (the selected
		// variant's "hello") and every variant carries its own.
		expect(response.message.tokenCount).toBe(countTokensDefault("hello"));
		expect(response.message.variants[0].tokenCount).toBe(countTokensDefault("hello"));
	});

	it("generate forwards the request signal to the service", async () => {
		let receivedSignal: AbortSignal | undefined;
		const adapter = sceneAdapter({
			generateForTarget: async (_target, signal) => { receivedSignal = signal; return makeSceneTrackerRecord(); },
		});
		const controller = new AbortController();
		await adapter.generateScene("chat_1", { target: SCENE_TARGET }, controller.signal);
		expect(receivedSignal).toBe(controller.signal);
	});

	it("generate rejects a wrong-owner target before generating", async () => {
		let generateCalls = 0;
		const stores = makeInsightsStores({
			chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
			messages: {
				getMessageById: async () => makeMessageRow({ id: "msg_1", chatId: "chat_2" }),
				getVariants: async () => [VARIANT_ROW],
			},
		});
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, {} as never, trackerDouble({ generateForTarget: async () => { generateCalls += 1; return makeSceneTrackerRecord(); } }));
		await expect(adapter.generateScene("chat_1", { target: SCENE_TARGET })).rejects.toThrow("does not belong");
		expect(generateCalls).toBe(0);
	});

	it("generate rejects an unknown variant id before generating", async () => {
		let generateCalls = 0;
		const stores = makeInsightsStores({
			chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [makeVariantRow({ id: "other_variant" })],
			},
		});
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, {} as never, trackerDouble({ generateForTarget: async () => { generateCalls += 1; return makeSceneTrackerRecord(); } }));
		await expect(adapter.generateScene("chat_1", { target: SCENE_TARGET })).rejects.toThrow("no longer available");
		expect(generateCalls).toBe(0);
	});

	it("generate rejects a non-latest target — ordinary retro LLM generation is forbidden (step 3)", async () => {
		let generateCalls = 0;
		const adapter = sceneAdapter({
			generateForTarget: async () => { generateCalls += 1; return makeSceneTrackerRecord(); },
			latestTarget: { messageId: "msg_newer", variantId: "var_newer" }, // a newer assistant is now latest
		});
		await expect(adapter.generateScene("chat_1", { target: SCENE_TARGET })).rejects.toThrow("only available for the latest assistant message");
		expect(generateCalls).toBe(0);
	});

	it("manual edit and delete are NOT gated by the latest-target rule (older records remain editable/deletable)", async () => {
		let editCalls = 0;
		let deleteCalls = 0;
		const adapter = sceneAdapter({
			editScene: async () => { editCalls += 1; return makeSceneTrackerRecord(); },
			deleteScene: async () => { deleteCalls += 1; },
			latestTarget: { messageId: "msg_newer", variantId: "var_newer" }, // SCENE_TARGET is an older record
		});
		await adapter.editScene("chat_1", { target: SCENE_TARGET, sceneState: { mood: "calm" } });
		await adapter.deleteScene("chat_1", { target: SCENE_TARGET });
		expect(editCalls).toBe(1);
		expect(deleteCalls).toBe(1);
	});

	it("edit forwards the sceneState to the service and returns the message patch", async () => {
		let received: { target: SceneTarget; sceneState: Record<string, unknown> } | undefined;
		const adapter = sceneAdapter({
			editScene: async (target, sceneState) => { received = { target, sceneState }; return makeSceneTrackerRecord(); },
		});
		const response = await adapter.editScene("chat_1", { target: SCENE_TARGET, sceneState: { mood: "tense" } });
		expect(received?.sceneState).toEqual({ mood: "tense" });
		expect(response.message.id).toBe("msg_1");
	});

	it("delete clears the record and returns the message patch", async () => {
		let deleted: SceneTarget | undefined;
		const adapter = sceneAdapter({
			deleteScene: async (target) => { deleted = target; },
		});
		const response = await adapter.deleteScene("chat_1", { target: SCENE_TARGET });
		expect(deleted?.variantId).toBe("var_1");
		expect(response.message.id).toBe("msg_1");
	});

	it("cancel reaches the coordinator and never awaits (synchronous ack)", async () => {
		let cancelled: SceneTarget | undefined;
		// The cancel spy rides the tracker double itself — the same seam the
		// adapter's cancelScene actually calls (the old probe reached through
		// an erasure cast into the adapter's PRIVATE field to swap it).
		const adapter = sceneAdapter({
			cancelTarget: (target) => { cancelled = target; },
		});
		const result = adapter.cancelScene("chat_1", { target: SCENE_TARGET });
		expect(result).toEqual({ target: { chatId: "chat_1", ...SCENE_TARGET }, cancelled: true });
		expect(cancelled?.variantId).toBe("var_1");
	});

	it("status reflects the coordinator + the variant's current record", async () => {
		const record = makeSceneTrackerRecord({ variantId: "var_1", schemaHash: "h", sourceHash: "s", sceneState: { mood: "calm" }, modelId: "m", generatedAt: "t" });
		const adapter = sceneAdapter({ record, generating: true });
		const response = await adapter.getSceneStatus("chat_1", { target: SCENE_TARGET });
		expect(response.generating).toBe(true);
		expect(response.record).toEqual(record);
	});

	it("preview forwards the DRAFT config + signal to previewForTarget and returns the would-be sceneState (no message patch)", async () => {
		let received: { target: SceneTarget; config: unknown; signal?: AbortSignal } | undefined;
		const draftConfig = { schema: {}, autoMode: "assistant", contextWindow: 6, continuityLastN: 3, injectLastN: 1, injectionDepth: 1, promptFormat: "json", useChatModel: true, generatePrompt: "", injectPrompt: "", providerProfileId: null, model: null, revision: 0, schemaHash: "h" };
		const adapter = sceneAdapter({
			previewForTarget: async (target, config, signal) => { received = { target, config, signal }; return makeSceneTrackerRecord({ sceneState: { mood: "preview" } }); },
		});
		const controller = new AbortController();
		const response = await adapter.previewScene("chat_1", { target: SCENE_TARGET, config: draftConfig as never }, controller.signal);
		expect(received?.target).toEqual({ chatId: "chat_1", branchId: "branch_1", messageId: "msg_1", variantId: "var_1" });
		expect(received?.config).toBe(draftConfig);
		expect(received?.signal).toBe(controller.signal);
		expect(response).toEqual({ target: { chatId: "chat_1", ...SCENE_TARGET }, sceneState: { mood: "preview" } });
		expect((response as { message?: unknown }).message).toBeUndefined(); // preview never returns a message patch
	});

	it("preview rejects a wrong-owner target before calling the service", async () => {
		let previewCalls = 0;
		const stores = makeInsightsStores({
			chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
			messages: {
				getMessageById: async () => makeMessageRow({ id: "msg_1", chatId: "chat_2" }),
				getVariants: async () => [VARIANT_ROW],
			},
		});
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, {} as never, trackerDouble({ previewForTarget: async () => { previewCalls += 1; return makeSceneTrackerRecord(); } }));
		await expect(adapter.previewScene("chat_1", { target: SCENE_TARGET, config: {} as never })).rejects.toThrow("does not belong");
		expect(previewCalls).toBe(0);
	});
});

describe("InsightsAdapter variant-aware completion refresh (SCN-9)", () => {
	it("joins the EXACT variant Scene job (waitForTarget) and returns the message patch", async () => {
		const gate = deferred();
		const entered = deferred();
		let sceneWaitTarget: SceneTarget | undefined;
		let objWaitCalled = false;
		const objectiveService = makeObjectiveService({
			waitForForwardState: async () => { objWaitCalled = true; },
			getState: async () => defaultObjectiveState(),
		});
		const tracker = trackerDouble({
			waitForTarget: async (target: SceneTarget) => { sceneWaitTarget = target; entered.resolve(); await gate.promise; },
		});
		const stores = makeInsightsStores({
			chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [VARIANT_ROW],
			},
		});
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, objectiveService, tracker);

		const refreshing = adapter.refreshInsightsCompletion("chat_1", { target: SCENE_TARGET });
		await entered.promise;
		expect(sceneWaitTarget?.variantId).toBe("var_1"); // exact variant, not chat-level latest
		expect(objWaitCalled).toBe(true); // Objective joined concurrently

		gate.resolve();
		const response = await refreshing;
		expect(response.patch.message?.id).toBe("msg_1"); // scoped message patch
		expect(response.target.variantId).toBe("var_1");
	});

	it("swallows a non-abort Scene wait failure and still returns Objective state", async () => {
		const objectiveService = makeObjectiveService({
			waitForForwardState: async () => undefined,
			getState: async () => ({ ...defaultObjectiveState(), objectiveDescription: "survives" }),
		});
		const tracker = trackerDouble({
			waitForTarget: async () => { throw new Error("scene boom"); }, // non-abort
		});
		const stores = makeInsightsStores({
			chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
			messages: { getMessageById: async () => MESSAGE_ROW, getVariants: async () => [VARIANT_ROW] },
		});
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, objectiveService, tracker);

		const response = await adapter.refreshInsightsCompletion("chat_1", { target: SCENE_TARGET });
		expect(response.patch.objectiveState?.objectiveDescription).toBe("survives");
		expect(response.patch.message?.id).toBe("msg_1"); // still built — the wait failure is swallowed
	});

	it("rejects a variant that no longer belongs to the target message", async () => {
		const tracker = trackerDouble({ waitForTarget: async () => undefined });
		const stores = makeInsightsStores({
			chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [makeVariantRow({ id: "gone" })], // variantId not found
			},
		});
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, {} as never, tracker);
		await expect(adapter.refreshInsightsCompletion("chat_1", { target: SCENE_TARGET })).rejects.toThrow("no longer available");
	});
});

describe("InsightsAdapter Scene backfill routes (SCN-14)", () => {
	/** A tracker double whose backfill methods record their calls. */
	function backfillTracker(capture: { method: string; chatId?: string; arg?: unknown }[]) {
		const status: SceneBackfillStatus = { runId: "sbr_1", chatId: "chat_1", mode: "fill-missing", status: "running", total: 3, processed: 1, current: { messageId: "msg_1", variantId: "var_1" }, errors: [], summary: null, cancelRequested: false };
		return trackerDouble({
			startBackfill: async (chatId, mode) => {
				capture.push({ method: "startBackfill", chatId, arg: mode });
				return { ...status, mode };
			},
			getBackfillStatus: async (chatId, runId) => {
				capture.push({ method: "getBackfillStatus", chatId, arg: runId });
				return { ...status, runId };
			},
			cancelBackfill: async (chatId, runId) => {
				capture.push({ method: "cancelBackfill", chatId, arg: runId });
				return { ...status, runId, cancelRequested: true };
			},
			retryBackfill: async (chatId, runId) => {
				capture.push({ method: "retryBackfill", chatId, arg: runId });
				return { ...status, runId };
			},
		});
	}

	function adapter(capture: { method: string; chatId?: string; arg?: unknown }[]) {
		const stores = makeInsightsStores({
			chats: { getById: async (chatId: string) => makeChatRow({ id: chatId }) },
		});
		return new InsightsAdapter(stores, {} as SessionRuntime, {} as never, backfillTracker(capture));
	}

	it("start delegates to startBackfill with the branded chatId + mode", async () => {
		const capture: { method: string; chatId?: string; arg?: unknown }[] = [];
		const res = await adapter(capture).startSceneBackfill("chat_1", "rebuild");
		expect(capture[0]).toEqual({ method: "startBackfill", chatId: "chat_1", arg: "rebuild" });
		expect(res.mode).toBe("rebuild");
	});

	it("status delegates to getBackfillStatus and returns the service status verbatim", async () => {
		const capture: { method: string; chatId?: string; arg?: unknown }[] = [];
		const res = await adapter(capture).getSceneBackfillStatus("chat_1", "sbr_9");
		expect(capture[0]).toEqual({ method: "getBackfillStatus", chatId: "chat_1", arg: "sbr_9" });
		expect(res.runId).toBe("sbr_9");
		expect(res.current).toEqual({ messageId: "msg_1", variantId: "var_1" });
	});

	it("cancel delegates to cancelBackfill and returns the run status the client keeps polling", async () => {
		const capture: { method: string; chatId?: string; arg?: unknown }[] = [];
		const res = await adapter(capture).cancelSceneBackfill("chat_1", "sbr_9");
		expect(capture[0]).toEqual({ method: "cancelBackfill", chatId: "chat_1", arg: "sbr_9" });
		expect(res).toMatchObject({ runId: "sbr_9", status: "running", total: 3, cancelRequested: true });
	});

	it("retry delegates to retryBackfill with the branded chatId + runId", async () => {
		const capture: { method: string; chatId?: string; arg?: unknown }[] = [];
		const res = await adapter(capture).retrySceneBackfill("chat_1", "sbr_9");
		expect(capture[0]).toEqual({ method: "retryBackfill", chatId: "chat_1", arg: "sbr_9" });
		expect(res.runId).toBe("sbr_9");
	});
});
