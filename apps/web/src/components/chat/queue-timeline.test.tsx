import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AppMessage, AppSnapshot } from "../../api/types.js";
import { brandId, type ChatId, type MessageVariantId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import en from "../../i18n/locales/en.json";
import ru from "../../i18n/locales/ru.json";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useGenerationQueueStore } from "../../stores/generation-queue-store.js";
import { useMessageAiEditorStore } from "../../stores/message-ai-editor-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";

useDomEnv();

const { act, fireEvent, render } = await import("@testing-library/react");
const { QueueTimeline } = await import("./queue-timeline.js");
const { LocaleProvider } = await import("../../i18n/context.js");
const { i18next, initI18n } = await import("../../i18n/i18n.js");

initI18n("en");
const CHAT = brandId<ChatId>("timeline-chat");
const MESSAGE_ID = "timeline-message";
const initialChat = useChatStore.getState();
const initialQueue = useGenerationQueueStore.getState();
const initialSnapshot = useSnapshotStore.getState();
const initialEditor = useMessageAiEditorStore.getState();
const initialProviderData = useProviderDataStore.getState();
const initialProvider = useProviderStore.getState();
const initialBootstrap = useBootstrapStore.getState();
const originalFetch = globalThis.fetch;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
let scrollCalls: ScrollIntoViewOptions[] = [];

afterAll(async () => {
  useChatStore.setState(initialChat, true);
  useGenerationQueueStore.setState(initialQueue, true);
  useSnapshotStore.setState(initialSnapshot, true);
  useMessageAiEditorStore.setState(initialEditor, true);
  useProviderDataStore.setState(initialProviderData, true);
  useProviderStore.setState(initialProvider, true);
  useBootstrapStore.setState(initialBootstrap, true);
  globalThis.fetch = originalFetch;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  await i18next.changeLanguage("en");
});

beforeEach(async () => {
  await i18next.changeLanguage("en");
  useChatStore.setState(initialChat, true);
  useGenerationQueueStore.setState(initialQueue, true);
  useSnapshotStore.setState(initialSnapshot, true);
  useMessageAiEditorStore.setState(initialEditor, true);
  useProviderDataStore.setState(initialProviderData, true);
  useProviderStore.setState(initialProvider, true);
  useBootstrapStore.setState(initialBootstrap, true);
  useChatStore.setState({ activeChatId: CHAT });
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify({}), { status: 200 }),
    { preconnect: originalFetch.preconnect },
  );
  scrollCalls = [];
  HTMLElement.prototype.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
    if (typeof options !== "boolean" && options) scrollCalls.push(options);
  };
});

function setMessage(variantIndexes: number[], selectedVariantIndex = variantIndexes[0] ?? 0): void {
  useSnapshotStore.setState({
    messageOrder: [MESSAGE_ID],
    messagesById: {
      [MESSAGE_ID]: {
        id: MESSAGE_ID,
        selectedVariantIndex,
        variants: variantIndexes.map((variantIndex, position) => ({
          id: `variant-${variantIndex}`,
          variantIndex,
          isSelected: position === 0,
          modelId: `provider/model-${variantIndex}`,
          presetName: `Preset ${variantIndex}`,
        })),
      } as AppMessage,
    },
  });
}

function startBatch(variantIndexes: number[]): void {
  useGenerationQueueStore.getState().startBatch(CHAT, MESSAGE_ID, variantIndexes.map((index) => `variant-${index}`));
}

function addRecord(status: "pending" | "running" | "failed", model: string, error?: string): string {
  return useGenerationQueueStore.getState().addRecord(CHAT, { messageId: MESSAGE_ID, origin: status === "pending" ? "queue" : "regenerate", status, model, presetName: "Scenario", presetId: null, error });
}

function renderTimeline(onClose = () => undefined, locale: "en" | "ru" = "en") {
  return render(<LocaleProvider initialLocale={locale}><QueueTimeline onClose={onClose} /></LocaleProvider>);
}

function rowLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-queue-timeline-row], [data-queue-timeline-fold]")).map((row) => row.textContent ?? "");
}

function interpolate(resource: string, count: number): string {
  return resource.replace("{count}", String(count));
}

