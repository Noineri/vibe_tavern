import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AppMessage } from "../../api/types.js";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useGenerationQueueStore } from "../../stores/generation-queue-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";

useDomEnv();

const { act, fireEvent, render } = await import("@testing-library/react");
const { QueueManager } = await import("./QueueManager.js");
const { LocaleProvider } = await import("../../i18n/context.js");
const { i18next, initI18n } = await import("../../i18n/i18n.js");

initI18n("en");

const CHAT_A = brandId<ChatId>("chat-a");
const CHAT_B = brandId<ChatId>("chat-b");
const TARGET_A = "target-a";
const TARGET_B = "target-b";

const initialChatState = useChatStore.getState();
const initialQueueState = useGenerationQueueStore.getState();
const initialSnapshotState = useSnapshotStore.getState();

afterAll(async () => {
  useChatStore.setState(initialChatState, true);
  useGenerationQueueStore.setState(initialQueueState, true);
  useSnapshotStore.setState(initialSnapshotState, true);
  await i18next.changeLanguage("en");
});

beforeEach(() => {
  useChatStore.setState({ activeChatId: CHAT_A });
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
  useSnapshotStore.setState({ messageOrder: [], messagesById: {} });
});

function setVisibleTarget(messageId: string, variantIds: string[]): void {
  useSnapshotStore.setState({
    messageOrder: [messageId],
    messagesById: {
      [messageId]: { id: messageId, variants: variantIds.map((id) => ({ id })) } as AppMessage,
    },
  });
}

function renderQueueManager() {
  return render(<LocaleProvider initialLocale="en"><QueueManager /></LocaleProvider>);
}

function expectCounter(getByRole: ReturnType<typeof render>["getByRole"], text: string): void {
  const button = getByRole("button", { name: /Generation queue/ });
  const counter = button.querySelector("span");
  expect(counter?.textContent).toBe(text);
}

describe("QueueManager QS-3 batch summary", () => {
  test("renders nothing when the active chat has no batch", () => {
    const { container } = renderQueueManager();

    expect(container.firstChild).toBeNull();
  });

  test("renders nothing for a plain regenerate record without a batch", () => {
    useGenerationQueueStore.getState().addRecord(CHAT_A, {
      messageId: TARGET_A, origin: "regenerate", status: "running", model: "model-a", presetName: null, presetId: null,
    });
    setVisibleTarget(TARGET_A, ["a"]);

    const { container } = renderQueueManager();

    expect(container.firstChild).toBeNull();
  });

  test("renders localized 1 of 3 for one persisted variant plus running and pending records", () => {
    setVisibleTarget(TARGET_A, ["a"]);
    useGenerationQueueStore.getState().startBatch(CHAT_A, TARGET_A, ["a"]);
    useGenerationQueueStore.getState().addRecord(CHAT_A, {
      messageId: TARGET_A, origin: "regenerate", status: "running", model: "model-b", presetName: null, presetId: null,
    });
    const pendingId = useGenerationQueueStore.getState().addRecord(CHAT_A, {
      messageId: TARGET_A, origin: "queue", status: "pending", model: "model-c", presetName: null, presetId: null,
    });
    useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT_A, messageId: TARGET_A, model: "model-c", promptPresetId: null, recordId: pendingId });

    const { getByRole } = renderQueueManager();

    expectCounter(getByRole, "1 of 3");
  });

  test("deduplicates a linked running queue job and record into localized 1 of 2", () => {
    setVisibleTarget(TARGET_A, ["a"]);
    useGenerationQueueStore.getState().startBatch(CHAT_A, TARGET_A, ["a"]);
    const recordId = useGenerationQueueStore.getState().addRecord(CHAT_A, {
      messageId: TARGET_A, origin: "queue", status: "running", model: "model-b", presetName: null, presetId: null,
    });
    const jobId = useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT_A, messageId: TARGET_A, model: "model-b", promptPresetId: null, recordId });
    useGenerationQueueStore.getState().markRunning(jobId);

    const { getByRole } = renderQueueManager();

    expectCounter(getByRole, "1 of 2");
  });

  test("keeps a drained batch mounted with its localized persisted 2 of 2 summary", () => {
    setVisibleTarget(TARGET_A, ["a", "b"]);
    useGenerationQueueStore.getState().startBatch(CHAT_A, TARGET_A, ["a", "b"]);

    const { getByRole } = renderQueueManager();

    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]).toBeUndefined();
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]).toBeUndefined();
    expectCounter(getByRole, "2 of 2");
  });

  test("keeps the batch mounted after clear and cancel leave no pending or running jobs", () => {
    setVisibleTarget(TARGET_A, ["a", "b"]);
    useGenerationQueueStore.getState().startBatch(CHAT_A, TARGET_A, ["a", "b"]);
    const clearRecord = useGenerationQueueStore.getState().addRecord(CHAT_A, {
      messageId: TARGET_A, origin: "queue", status: "pending", model: "model-c", presetName: null, presetId: null,
    });
    useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT_A, messageId: TARGET_A, model: "model-c", promptPresetId: null, recordId: clearRecord });
    useGenerationQueueStore.getState().clearPending(CHAT_A);
    const cancelRecord = useGenerationQueueStore.getState().addRecord(CHAT_A, {
      messageId: TARGET_A, origin: "queue", status: "pending", model: "model-d", presetName: null, presetId: null,
    });
    const cancelJob = useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT_A, messageId: TARGET_A, model: "model-d", promptPresetId: null, recordId: cancelRecord });
    useGenerationQueueStore.getState().cancelJob(cancelJob);

    const { getByRole } = renderQueueManager();

    expect(useGenerationQueueStore.getState().jobsByChat[CHAT_A]).toEqual([]);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT_A]).toEqual([]);
    expectCounter(getByRole, "2 of 2");
  });

  test("keeps the chip above the composer and opens the desktop popover", async () => {
    setVisibleTarget(TARGET_A, ["a"]);
    useGenerationQueueStore.getState().startBatch(CHAT_A, TARGET_A, ["a"]);

    const { container, getByRole, getByText } = renderQueueManager();
    const placement = container.querySelector("div.absolute.bottom-full.left-1\\.5.z-20.mb-1");
    expect(placement?.getAttribute("class")).toContain("absolute bottom-full left-1.5 z-20 mb-1");

    await act(async () => {
      fireEvent.click(getByRole("button", { name: /Generation queue/ }));
    });

    expect(getByText("Queue empty")).not.toBeNull();
  });

  test("hides when the batch target leaves message order", () => {
    setVisibleTarget(TARGET_A, ["a"]);
    useGenerationQueueStore.getState().startBatch(CHAT_A, TARGET_A, ["a"]);
    const { container } = renderQueueManager();

    expect(container.firstChild).not.toBeNull();
    act(() => { useSnapshotStore.setState({ messageOrder: [] }); });
    expect(container.firstChild).toBeNull();
  });

  test("does not render a batch owned only by another active chat", () => {
    setVisibleTarget(TARGET_B, ["a"]);
    useGenerationQueueStore.getState().startBatch(CHAT_B, TARGET_B, ["a"]);

    const { container } = renderQueueManager();

    expect(container.firstChild).toBeNull();
  });
});
