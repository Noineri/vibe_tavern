/**
 * Contracts for `useChatEvents` — the per-chat SSE subscription (W7 / SPC-7b).
 *
 * Pins the subscription lifecycle, NOT the forwarding logic (that lives in the
 * backend chat-events-feature.test.ts). Three things must hold:
 *   1. an EventSource opens for the active chat and closes on unmount;
 *   2. changing chatId closes the previous source and opens a new one;
 *   3. a null activeChatId opens nothing.
 *
 * `EventSource` is stubbed globally (happy-dom's EventSource has no useful
 * constructor surface for this); i18n's `useT` is mocked so the hook does not
 * need a provider.
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { useDomEnv } from "../../test/dom-env.js";
import { installI18nContextSeam } from "../../test/i18n-context-seam.js";
import { TestEventSource } from "../../test/event-source-seam.js";
import { toastClickEvent } from "../../test/react-event-seam.js";

useDomEnv();

const { act, renderHook } = await import("@testing-library/react");
const { toast } = await import("sonner");
const { useChatStore } = await import("../stores/chat-store.js");
const { useChatNotifications } = await import("../stores/chat-notifications-store.js");
const { useModalStore } = await import("../stores/modal-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useGenerationQueueStore } = await import("../stores/generation-queue-store.js");
const { refreshGenerationQueue } = await import("../lib/chat-generation-queue-client.js");
const initialQueue = useGenerationQueueStore.getState();
const { generateChatSummaryAction } = await import("../stores/api-actions/chat-actions.js");
const { brandId } = await import("@vibe-tavern/domain");
import type { ChatId } from "@vibe-tavern/domain";

installI18nContextSeam();

// THE EventSource seam (../../test/event-source-seam.ts) — one derivation
// shared with use-agent-run-events / use-quota-events / SummaryTab. Carries
// this suite's pin verbatim: addEventListener is a per-instance bun mock,
// so `toHaveBeenCalledWith(kind, expect.any(Function))` keeps working.
const MockEventSource = TestEventSource;

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;
const success = spyOn(toast, "success");
const error = spyOn(toast, "error");
beforeEach(() => {
	globalThis.EventSource = originalEventSource;
	globalThis.fetch = originalFetch;
	success.mockClear();
	error.mockClear();
	useChatNotifications.setState({ byChat: {}, holdsByChat: {} });
	useChatStore.setState({ activeChatId: brandId<ChatId>("chat-1") });
	useModalStore.getState().setContextMemoryOpen(false);
	useSnapshotStore.getState().clear();
	useGenerationQueueStore.setState({ jobsByChat: {}, recordsByChat: {}, batchesByChat: {} });
	MockEventSource.instances = [];
	globalThis.EventSource = MockEventSource;
});
afterAll(() => {
	globalThis.EventSource = originalEventSource;
	globalThis.fetch = originalFetch;
	success.mockRestore();
	error.mockRestore();
	useGenerationQueueStore.setState(initialQueue, true);
});

const { useChatEvents } = await import("./use-chat-events.js");

it("queue.updated refreshes the existing pill state and keeps its background channel until settlement", async () => {
	const job = { id: "server-job", chatId: "chat-1", messageId: "assistant", model: "model", promptPresetId: null, status: "running" as const, enqueuedAt: 1 };
	let jobs: Array<Omit<typeof job, "status"> & { status: "running" | "done" }> = [job];
	globalThis.fetch = Object.assign(async () => Response.json(jobs), { preconnect: originalFetch.preconnect });
	const { rerender, unmount } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
	const source = MockEventSource.instances[0]!;
	await act(async () => { source.emit("queue.updated"); await refreshGenerationQueue("chat-1"); });
	expect(useGenerationQueueStore.getState().jobsByChat["chat-1"]?.[0]?.status).toBe("running");
	rerender({ id: "chat-2" });
	expect(source.closed).toBe(false);
	jobs = [{ ...job, status: "done" }];
	await act(async () => { source.emit("queue.updated"); await refreshGenerationQueue("chat-1"); });
	expect(source.closed).toBe(true);
	expect(useGenerationQueueStore.getState().recordsByChat["chat-1"]).toEqual([]);
	expect(success).not.toHaveBeenCalled();
	unmount();
});

it("ready refreshes queue state missed during reconnect and ignores callbacks from a closed source", async () => {
	const job = { id: "restored", chatId: "chat-1", messageId: "assistant", model: "model", promptPresetId: null, status: "pending", enqueuedAt: 1 };
	let reads = 0;
	globalThis.fetch = Object.assign(async () => { reads += 1; return Response.json([job]); }, { preconnect: originalFetch.preconnect });
	const { rerender, unmount } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
	const source = MockEventSource.instances[0]!;
	await act(async () => { source.emit("ready"); await refreshGenerationQueue("chat-1"); });
	expect(useGenerationQueueStore.getState().jobsByChat["chat-1"]?.[0]?.id).toBe("restored");
	await act(async () => { useGenerationQueueStore.getState().replaceServerJobs("chat-1", []); });
	rerender({ id: "chat-2" });
	const before = reads;
	await act(async () => { source.emit("queue.updated"); });
	expect(reads).toBe(before);
	unmount();
});

describe("useChatEvents — SPC-7b", () => {
	it("opens an EventSource for the active chat and closes it on unmount", () => {
		const { unmount } = renderHook(({ id }) => useChatEvents(id), {
			initialProps: { id: "chat-1" as string | null },
		});

		expect(MockEventSource.instances).toHaveLength(1);
		expect(MockEventSource.instances[0]!.url).toContain("/api/chats/chat-1/events");
		for (const kind of ["summary.started", "summary.generated", "summary.failed", "summary.cancelled", "queue.updated", "ready"]) {
			expect(MockEventSource.instances[0]!.addEventListener).toHaveBeenCalledWith(kind, expect.any(Function));
		}

		unmount();
		expect(MockEventSource.instances[0]!.closed).toBe(true);
	});

	it("closes the previous source and opens a new one when chatId changes", () => {
		const { rerender } = renderHook(({ id }) => useChatEvents(id), {
			initialProps: { id: "chat-1" as string | null },
		});
		expect(MockEventSource.instances).toHaveLength(1);

		rerender({ id: "chat-2" });
		expect(MockEventSource.instances).toHaveLength(2);
		expect(MockEventSource.instances[0]!.closed).toBe(true);
		expect(MockEventSource.instances[1]!.url).toContain("/api/chats/chat-2/events");
	});

	it("opens nothing when activeChatId is null", () => {
		renderHook(() => useChatEvents(null));
		expect(MockEventSource.instances).toHaveLength(0);
	});

	it("keeps a running chat subscribed in the background, isolates its state, then closes it", async () => {
		const { rerender, unmount } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" as string | null } });
		const first = MockEventSource.instances[0]!;
		await act(async () => { first.emit("summary.started", { source: "manual" }); });
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("generating");
		rerender({ id: "chat-2" });
		expect(first.closed).toBe(false);
		expect(useChatNotifications.getState().byChat["chat-2"]).toBeUndefined();
		await act(async () => { first.emit("summary.generated", { source: "manual", summaryId: "summary-a", label: "A" }); });
		expect(first.closed).toBe(true);
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("ready");
		expect(useChatNotifications.getState().byChat["chat-2"]).toBeUndefined();
		expect(success).toHaveBeenCalledTimes(1);
		unmount();
		expect(MockEventSource.instances.every((source) => source.closed)).toBe(true);
	});

	it("reattaches to its existing subscription when returning during generation", async () => {
		const { rerender } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
		const first = MockEventSource.instances[0]!;
		await act(async () => { first.emit("summary.started"); });
		rerender({ id: "chat-2" });
		rerender({ id: "chat-1" });
		expect(MockEventSource.instances).toHaveLength(2);
		expect(first.closed).toBe(false);
		expect(MockEventSource.instances[1]?.closed).toBe(true);
	});

	it("quiet cancellation returns only its own chat to idle without a toast", async () => {
		renderHook(() => useChatEvents("chat-1"));
		const source = MockEventSource.instances[0]!;
		await act(async () => { source.emit("summary.started", { source: "manual" }); });
		await act(async () => { source.emit("summary.cancelled", { source: "manual" }); });
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("idle");
		expect(success).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it("manual success reads the modal state at completion; auto success still toasts", async () => {
		renderHook(() => useChatEvents("chat-1"));
		const source = MockEventSource.instances[0]!;
		await act(async () => { source.emit("summary.started", { source: "manual" }); });
		useModalStore.getState().setContextMemoryOpen(true);
		await act(async () => { source.emit("summary.generated", { source: "manual", summaryId: "manual", label: "Manual" }); });
		expect(success).not.toHaveBeenCalled();
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("ready");
		await act(async () => { source.emit("summary.generated", { summaryId: "auto", label: "Auto" }); });
		expect(success).toHaveBeenCalledTimes(1);
		useModalStore.getState().setContextMemoryOpen(false);
		await act(async () => { source.emit("summary.generated", { source: "manual", summaryId: "closed", label: "Closed" }); });
		expect(success).toHaveBeenCalledTimes(2);
	});

	it("failure preserves the error toast and cannot stop another pending summary", async () => {
		renderHook(() => useChatEvents("chat-1"));
		const source = MockEventSource.instances[0]!;
		await act(async () => { source.emit("summary.started"); source.emit("summary.started", { source: "manual" }); });
		await act(async () => { source.emit("summary.failed", { source: "manual" }); });
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("generating");
		expect(error).toHaveBeenCalledWith("summary_failed_toast");
		await act(async () => { source.emit("summary.generated", { summaryId: "auto", label: "Auto" }); });
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("ready");
	});

	it("ignores stale callbacks from a closed source", async () => {
		const { rerender } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
		const first = MockEventSource.instances[0]!;
		rerender({ id: "chat-2" });
		await act(async () => { first.emit("summary.generated", { summaryId: "stale", label: "Stale" }); });
		expect(useChatNotifications.getState().byChat["chat-1"]).toBeUndefined();
		expect(success).not.toHaveBeenCalled();
	});

	it("review from a background summary opens that chat before memory", async () => {
		globalThis.fetch = Object.assign(async () => Response.json({ activeChat: { id: "chat-1" }, messages: [] }), { preconnect: originalFetch.preconnect });
		const { rerender } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
		const first = MockEventSource.instances[0]!;
		await act(async () => { first.emit("summary.started", { source: "manual" }); });
		useChatStore.getState().setActiveChatId(brandId<ChatId>("chat-2"));
		rerender({ id: "chat-2" });
		useModalStore.getState().setContextMemoryOpen(true);
		await act(async () => { first.emit("summary.generated", { source: "manual", summaryId: "background", label: "Background" }); });
		expect(success).toHaveBeenCalledTimes(1);
		useModalStore.getState().setContextMemoryOpen(false);
		const options = success.mock.calls[0]?.[1];
		await act(async () => {
			if (options?.action && typeof options.action === "object" && "onClick" in options.action) {
				await options.action.onClick?.(toastClickEvent());
			}
		});
		expect(useChatStore.getState().activeChatId).toBe(brandId<ChatId>("chat-1"));
		expect(useSnapshotStore.getState().activeChat?.id).toBe(brandId<ChatId>("chat-1"));
		expect(useModalStore.getState().isContextMemoryOpen).toBe(true);
	});

	it("retains the channel during manual-request preflight and prevents its response from replacing another chat", async () => {
		let finish!: (response: Response) => void;
		globalThis.fetch = Object.assign(() => new Promise<Response>((resolve) => { finish = resolve; }), { preconnect: originalFetch.preconnect });
		const { rerender } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
		let pending!: ReturnType<typeof generateChatSummaryAction>;
		await act(async () => {
			pending = generateChatSummaryAction(brandId<ChatId>("chat-1"), { providerProfileId: "profile", summarizedFrom: 1, summarizedTo: 2 });
		});
		const first = MockEventSource.instances[0]!;
		useChatStore.getState().setActiveChatId(brandId<ChatId>("chat-2"));
		rerender({ id: "chat-2" });
		expect(first.closed).toBe(false);
		await act(async () => { first.emit("summary.started", { source: "manual" }); });
		await act(async () => { first.emit("summary.generated", { source: "manual", summaryId: "manual", label: "Manual" }); });
		await act(async () => {
			finish(Response.json({ chatSummary: { id: "manual" }, snapshot: { activeChat: { id: "chat-1" }, summaries: [] } }));
			await pending;
		});
		expect(first.closed).toBe(true);
		expect(useSnapshotStore.getState().activeChat).toBeNull();
		expect(useChatStore.getState().activeChatId).toBe(brandId<ChatId>("chat-2"));
	});

	it("a JSON response arriving before SSE cannot close the channel and lose completion", async () => {
		let finish!: (response: Response) => void;
		globalThis.fetch = Object.assign(() => new Promise<Response>((resolve) => { finish = resolve; }), { preconnect: originalFetch.preconnect });
		const { rerender } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
		let pending!: ReturnType<typeof generateChatSummaryAction>;
		await act(async () => {
			pending = generateChatSummaryAction(brandId<ChatId>("chat-1"), { providerProfileId: "profile", summarizedFrom: 1, summarizedTo: 2 });
		});
		const first = MockEventSource.instances[0]!;
		rerender({ id: "chat-2" });
		await act(async () => {
			finish(Response.json({ chatSummary: { id: "late-event" }, snapshot: {} }));
			await pending;
		});
		expect(first.closed).toBe(false);
		await act(async () => {
			first.emit("summary.started", { source: "manual" });
			first.emit("summary.generated", { source: "manual", summaryId: "late-event", label: "Late SSE" });
		});
		expect(first.closed).toBe(true);
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("ready");
		expect(success).toHaveBeenCalledTimes(1);
	});

	it("a request rejected before a lifecycle starts releases its subscription hold", async () => {
		let fail!: (error: unknown) => void;
		globalThis.fetch = Object.assign(() => new Promise<Response>((_resolve, reject) => { fail = reject; }), { preconnect: originalFetch.preconnect });
		const { rerender } = renderHook(({ id }) => useChatEvents(id), { initialProps: { id: "chat-1" } });
		let pending!: ReturnType<typeof generateChatSummaryAction>;
		await act(async () => {
			pending = generateChatSummaryAction(brandId<ChatId>("chat-1"), { providerProfileId: "profile", summarizedFrom: 1, summarizedTo: 2 });
		});
		const first = MockEventSource.instances[0]!;
		rerender({ id: "chat-2" });
		await act(async () => {
			fail(new Error("Offline"));
			await expect(pending).rejects.toThrow("Offline");
		});
		expect(first.closed).toBe(true);
		expect(useChatNotifications.getState().holdsByChat["chat-1"]).toBeUndefined();
	});
});
