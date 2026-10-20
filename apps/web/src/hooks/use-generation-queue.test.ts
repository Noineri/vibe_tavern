import { beforeEach, describe, expect, test } from "bun:test";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { useChatStore } from "../stores/chat-store.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { cancelQueueJob, enqueueGenerateMore, useGenerationQueue } from "./use-generation-queue.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { act, renderHook } = await import("@testing-library/react");

const CHAT = brandId<ChatId>("queue-chat");
const MESSAGE = "assistant-message";

function resetStores(): void {
  useChatStore.setState({ activeChatId: CHAT, generations: {} });
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
}

describe("useGenerationQueue record lifecycle", () => {
  beforeEach(resetStores);

  test("cancelling a pending queue job removes its pending record", () => {
    enqueueGenerateMore(MESSAGE, "model-a", "preset-a");
    const job = useGenerationQueueStore.getState().jobsByChat[CHAT]![0]!;

    cancelQueueJob(job.id);

    expect(useGenerationQueueStore.getState().jobsByChat[CHAT]).toEqual([]);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT]).toEqual([]);
  });

  test("the registered pump runs queued work sequentially and removes its completed record", async () => {
    const calls: string[] = [];
    const { unmount } = renderHook(() => useGenerationQueue(async (_chatId, messageId, override) => {
      calls.push(`${messageId}:${override?.model}`);
      return "done";
    }));

    await act(async () => {
      enqueueGenerateMore(MESSAGE, "model-a", "preset-a");
      enqueueGenerateMore(MESSAGE, "model-b", null);
      for (let i = 0; i < 10 && calls.length < 2; i += 1) await Promise.resolve();
    });

    expect(calls).toEqual(["assistant-message:model-a", "assistant-message:model-b"]);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT]).toEqual([]);
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT]?.map((job) => job.status)).toEqual(["done", "done"]);
    unmount();
  });

  test("a failed registered job preserves the controller's provider text and advances", async () => {
    const calls: string[] = [];
    const { unmount } = renderHook(() => useGenerationQueue(async (_chatId, _messageId, override) => {
      calls.push(override?.model ?? "none");
      const running = useGenerationQueueStore.getState().recordsByChat[CHAT]?.find((record) => record.status === "running");
      if (running) useGenerationQueueStore.getState().updateRecord(CHAT, running.id, { status: "failed", error: "provider rate limit" });
      return calls.length === 1 ? "failed" : "done";
    }));

    await act(async () => {
      enqueueGenerateMore(MESSAGE, "bad-model", null);
      enqueueGenerateMore(MESSAGE, "next-model", null);
      for (let i = 0; i < 12 && calls.length < 2; i += 1) await Promise.resolve();
    });

    expect(calls).toEqual(["bad-model", "next-model"]);
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT]?.[0]).toMatchObject({ status: "failed", error: "provider rate limit" });
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT]?.[0]).toMatchObject({ status: "failed", error: "provider rate limit" });
    unmount();
  });
});
