import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AppMessage, AppSnapshot } from "../../api/types.js";
import type { ChatGenerationJob } from "@vibe-tavern/api-contracts";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useGenerationQueueStore } from "../../stores/generation-queue-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { enqueueGenerateMore, useGenerationQueue } from "../../hooks/use-generation-queue.js";
import { refreshGenerationQueue } from "../../lib/chat-generation-queue-client.js";

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
const originalMatchMedia = window.matchMedia;
const originalFetch = globalThis.fetch;
let serverJobs: ChatGenerationJob[] = [];
let mobileViewport = false;

function matchMedia(query: string): MediaQueryList {
  return {
    matches: mobileViewport && query === "(max-width: 768px)",
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
}

afterAll(async () => {
  useChatStore.setState(initialChatState, true);
  useGenerationQueueStore.setState(initialQueueState, true);
  useSnapshotStore.setState(initialSnapshotState, true);
  window.matchMedia = originalMatchMedia;
  globalThis.fetch = originalFetch;
  await i18next.changeLanguage("en");
});

beforeEach(() => {
  mobileViewport = false;
  globalThis.fetch = originalFetch;
  serverJobs = [];
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      const input = JSON.parse(String(init.body));
      const job: ChatGenerationJob = { ...input, id: `server-${serverJobs.length}`, chatId: CHAT_A, enqueuedAt: 1, status: serverJobs.length ? "pending" : "running" };
      serverJobs = [...serverJobs, job]; return Response.json(job, { status: 201 });
    }
    return Response.json(serverJobs);
  }) as typeof fetch;
  window.matchMedia = matchMedia;
  useChatStore.setState({ activeChatId: CHAT_A });
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
  useSnapshotStore.setState({ messageOrder: [], messagesById: {} });
});

function setVisibleTarget(messageId: string, variantIds: string[]): void {
  useSnapshotStore.setState({
    messageOrder: [messageId],
    messagesById: {
      [messageId]: { id: messageId, role: "assistant", variants: variantIds.map((id, variantIndex) => ({ id, variantIndex, isSelected: variantIndex === 0 })) } as AppMessage,
    },
  });
}

function renderQueueManager() {
  return render(<LocaleProvider initialLocale="en"><QueueManager /></LocaleProvider>);
}

function QueueRunner(): null {
  useGenerationQueue();
  return null;
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

  test("keeps completed variants visible when the server hands off to the next queued job", async () => {
    setVisibleTarget(TARGET_A, ["a"]);
    useSnapshotStore.setState({ activeChat: { id: CHAT_A } as AppSnapshot["activeChat"] });
    const view = render(
      <LocaleProvider initialLocale="en">
        <QueueManager />
        <QueueRunner />
      </LocaleProvider>,
    );

    await act(async () => {
      await enqueueGenerateMore(TARGET_A, "model-b", null);
      await enqueueGenerateMore(TARGET_A, "model-c", null);
    });

    await act(async () => {
      setVisibleTarget(TARGET_A, ["a", "b"]);
      serverJobs = serverJobs.map((job, index) => index === 0 ? { ...job, status: "done", variantIndex: 1 } : { ...job, status: "running" });
      await refreshGenerationQueue(CHAT_A);
    });

    const running = useGenerationQueueStore.getState().recordsByChat[CHAT_A]?.find((record) => record.status === "running");
    expect(running).toMatchObject({ model: "model-c", startVariantPosition: 2 });
    expectCounter(view.getByRole, "2 of 3");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Generation queue/ }));
    });
    const rows = [...view.baseElement.querySelectorAll<HTMLElement>("[data-queue-timeline-row]")];
    expect(rows.map((row) => row.getAttribute("data-queue-timeline-row"))).toEqual(["finished", "finished", "running"]);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Variant 1"),
      expect.stringContaining("Variant 2"),
      expect.stringContaining("Writing"),
    ]);

    await act(async () => {
      setVisibleTarget(TARGET_A, ["a", "b", "c"]);
      serverJobs = serverJobs.map((job) => ({ ...job, status: "done" }));
      await refreshGenerationQueue(CHAT_A);
    });
    view.unmount();
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

    const timelineHeader = getByText("More variants");
    const popover = timelineHeader.parentElement?.parentElement;
    expect(popover?.getAttribute("class")).toContain("w-80");
    expect(popover?.getAttribute("data-side")).toBe("top");
  });

  test("opens the real mobile BottomSheet with durable timeline rows after the executable queue drains", async () => {
    mobileViewport = true;
    setVisibleTarget(TARGET_A, ["a", "b"]);
    useGenerationQueueStore.getState().startBatch(CHAT_A, TARGET_A, ["a", "b"]);

    const view = renderQueueManager();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Generation queue/ }));
    });

    const sheet = view.baseElement.querySelector<HTMLElement>(".bs-popup");
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelector("[data-queue-timeline]"))?.not.toBeNull();
    expect(sheet?.textContent).toContain("More variants");
    expect(sheet?.textContent).toContain("Variant 1");
    expect(sheet?.textContent).toContain("Variant 2");
    expect(sheet?.querySelector("[data-queue-timeline]")?.getAttribute("class")).toContain("max-h-[50vh]");
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
