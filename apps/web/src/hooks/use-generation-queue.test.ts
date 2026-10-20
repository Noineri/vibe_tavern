import { beforeEach, describe, expect, test } from "bun:test";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { useChatStore } from "../stores/chat-store.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { cancelQueueJob, enqueueGenerateMore } from "./use-generation-queue.js";

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
});
