import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ObjectiveState } from "@vibe-tavern/domain";
import { InsightsAdapter } from "../src/api/adapters/insights-adapter.js";
import { defaultObjectiveState, type ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { SceneTrackerService, SceneTarget } from "../src/domain/insights/tracker-service.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const COMPLETION_TARGET = { branchId: "branch_1", messageId: "msg_1" };
const SCENE_TARGET = { branchId: "branch_1", messageId: "msg_1", variantId: "var_1" };

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

/** A minimal assistant message + a single selected variant for DTO building. */
const MESSAGE_ROW = { id: "msg_1", chatId: "chat_1", branchId: "branch_1", role: "assistant", authorType: "assistant", position: 0, content: "hello", state: null, createdAt: "t", updatedAt: "t" };
const VARIANT_ROW = { id: "var_1", messageId: "msg_1", content: "hello", variantIndex: 0, isSelected: true, modelId: "m", sceneTracker: null, coauthorModuleId: null, coauthorSkillId: null };

type TrackerMock = Partial<SceneTrackerService>;

function noopTracker(overrides: TrackerMock = {}): TrackerMock {
	return {
		waitForForwardState: async () => undefined,
		waitForTarget: async () => undefined,
		generateForTarget: async () => ({}) as never,
		editScene: async () => ({}) as never,
		deleteScene: async () => undefined,
		cancelTarget: () => undefined,
		getRecord: async () => null,
		hasTargetJob: () => false,
		...overrides,
	} as TrackerMock;
}

function completionAdapter(options?: {
	state?: ObjectiveState;
	messageAtRead?: (read: number) => object | null;
	waitForForwardState?: (chatId: string, signal?: AbortSignal) => Promise<void>;
	tracker?: TrackerMock;
}) {
	let messageReads = 0;
	const stores = {
		chats: { getById: async (chatId: string) => ({ id: chatId }) },
		messages: {
			getMessageById: async () => {
				messageReads += 1;
				if (options?.messageAtRead) return options.messageAtRead(messageReads);
				return {
					id: COMPLETION_TARGET.messageId,
					chatId: "chat_1",
					branchId: COMPLETION_TARGET.branchId,
					role: "assistant",
				};
			},
		},
	} as unknown as StoreContainer;
	const objectiveService = {
		waitForForwardState: options?.waitForForwardState ?? (async () => undefined),
		getState: async () => options?.state ?? defaultObjectiveState(),
	} as unknown as ObjectiveService;
	return new InsightsAdapter(stores, {} as SessionRuntime, objectiveService, (options?.tracker ?? noopTracker()) as SceneTrackerService);
}

describe("InsightsAdapter Objective context", () => {
	it("uses the stored contextWindow for manual generation", async () => {
		const state: ObjectiveState = { ...defaultObjectiveState(), contextWindow: 4 };
		let recentMessageLimit: number | undefined;
		let receivedContext: unknown;
		const context = { identity: { chatId: "chat_1" } };

		const stores = {
			chats: { getById: async () => ({ id: "chat_1" }) },
		} as unknown as StoreContainer;
		const sessionRuntime = {
			chatLifecycle: {
				buildPipelineContext: async (input: { recentMessageLimit?: number }) => {
					recentMessageLimit = input.recentMessageLimit;
					return { context };
				},
			},
			buildConfigPatchResponse: async () => ({ activeChat: {} }),
		} as unknown as SessionRuntime;
		const objectiveService = {
			getState: async () => state,
			resolveInsightProvider: async () => ({ profile: {}, model: "test-model" }),
			generateTasks: async (input: { context: unknown }) => {
				receivedContext = input.context;
				return state;
			},
		} as unknown as ObjectiveService;

		const adapter = new InsightsAdapter(stores, sessionRuntime, objectiveService, noopTracker() as SceneTrackerService);
		await adapter.generateObjectiveTasks("chat_1", {});

		expect(recentMessageLimit).toBe(4);
		expect(receivedContext).toBe(context);
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
		const stores = {
			chats: { getById: async () => ({ id: "chat_1" }) },
			messages: { getMessageById: async () => ({ ...COMPLETION_TARGET, chatId: "chat_1", role: "assistant" }) },
		} as unknown as StoreContainer;
		const service = {
			waitForForwardState: async () => gate.promise,
			getState: async () => { stateReads += 1; return state; },
		} as unknown as ObjectiveService;
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, service, noopTracker() as SceneTrackerService);

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
			messageAtRead: () => ({ ...COMPLETION_TARGET, chatId: "chat_2", role: "assistant" }),
			waitForForwardState: async () => { waitCalls += 1; },
		});

		await expect(adapter.refreshInsightsCompletion("chat_1", { target: COMPLETION_TARGET })).rejects.toThrow("does not belong");
		expect(waitCalls).toBe(0);
	});

	it("rejects a target that becomes stale while waiting", async () => {
		const gate = deferred();
		const adapter = completionAdapter({
			messageAtRead: (read) => read === 1
				? { ...COMPLETION_TARGET, chatId: "chat_1", role: "assistant" }
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
		generateForTarget?: (target: SceneTarget, signal?: AbortSignal) => Promise<unknown>;
		editScene?: (target: SceneTarget, sceneState: Record<string, unknown>) => Promise<unknown>;
		deleteScene?: (target: SceneTarget) => Promise<void>;
		record?: object | null;
		generating?: boolean;
	}) {
		const tracker = noopTracker({
			generateForTarget: options?.generateForTarget ?? (async () => ({})),
			editScene: options?.editScene ?? (async () => ({})),
			deleteScene: options?.deleteScene ?? (async () => undefined),
			getRecord: async () => options?.record ?? null,
			hasTargetJob: () => options?.generating ?? false,
		});
		const stores = {
			chats: { getById: async (chatId: string) => ({ id: chatId }) },
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [VARIANT_ROW],
			},
		} as unknown as StoreContainer;
		return new InsightsAdapter(stores, {} as SessionRuntime, {} as never, tracker as SceneTrackerService);
	}

	it("generate resolves the target, generates, and returns the scoped message patch", async () => {
		let received: SceneTarget | undefined;
		const adapter = sceneAdapter({
			generateForTarget: async (target) => { received = target; return { sceneState: { mood: "calm" } }; },
		});
		const response = await adapter.generateScene("chat_1", { target: SCENE_TARGET });
		expect(received).toEqual({ chatId: "chat_1", branchId: "branch_1", messageId: "msg_1", variantId: "var_1" });
		expect(response.target).toEqual({ chatId: "chat_1", ...SCENE_TARGET });
		expect(response.message.id).toBe("msg_1");
		expect(response.message.variants).toHaveLength(1);
	});

	it("generate forwards the request signal to the service", async () => {
		let receivedSignal: AbortSignal | undefined;
		const adapter = sceneAdapter({
			generateForTarget: async (_target, signal) => { receivedSignal = signal; return {}; },
		});
		const controller = new AbortController();
		await adapter.generateScene("chat_1", { target: SCENE_TARGET }, controller.signal);
		expect(receivedSignal).toBe(controller.signal);
	});

	it("generate rejects a wrong-owner target before generating", async () => {
		let generateCalls = 0;
		const stores = {
			chats: { getById: async (chatId: string) => ({ id: chatId }) },
			messages: {
				getMessageById: async () => ({ ...MESSAGE_ROW, chatId: "chat_2" }),
				getVariants: async () => [VARIANT_ROW],
			},
		} as unknown as StoreContainer;
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, {} as never, noopTracker({ generateForTarget: async () => { generateCalls += 1; return {}; } }) as SceneTrackerService);
		await expect(adapter.generateScene("chat_1", { target: SCENE_TARGET })).rejects.toThrow("does not belong");
		expect(generateCalls).toBe(0);
	});

	it("generate rejects an unknown variant id before generating", async () => {
		let generateCalls = 0;
		const stores = {
			chats: { getById: async (chatId: string) => ({ id: chatId }) },
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [{ ...VARIANT_ROW, id: "other_variant" }],
			},
		} as unknown as StoreContainer;
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, {} as never, noopTracker({ generateForTarget: async () => { generateCalls += 1; return {}; } }) as SceneTrackerService);
		await expect(adapter.generateScene("chat_1", { target: SCENE_TARGET })).rejects.toThrow("no longer available");
		expect(generateCalls).toBe(0);
	});

	it("edit forwards the sceneState to the service and returns the message patch", async () => {
		let received: { target: SceneTarget; sceneState: Record<string, unknown> } | undefined;
		const adapter = sceneAdapter({
			editScene: async (target, sceneState) => { received = { target, sceneState }; return {}; },
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
		const adapter = sceneAdapter();
		// Replace the noop cancelTarget with a spy after construction.
		(adapter as unknown as { trackerService: SceneTrackerService }).trackerService.cancelTarget = (target: SceneTarget) => { cancelled = target; };
		const result = adapter.cancelScene("chat_1", { target: SCENE_TARGET });
		expect(result).toEqual({ target: { chatId: "chat_1", ...SCENE_TARGET }, cancelled: true });
		expect(cancelled?.variantId).toBe("var_1");
	});

	it("status reflects the coordinator + the variant's current record", async () => {
		const record = { variantId: "var_1", schemaHash: "h", configRevision: 0, sourceHash: "s", sceneState: { mood: "calm" }, modelId: "m", generatedAt: "t" };
		const adapter = sceneAdapter({ record, generating: true });
		const response = await adapter.getSceneStatus("chat_1", { target: SCENE_TARGET });
		expect(response.generating).toBe(true);
		expect(response.record).toEqual(record);
	});
});

