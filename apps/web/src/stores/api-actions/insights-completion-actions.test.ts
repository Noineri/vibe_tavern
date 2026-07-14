import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatId } from "@vibe-tavern/domain";
import type {
  AppMessage,
  AppSnapshot,
  InsightsCompletionPatchResponse,
  InsightsCompletionTarget,
  ObjectiveState,
} from "../../app-client.js";
import { useSnapshotStore } from "../snapshot-store.js";
import {
  cancelInsightsCompletionRefresh,
  findInsightsCompletionTarget,
  refreshInsightsCompletionAction,
  startInsightsCompletionRefreshFromSnapshot,
} from "./insights-completion-actions.js";

const mocks = vi.hoisted(() => ({
  refreshInsightsCompletion: vi.fn(),
  logClientSendDebug: vi.fn(),
}));

vi.mock("../../app-client.js", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("../../app-client.js");
  return {
    ...actual,
    refreshInsightsCompletion: mocks.refreshInsightsCompletion,
    logClientSendDebug: mocks.logClientSendDebug,
  };
});

const chatId = "chat_1" as ChatId;
const TARGET_A: InsightsCompletionTarget = { branchId: "branch_1", messageId: "msg_1" };
const TARGET_B: InsightsCompletionTarget = { branchId: "branch_1", messageId: "msg_2" };

function objective(description: string): ObjectiveState {
  return {
    objectiveDescription: description,
    tasks: [{ id: `task_${description}`, description, status: "active" }],
    autoCheckFrequency: 1,
    contextWindow: 10,
    injectionDepth: 1,
    generatePrompt: "",
    checkPrompt: "",
    injectPrompt: "",
    useChatModel: true,
    providerProfileId: null,
    model: null,
  };
}

function message(target: InsightsCompletionTarget, role: "assistant" | "user" = "assistant"): AppMessage {
  return {
    id: target.messageId,
    chatId,
    branchId: target.branchId,
    role,
    position: target.messageId === "msg_1" ? 1 : 2,
    content: target.messageId,
    state: "complete",
    authorType: role === "assistant" ? "character" : "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [],
    selectedVariantIndex: null,
    modelId: null,
  } as unknown as AppMessage;
}

function seed(targets: InsightsCompletionTarget[] = [TARGET_A]): void {
  useSnapshotStore.getState().ingestSnapshot({
    activeChat: {
      id: chatId,
      insightsConfig: { objectiveEnabled: true, trackerEnabled: false },
    } as NonNullable<AppSnapshot["activeChat"]>,
    messages: targets.map((target) => message(target)),
  });
}

function response(target: InsightsCompletionTarget, state: ObjectiveState): InsightsCompletionPatchResponse {
  return {
    target: { chatId, ...target },
    patch: { objectiveState: state },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.refreshInsightsCompletion.mockReset();
  mocks.logClientSendDebug.mockReset();
  useSnapshotStore.getState().clear();
});

afterEach(() => {
  cancelInsightsCompletionRefresh(chatId);
});

