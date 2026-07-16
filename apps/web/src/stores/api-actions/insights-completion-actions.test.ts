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
import { useSceneGenerationStore } from "../scene-generation-store.js";
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
const VARIANT_A = "var_1";
const VARIANT_B = "var_2";
const TARGET_A_VARIANT_A: InsightsCompletionTarget = { ...TARGET_A, variantId: VARIANT_A };

function objective(description: string): ObjectiveState {
  return {
    objectiveDescription: description,
    tasks: [{ id: `task_${description}`, description, status: "active" }],
    autoCheckFrequency: 1,
    autoCheckEventCount: 0,
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

function variantMessage(target: InsightsCompletionTarget, variantId: string, content = "scene content"): AppMessage {
  const base = message(target);
  return {
    ...base,
    content,
    variants: [{ id: variantId, messageId: target.messageId, variantIndex: 0, content, isSelected: true } as unknown as AppMessage["variants"][number]],
    selectedVariantIndex: 0,
  } as unknown as AppMessage;
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
  useSceneGenerationStore.getState().clearAll();
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

describe("variant-aware completion refresh (SCN-10)", () => {
  test("target discovery includes the selected variant id when the latest assistant carries one", () => {
    const snapshot: AppSnapshot = { messages: [variantMessage(TARGET_A, VARIANT_A)] };
    expect(findInsightsCompletionTarget(chatId, snapshot)).toEqual(TARGET_A_VARIANT_A);
  });

  test("target discovery omits variantId when the latest assistant has no selected variant", () => {
    const snapshot: AppSnapshot = { messages: [message(TARGET_A)] };
    expect(findInsightsCompletionTarget(chatId, snapshot)).toEqual(TARGET_A);
  });

  test("applies objectiveState + scoped message patch together when the variant matches", async () => {
    useSnapshotStore.getState().ingestSnapshot({
      activeChat: { id: chatId, insightsConfig: { objectiveEnabled: true, trackerEnabled: true } } as NonNullable<AppSnapshot["activeChat"]>,
      messages: [variantMessage(TARGET_A_VARIANT_A, VARIANT_A)],
    });
    const fresh = { ...variantMessage(TARGET_A_VARIANT_A, VARIANT_A, "updated content") };
    mocks.refreshInsightsCompletion.mockResolvedValueOnce({
      target: { chatId, ...TARGET_A_VARIANT_A },
      patch: { objectiveState: objective("Dual patch"), message: fresh },
    });

    await expect(refreshInsightsCompletionAction(chatId, TARGET_A_VARIANT_A)).resolves.toBe(true);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState?.objectiveDescription).toBe("Dual patch");
    expect(useSnapshotStore.getState().messagesById.msg_1?.content).toBe("updated content");
  });

  test("rejects the patch when the target variant was removed mid-flight (stale variant)", async () => {
    useSnapshotStore.getState().ingestSnapshot({
      activeChat: { id: chatId, insightsConfig: { objectiveEnabled: true, trackerEnabled: true } } as NonNullable<AppSnapshot["activeChat"]>,
      messages: [variantMessage(TARGET_A_VARIANT_A, VARIANT_A)],
    });
    // The patch carries a message whose only variant is VARIANT_B (VARIANT_A was deleted).
    const stale = variantMessage(TARGET_A_VARIANT_A, VARIANT_B);
    mocks.refreshInsightsCompletion.mockResolvedValueOnce({
      target: { chatId, ...TARGET_A_VARIANT_A },
      patch: { objectiveState: objective("Must not apply"), message: stale },
    });

    await expect(refreshInsightsCompletionAction(chatId, TARGET_A_VARIANT_A)).resolves.toBe(false);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState).toBeUndefined();
    expect(useSnapshotStore.getState().messagesById.msg_1?.content).toBe("scene content");
  });

  test("a swipe to a different variant of the same message detaches the older waiter", async () => {
    // msg_1 with two variants; selectedVariantIndex points at VARIANT_A initially.
    const dual: AppMessage = {
      ...variantMessage(TARGET_A, VARIANT_A),
      variants: [
        { id: VARIANT_A, messageId: "msg_1", variantIndex: 0, content: "a", isSelected: false } as unknown as AppMessage["variants"][number],
        { id: VARIANT_B, messageId: "msg_1", variantIndex: 1, content: "b", isSelected: true } as unknown as AppMessage["variants"][number],
      ],
      selectedVariantIndex: 1,
    } as unknown as AppMessage;
    useSnapshotStore.getState().ingestSnapshot({
      activeChat: { id: chatId, insightsConfig: { objectiveEnabled: true, trackerEnabled: true } } as NonNullable<AppSnapshot["activeChat"]>,
      messages: [dual],
    });

    const oldGate = deferred<InsightsCompletionPatchResponse>();
    let oldSignal: AbortSignal | undefined;
    mocks.refreshInsightsCompletion
      .mockImplementationOnce((_chatId, _target, options) => {
        oldSignal = options?.signal;
        return oldGate.promise;
      })
      .mockResolvedValueOnce({
        target: { chatId, ...TARGET_A, variantId: VARIANT_B },
        patch: { objectiveState: objective("Swiped variant") },
      });

    const oldRefresh = refreshInsightsCompletionAction(chatId, TARGET_A_VARIANT_A);
    const newRefresh = refreshInsightsCompletionAction(chatId, { ...TARGET_A, variantId: VARIANT_B });

    expect(oldSignal?.aborted).toBe(true);
    await expect(newRefresh).resolves.toBe(true);
    oldGate.resolve({ target: { chatId, ...TARGET_A_VARIANT_A }, patch: { objectiveState: objective("Old variant") } });
    await expect(oldRefresh).resolves.toBe(false);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState?.objectiveDescription).toBe("Swiped variant");
  });

  test("clears the Scene generation flag for the target variant when the job settles (step 6)", async () => {
    useSnapshotStore.getState().ingestSnapshot({
      activeChat: { id: chatId, insightsConfig: { objectiveEnabled: true, trackerEnabled: true } } as NonNullable<AppSnapshot["activeChat"]>,
      messages: [variantMessage(TARGET_A_VARIANT_A, VARIANT_A)],
    });
    useSceneGenerationStore.getState().markGenerating(VARIANT_A);
    expect(useSceneGenerationStore.getState().generating.has(VARIANT_A)).toBe(true);

    mocks.refreshInsightsCompletion.mockResolvedValueOnce({
      target: { chatId, ...TARGET_A_VARIANT_A },
      patch: { objectiveState: objective("Settled") },
    });

    await expect(refreshInsightsCompletionAction(chatId, TARGET_A_VARIANT_A)).resolves.toBe(true);
    // The server-owned job settled → the spinner flag must clear without a manual Cancel.
    expect(useSceneGenerationStore.getState().generating.has(VARIANT_A)).toBe(false);
  });

  test("preserves Objective-only behavior when the target carries no variantId", async () => {
    seed([TARGET_A]);
    mocks.refreshInsightsCompletion.mockResolvedValueOnce(response(TARGET_A, objective("Objective only")));

    await expect(refreshInsightsCompletionAction(chatId, TARGET_A)).resolves.toBe(true);
    expect(useSnapshotStore.getState().activeChat?.insightsObjectiveState?.objectiveDescription).toBe("Objective only");
  });
});