describe("InsightsAdapter variant-aware completion refresh (SCN-9)", () => {
	it("joins the EXACT variant Scene job (waitForTarget) and returns the message patch", async () => {
		const gate = deferred();
		const entered = deferred();
		let sceneWaitTarget: SceneTarget | undefined;
		let objWaitCalled = false;
		const objectiveService = {
			waitForForwardState: async () => { objWaitCalled = true; },
			getState: async () => defaultObjectiveState(),
		} as unknown as ObjectiveService;
		const tracker = noopTracker({
			waitForTarget: async (target: SceneTarget) => { sceneWaitTarget = target; entered.resolve(); await gate.promise; },
		}) as SceneTrackerService;
		const stores = {
			chats: { getById: async (chatId: string) => ({ id: chatId }) },
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [VARIANT_ROW],
			},
		} as unknown as StoreContainer;
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
		const objectiveService = {
			waitForForwardState: async () => undefined,
			getState: async () => ({ ...defaultObjectiveState(), objectiveDescription: "survives" }),
		} as unknown as ObjectiveService;
		const tracker = noopTracker({
			waitForTarget: async () => { throw new Error("scene boom"); }, // non-abort
		}) as SceneTrackerService;
		const stores = {
			chats: { getById: async (chatId: string) => ({ id: chatId }) },
			messages: { getMessageById: async () => MESSAGE_ROW, getVariants: async () => [VARIANT_ROW] },
		} as unknown as StoreContainer;
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, objectiveService, tracker);

		const response = await adapter.refreshInsightsCompletion("chat_1", { target: SCENE_TARGET });
		expect(response.patch.objectiveState?.objectiveDescription).toBe("survives");
		expect(response.patch.message?.id).toBe("msg_1"); // still built — the wait failure is swallowed
	});

	it("rejects a variant that no longer belongs to the target message", async () => {
		const tracker = noopTracker({ waitForTarget: async () => undefined }) as SceneTrackerService;
		const stores = {
			chats: { getById: async (chatId: string) => ({ id: chatId }) },
			messages: {
				getMessageById: async () => MESSAGE_ROW,
				getVariants: async () => [{ ...VARIANT_ROW, id: "gone" }], // variantId not found
			},
		} as unknown as StoreContainer;
		const adapter = new InsightsAdapter(stores, {} as SessionRuntime, {} as never, tracker);
		await expect(adapter.refreshInsightsCompletion("chat_1", { target: SCENE_TARGET })).rejects.toThrow("no longer available");
	});
});