function translateFold(count: number): string {
  return i18next.t("queue_timeline_folded", { count } as unknown as undefined);
}

describe("QueueTimeline desktop", () => {
  test("renders owner scenario one in durable finished-running-pending order with 1 of 3", () => {
    setMessage([0]);
    startBatch([0]);
    addRecord("running", "provider/model-b");
    const pending = addRecord("pending", "provider/model-c");
    useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT, messageId: MESSAGE_ID, model: "provider/model-c", promptPresetId: null, recordId: pending });

    const view = renderTimeline();

    expect(rowLabels(view.container)).toEqual(["Variant 1model-0 · Preset 0", "Writing…model-b · Scenario", "Waitingmodel-c · Scenario"]);
    expect(view.getByText("1 of 3")).not.toBeNull();
    expect(scrollCalls).toEqual([{ block: "nearest" }]);
  });

  test("renders owner scenario two in finished-running-pending order with 3 of 5", () => {
    setMessage([0, 1, 2]);
    startBatch([0, 1, 2]);
    addRecord("running", "provider/model-d");
    const pending = addRecord("pending", "provider/model-e");
    useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT, messageId: MESSAGE_ID, model: "provider/model-e", promptPresetId: null, recordId: pending });

    const view = renderTimeline();

    expect(rowLabels(view.container)).toEqual(["Variant 1model-0 · Preset 0", "Variant 2model-1 · Preset 1", "Variant 3model-2 · Preset 2", "Writing…model-d · Scenario", "Waitingmodel-e · Scenario"]);
    expect(view.getByText("3 of 5")).not.toBeNull();
  });

  test("maps persisted non-contiguous selection to its array position, selects by immutable id, and stars independently", async () => {
    setMessage([10, 30, 70], 30);
    startBatch([10, 30, 70]);
    let closes = 0;
    const view = renderTimeline(() => { closes += 1; });
    const rows = view.container.querySelectorAll<HTMLElement>("[data-queue-timeline-row=finished]");
    expect(rows[1]?.getAttribute("data-selected")).toBe("true");
    expect(rows[0]?.getAttribute("data-selected")).toBe("false");

    await act(async () => { fireEvent.click(view.getByTestId("variant-star-11")); });
    expect(useMessageAiEditorStore.getState().starredVariantIdsByMessage[MESSAGE_ID]).toEqual([brandId<MessageVariantId>("variant-10")]);
    expect(useSnapshotStore.getState().messagesById[MESSAGE_ID]?.selectedVariantIndex).toBe(30);
    expect(closes).toBe(0);

    await act(async () => { fireEvent.click(view.getByText("Variant 71")); });
    expect(useSnapshotStore.getState().messagesById[MESSAGE_ID]?.selectedVariantIndex).toBe(70);
    expect(useSnapshotStore.getState().swipeDirection).toBe(1);
    expect(closes).toBe(1);
  });

  test("expands folded finished rows, uses localized plural resources, and recalculates deterministic line progress", async () => {
    setMessage([0, 1, 2, 3, 4]);
    startBatch([0, 1, 2, 3]);
    addRecord("running", "provider/model-running");
    const view = renderTimeline();
    const accent = view.container.querySelector<HTMLElement>("[data-queue-timeline-accent]");
    expect(rowLabels(view.container)).toEqual(["4More 4 finished", "Variant 5model-4 · Preset 4", "Writing…model-running · Scenario"]);
    expect(accent?.style.height).toBe("50%");
    expect(accent?.getAttribute("data-last-finished-node")).toBe("1");
    expect(accent?.getAttribute("data-displayed-node-count")).toBe("3");

    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Show finished variants" })); });
    expect(rowLabels(view.container)).toEqual(["4More 4 finished", "Variant 1model-0 · Preset 0", "Variant 2model-1 · Preset 1", "Variant 3model-2 · Preset 2", "Variant 4model-3 · Preset 3", "Variant 5model-4 · Preset 4", "Writing…model-running · Scenario"]);
    expect(accent?.style.height).toBe("83.33333333333334%");
    expect(accent?.getAttribute("data-last-finished-node")).toBe("5");
    expect(accent?.getAttribute("data-displayed-node-count")).toBe("7");
    expect(view.getByRole("button", { name: "Hide finished variants" }).getAttribute("aria-expanded")).toBe("true");

    expect(translateFold(1)).toBe(interpolate(en.queue_timeline_folded_one, 1));
    expect(translateFold(2)).toBe(interpolate(en.queue_timeline_folded_other, 2));
    await act(async () => { await i18next.changeLanguage("ru"); });
    expect(translateFold(1)).toBe(interpolate(ru.queue_timeline_folded_one, 1));
    expect(translateFold(2)).toBe(interpolate(ru.queue_timeline_folded_few, 2));
    expect(translateFold(5)).toBe(interpolate(ru.queue_timeline_folded_many, 5));
    expect(translateFold(1.5)).toBe(interpolate(ru.queue_timeline_folded_other, 1.5));
  });

  test("keeps failure anchored before running, discloses its exact error, and cancels pending, queue-running, and plain running work", async () => {
    setMessage([0]);
    startBatch([0]);
    const failed = addRecord("failed", "provider/model-failed", "provider 429 exact");
    const runningQueue = addRecord("running", "provider/model-running");
    const runningJob = useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT, messageId: MESSAGE_ID, model: "provider/model-running", promptPresetId: null, recordId: runningQueue });
    useGenerationQueueStore.getState().markRunning(runningJob);
    const pending = addRecord("pending", "provider/model-pending");
    const pendingJob = useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT, messageId: MESSAGE_ID, model: "provider/model-pending", promptPresetId: null, recordId: pending });
    const plain = addRecord("running", "provider/model-plain");
    let aborts = 0;
    useChatStore.setState((state) => ({ abortGeneration: (chatId) => { aborts += chatId === CHAT ? 1 : 0; return state.abortGeneration(chatId); } }));
    const view = renderTimeline();
    expect(rowLabels(view.container)).toEqual(["Variant 1model-0 · Preset 0", "!Errormodel-failed · Scenario", "Writing…model-running · Scenario", "Writing…model-plain · Scenario", "Waitingmodel-pending · Scenario"]);

    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Show error details" })); });
    expect(view.getByText("provider 429 exact")).not.toBeNull();
    expect(view.getByRole("button", { name: "Hide error details" }).getAttribute("aria-expanded")).toBe("true");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Hide error details" })); });
    expect(view.getByRole("button", { name: "Show error details" }).getAttribute("aria-expanded")).toBe("false");
    const pendingRow = view.container.querySelector<HTMLElement>("[data-queue-timeline-row=pending]");
    await act(async () => { fireEvent.click(pendingRow!.querySelector<HTMLButtonElement>("button")!); });
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT]?.some((job) => job.id === pendingJob)).toBe(false);
    const queuedRunningRow = Array.from(view.container.querySelectorAll<HTMLElement>("[data-queue-timeline-row=running]")).find((row) => row.textContent?.includes("model-running"));
    await act(async () => { fireEvent.click(queuedRunningRow!.querySelector<HTMLButtonElement>("button")!); });
    expect(useGenerationQueueStore.getState().jobsByChat[CHAT]?.find((job) => job.id === runningJob)?.status).toBe("cancelled");
    const plainRunningRow = Array.from(view.container.querySelectorAll<HTMLElement>("[data-queue-timeline-row=running]")).find((row) => row.textContent?.includes("model-plain"));
    await act(async () => { fireEvent.click(plainRunningRow!.querySelector<HTMLButtonElement>("button")!); });
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT]?.some((record) => record.id === plain)).toBe(true);
    expect(aborts).toBe(2);
    expect(failed).not.toBe(plain);
  });

  test("clears only pending work and closes while finished and running records remain", async () => {
    setMessage([0, 1]);
    startBatch([0, 1]);
    const running = addRecord("running", "provider/model-running");
    const pending = addRecord("pending", "provider/model-pending");
    useGenerationQueueStore.getState().enqueueJob({ chatId: CHAT, messageId: MESSAGE_ID, model: "provider/model-pending", promptPresetId: null, recordId: pending });
    useProviderDataStore.setState({ profiles: [{ id: "profile", isActive: true, defaultModel: "vendor/live-one" }] } as typeof initialProviderData);
    useBootstrapStore.setState({ data: { promptPresets: [{ id: "preset-live", name: "Live preset" }] } } as typeof initialBootstrap);
    useSnapshotStore.setState({ activeChat: { promptPresetId: "preset-live" } as AppSnapshot["activeChat"] });
    let closes = 0;
    const view = renderTimeline(() => { closes += 1; });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Clear" })); });
    expect(closes).toBe(1);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT]?.map((record) => record.id)).toContain(running);
    expect(useGenerationQueueStore.getState().recordsByChat[CHAT]?.map((record) => record.id)).not.toContain(pending);

  });

  test("keeps a truly drained batch visible and enqueues against its durable target with live footer labels", async () => {
    setMessage([0, 1]);
    startBatch([0, 1]);
    useProviderDataStore.setState({ profiles: [{ id: "profile", isActive: true, defaultModel: "vendor/live-one" }] } as typeof initialProviderData);
    useBootstrapStore.setState({ data: { promptPresets: [{ id: "preset-one", name: "Live preset one" }, { id: "preset-two", name: "Live preset two" }] } } as typeof initialBootstrap);
    useSnapshotStore.setState({ activeChat: { promptPresetId: "preset-one" } as AppSnapshot["activeChat"] });
    let closes = 0;
    const view = renderTimeline(() => { closes += 1; });
    expect(rowLabels(view.container)).toEqual(["Variant 1model-0 · Preset 0", "Variant 2model-1 · Preset 1"]);
    const footer = view.getByRole("button", { name: /One more/ });
    expect(footer.textContent).toContain("live-one · Live preset one");
    expect(footer.querySelector("span:last-child")?.getAttribute("title")).toBe("live-one · Live preset one");
    expect(footer.querySelector("span:last-child")?.getAttribute("class")).toContain("truncate");
    expect(footer.getAttribute("class")).toContain("px-3 py-[9px]");

    await act(async () => {
      useProviderDataStore.setState({ profiles: [{ id: "profile", isActive: true, defaultModel: "vendor/live-two" }] } as typeof initialProviderData);
      useSnapshotStore.setState({ activeChat: { promptPresetId: "preset-two" } as AppSnapshot["activeChat"] });
    });
    expect(footer.textContent).toContain("live-two · Live preset two");
    expect(footer.querySelector("span:last-child")?.getAttribute("title")).toBe("live-two · Live preset two");
    await act(async () => { fireEvent.click(footer); });
    const job = useGenerationQueueStore.getState().jobsByChat[CHAT]?.at(-1);
    expect(job?.messageId).toBe(MESSAGE_ID);
    expect(job?.model).toBe("vendor/live-two");
    expect(job?.promptPresetId).toBe("preset-two");
    expect(closes).toBe(0);
  });

  test("pins desktop geometry, inline metadata, theme tokens, and the shared 16px running ring", async () => {
    setMessage([0]);
    startBatch([0]);
    addRecord("running", "provider/model-running");
    addRecord("failed", "provider/model-failed", "exact error");
    const view = renderTimeline();
    expect(view.container.querySelector("[data-queue-timeline-header]")?.getAttribute("class")).toContain("gap-2 border-b border-border px-3 py-2.5");
    expect(view.container.querySelector("[data-queue-timeline]")?.getAttribute("class")).toContain("max-h-64 overflow-y-auto");
    expect(view.container.querySelector("[data-queue-timeline-row=finished]")?.getAttribute("class")).toContain("min-h-9 items-center gap-2.5 px-3 py-1.5");
    expect(view.container.querySelector("[data-queue-timeline-row=finished] button span:nth-child(2)")?.getAttribute("class")).toBe("shrink-0 whitespace-nowrap");
    expect(view.container.querySelector("[data-queue-timeline-row=finished] button span:last-child")?.getAttribute("class")).toContain("min-w-0 truncate text-t3");
    expect(view.getByTestId("queue-timeline-running-ring").getAttribute("class")).toBe("h-4 w-4 animate-spin-slow");
    expect(view.getAllByRole("button", { name: "Cancel generation" })[0]?.getAttribute("class")).toContain("h-6 w-6");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Show error details" })); });
    expect(view.container.querySelector("[data-queue-timeline-error]")?.getAttribute("class")).toContain("px-3 pb-2 pl-[38px]");
  });
});
