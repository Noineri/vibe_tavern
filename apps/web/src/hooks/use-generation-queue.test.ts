import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import type { AppMessage } from "../api/types.js";
import { useChatStore } from "../stores/chat-store.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { cancelQueueJob, clearQueuePending, enqueueGenerateMore, useGenerationQueue } from "./use-generation-queue.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { act, renderHook } = await import("@testing-library/react");

const CHAT_A = brandId<ChatId>("queue-chat-a");
const CHAT_B = brandId<ChatId>("queue-chat-b");
const MESSAGE = "assistant-message";
const originalChatState = useChatStore.getState();
const originalSnapshotState = useSnapshotStore.getState();

afterAll(() => {
  useChatStore.setState(originalChatState, true);
  useSnapshotStore.setState(originalSnapshotState, true);
});

function resetStores(): void {
  useChatStore.setState({ activeChatId: CHAT_A, generations: {} });
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
  useSnapshotStore.setState({ messagesById: {}, messageOrder: [] });
}

function parked<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function setServerVariantIds(variantIds: string[]): void {
  useSnapshotStore.setState({
    messagesById: { [MESSAGE]: { id: MESSAGE, variants: variantIds.map((id) => ({ id })) } } as unknown as Record<string, AppMessage>,
    messageOrder: [MESSAGE],
  });
}

function serverVariantIds(): string[] {
  return useSnapshotStore.getState().messagesById[MESSAGE]?.variants.map((variant) => variant.id) ?? [];
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect(predicate()).toBe(true);
}