describe("refreshInsightsCompletionAction", () => {
  test("applies a matching scoped patch only after the refresh resolves", async () => {
    seed();
    const gate = deferred<InsightsCompletionPatchResponse>();
    mocks.refreshInsightsCompletion.mockReturnValueOnce(gate.promise);

    const refreshing = refreshInsightsCompletionAction(chatId, TARGET_A);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState).toBeUndefined();

    const committed = objective("Committed route");
    gate.resolve(response(TARGET_A, committed));

    await expect(refreshing).resolves.toBe(true);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState).toEqual(committed);
    expect(mocks.refreshInsightsCompletion).toHaveBeenCalledWith(chatId, TARGET_A, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  test("merges an optional target-message patch without replacing the branch message list", async () => {
    seed([TARGET_A, TARGET_B]);
    const patchedMessage = { ...message(TARGET_A), content: "Refreshed target metadata" };
    mocks.refreshInsightsCompletion.mockResolvedValueOnce({
      target: { chatId, ...TARGET_A },
      patch: { message: patchedMessage },
    });

    await expect(refreshInsightsCompletionAction(chatId, TARGET_A)).resolves.toBe(true);
    expect(useSnapshotStore.getState().messagesById.msg_1?.content).toBe("Refreshed target metadata");
    expect(useSnapshotStore.getState().messagesById.msg_2?.content).toBe("msg_2");
    expect(useSnapshotStore.getState().messageOrder).toEqual(["msg_1", "msg_2"]);
  });

  test("rejects an echoed target that does not match the request", async () => {
    seed([TARGET_A, TARGET_B]);
    mocks.refreshInsightsCompletion.mockResolvedValueOnce(response(TARGET_B, objective("Wrong target")));

    await expect(refreshInsightsCompletionAction(chatId, TARGET_A)).resolves.toBe(false);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState).toBeUndefined();
  });

  test("ignores a response after the active chat or target message becomes stale", async () => {
    seed();
    const gate = deferred<InsightsCompletionPatchResponse>();
    mocks.refreshInsightsCompletion.mockReturnValueOnce(gate.promise);
    const refreshing = refreshInsightsCompletionAction(chatId, TARGET_A);

    useSnapshotStore.setState({ activeChat: { id: "chat_2" } as NonNullable<AppSnapshot["activeChat"]> });
    useSnapshotStore.getState().clearMessages();
    gate.resolve(response(TARGET_A, objective("Stale route")));

    await expect(refreshing).resolves.toBe(false);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState).toBeUndefined();
  });

  test("a newer target detaches the older waiter and is the only patch allowed to apply", async () => {
    seed([TARGET_A, TARGET_B]);
    const oldGate = deferred<InsightsCompletionPatchResponse>();
    let oldSignal: AbortSignal | undefined;
    mocks.refreshInsightsCompletion
      .mockImplementationOnce((_chatId, _target, options) => {
        oldSignal = options?.signal;
        return oldGate.promise;
      })
      .mockResolvedValueOnce(response(TARGET_B, objective("Newest route")));

    const oldRefresh = refreshInsightsCompletionAction(chatId, TARGET_A);
    const newRefresh = refreshInsightsCompletionAction(chatId, TARGET_B);

    expect(oldSignal?.aborted).toBe(true);
    await expect(newRefresh).resolves.toBe(true);
    oldGate.resolve(response(TARGET_A, objective("Old route")));
    await expect(oldRefresh).resolves.toBe(false);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState?.objectiveDescription).toBe("Newest route");
  });
});

describe("committed assistant target discovery", () => {
  test("selects the latest assistant message from a committed response snapshot", () => {
    const snapshot: AppSnapshot = {
      messages: [message(TARGET_A), message({ branchId: "branch_1", messageId: "user_2" }, "user"), message(TARGET_B)],
    };

    expect(findInsightsCompletionTarget(chatId, snapshot)).toEqual(TARGET_B);
  });

  test("starts the asynchronous refresh for the latest committed assistant when an insight is enabled", async () => {
    seed();
    mocks.refreshInsightsCompletion.mockResolvedValueOnce(response(TARGET_A, objective("Fresh route")));

    startInsightsCompletionRefreshFromSnapshot(chatId, { messages: [message(TARGET_A)] });

    await vi.waitFor(() => expect(mocks.refreshInsightsCompletion).toHaveBeenCalledWith(
      chatId,
      TARGET_A,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
  });

  test("after stream abort, refreshes only when the committed snapshot contains a new assistant target", async () => {
    seed([TARGET_A, TARGET_B]);

    startInsightsCompletionRefreshFromSnapshot(chatId, { messages: [message(TARGET_A)] }, TARGET_A);
    expect(mocks.refreshInsightsCompletion).not.toHaveBeenCalled();

    mocks.refreshInsightsCompletion.mockResolvedValueOnce(response(TARGET_B, objective("Partial reply route")));
    startInsightsCompletionRefreshFromSnapshot(
      chatId,
      { messages: [message(TARGET_A), message(TARGET_B)] },
      TARGET_A,
    );

    await vi.waitFor(() => expect(mocks.refreshInsightsCompletion).toHaveBeenCalledWith(
      chatId,
      TARGET_B,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
  });

  test("starts no refresh when the response has no matching assistant or both insights are disabled", () => {
    startInsightsCompletionRefreshFromSnapshot(chatId, { messages: [message(TARGET_A, "user")] });
    expect(mocks.refreshInsightsCompletion).not.toHaveBeenCalled();

    seed();
    useSnapshotStore.setState({
      activeChat: {
        ...useSnapshotStore.getState().activeChat,
        insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
      } as NonNullable<AppSnapshot["activeChat"]>,
    });
    startInsightsCompletionRefreshFromSnapshot(chatId, { messages: [message(TARGET_A)] });
    expect(mocks.refreshInsightsCompletion).not.toHaveBeenCalled();
  });
});
