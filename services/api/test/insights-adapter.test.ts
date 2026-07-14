import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ObjectiveState } from "@vibe-tavern/domain";
import { InsightsAdapter } from "../src/api/adapters/insights-adapter.js";
import { defaultObjectiveState, type ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const COMPLETION_TARGET = { branchId: "branch_1", messageId: "msg_1" };

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

function completionAdapter(options?: {
  state?: ObjectiveState;
  messageAtRead?: (read: number) => object | null;
  waitForForwardState?: (chatId: string, signal?: AbortSignal) => Promise<void>;
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
  return new InsightsAdapter(stores, {} as SessionRuntime, objectiveService);
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

    const adapter = new InsightsAdapter(stores, sessionRuntime, objectiveService);
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
    const adapter = new InsightsAdapter(stores, {} as SessionRuntime, service);

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