describe("useGenerationQueue record lifecycle", () => {
  beforeEach(resetStores);

  test("runs queued jobs one at a time and forwards each complete frozen override", async () => {
    const first = parked<"done">();
    const calls: Array<{ chatId: ChatId; messageId: string; override: unknown }> = [];
    const { unmount } = renderHook(() => useGenerationQueue(async (chatId, messageId, override) => {
      calls.push({ chatId, messageId, override });
      return calls.length === 1 ? first.promise : "done";
    }));

    await act(async () => {
      enqueueGenerateMore(MESSAGE, "model-a", "preset-a");
      enqueueGenerateMore(MESSAGE, "model-b", null);
      await flushUntil(() => calls.length === 1);
    });
    expect(calls).toEqual([{ chatId: CHAT_A, messageId: MESSAGE, override: { model: "model-a", promptPresetId: "preset-a" } }]);
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]?.map((job) => job.status)).toEqual(["running", "pending"]);

    await act(async () => {
      first.resolve("done");
      await flushUntil(() => calls.length === 2);
    });
    expect(calls).toEqual([
      { chatId: CHAT_A, messageId: MESSAGE, override: { model: "model-a", promptPresetId: "preset-a" } },
      { chatId: CHAT_A, messageId: MESSAGE, override: { model: "model-b" } },
    ]);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]).toEqual([]);
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]?.map((job) => job.status)).toEqual(["done", "done"]);
    unmount();
  });

  test("pauses a backgrounded chat until it becomes active again", async () => {
    const calls: string[] = [];
    const { unmount } = renderHook(() => useGenerationQueue(async (_chatId, messageId) => {
      calls.push(messageId);
      return "done";
    }));

    useChatStore.getState().startGeneration(CHAT_A);
    enqueueGenerateMore(MESSAGE, "model-a", null);
    useChatStore.getState().setActiveChatId(CHAT_B);
    useChatStore.getState().finishGeneration(CHAT_A);
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]?.[0]?.status).toBe("pending");

    await act(async () => {
      useChatStore.getState().setActiveChatId(CHAT_A);
      await flushUntil(() => calls.length === 1);
    });
    expect(calls).toEqual([MESSAGE]);
    unmount();
  });

  test("clearing pending work keeps the parked running job and its server completion", async () => {
    const first = parked<"done">();
    const calls: string[] = [];
    const { unmount } = renderHook(() => useGenerationQueue(async (_chatId, _messageId, override) => {
      calls.push(override?.model ?? "");
      return first.promise;
    }));

    await act(async () => {
      enqueueGenerateMore(MESSAGE, "first", null);
      enqueueGenerateMore(MESSAGE, "second", null);
      await flushUntil(() => calls.length === 1);
    });
    const running = useGenerationQueueStore.getState().jobsByChat[CHAT_A]![0]!;
    clearQueuePending();
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]).toEqual([expect.objectContaining({ id: running.id, status: "running" })]);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]).toEqual([expect.objectContaining({ id: running.recordId, status: "running" })]);

    await act(async () => {
      setServerVariantIds(["completed-by-server"]);
      first.resolve("done");
      await flushUntil(() => useGenerationQueueStore.getState().jobsByChat[CHAT_A]?.[0]?.status === "done");
    });
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]).toEqual([]);
    expect(calls).toEqual(["first"]);
    expect(serverVariantIds()).toEqual(["completed-by-server"]);
    unmount();
  });

  test("cancelling a pending queue job removes only its linked pending record", () => {
    enqueueGenerateMore(MESSAGE, "model-a", "preset-a");
    enqueueGenerateMore(MESSAGE, "model-b", null);
    const [job, survivor] = useGenerationQueueStore.getState().jobsByChat[CHAT_A]!;
    cancelQueueJob(job.id);
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]).toEqual([expect.objectContaining({ id: survivor.id })]);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]).toEqual([expect.objectContaining({ id: survivor.recordId, status: "pending" })]);
  });

  for (const partialVariant of [true, false]) {
    test(`cancelling a running job ${partialVariant ? "keeps" : "does not invent"} a partial server variant`, async () => {
      const outcome = parked<"cancelled">();
      const { unmount } = renderHook(() => useGenerationQueue(async () => outcome.promise));

      await act(async () => {
        enqueueGenerateMore(MESSAGE, "model-a", null);
        await flushUntil(() => useGenerationQueueStore.getState().jobsByChat[CHAT_A]?.[0]?.status === "running");
      });
      const job = useGenerationQueueStore.getState().jobsByChat[CHAT_A]![0]!;
      const recordId = job.recordId!;
      cancelQueueJob(job.id);
      expect(useChatStore.getState().generations[CHAT_A]).toBeUndefined();
      setServerVariantIds(partialVariant ? ["server-partial"] : []);
      expect(serverVariantIds()).toEqual(partialVariant ? ["server-partial"] : []);

      await act(async () => {
        outcome.resolve("cancelled");
        await flushUntil(() => !useGenerationQueueStore.getState().jobsByChat[CHAT_A]);
      });
      expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]?.find((record) => record.id === recordId)).toBeUndefined();
      expect(serverVariantIds()).toEqual(partialVariant ? ["server-partial"] : []);
      unmount();
    });
  }

  test("a failed job retains controller text and advances without fallback error text", async () => {
    const calls: string[] = [];
    const { unmount } = renderHook(() => useGenerationQueue(async (_chatId, _messageId, override) => {
      calls.push(override?.model ?? "none");
      const running = useGenerationQueueStore.getState().recordsByChat[CHAT_A]?.find((record) => record.status === "running");
      if (calls.length === 1 && running) {
        useGenerationQueueStore.getState().updateRecord(CHAT_A, running.id, { status: "failed", error: "provider rate limit" });
        return "failed";
      }
      return "done";
    }));

    await act(async () => {
      enqueueGenerateMore(MESSAGE, "bad-model", null);
      enqueueGenerateMore(MESSAGE, "next-model", null);
      await flushUntil(() => calls.length === 2);
    });
    expect(calls).toEqual(["bad-model", "next-model"]);
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]?.[0]).toMatchObject({ status: "failed", error: "provider rate limit" });
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]?.[0]).toMatchObject({ status: "failed", error: "provider rate limit" });
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]?.[0]?.error).not.toBe("generation_failed");
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]?.[0]?.error).not.toBe("regen_failed");
    unmount();
  });
});
