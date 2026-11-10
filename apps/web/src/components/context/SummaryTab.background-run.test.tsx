/** BR-1e: real tab/actions/RPC and shared SSE hook; only browser network boundaries are doubled. */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";
import type { ChatSummaryRecord } from "../../api/types.js";
import type { ManualSummaryRunState } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../test/dom-env.js";
import { TestEventSource } from "../../../test/event-source-seam.js";

useDomEnv();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { toast } = await import("sonner");
const { useSummaryTab } = await import("./SummaryTab.js");
const { useChatEvents } = await import("../../hooks/use-chat-events.js");
const { useChatNotifications } = await import("../../stores/chat-notifications-store.js");
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const { useChatStore } = await import("../../stores/chat-store.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
const { useModalStore } = await import("../../stores/modal-store.js");

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const notificationState = useChatNotifications.getState();
const snapshotState = useSnapshotStore.getState();
const chatState = useChatStore.getState();
const bootstrapState = useBootstrapStore.getState();
const modalState = useModalStore.getState();
function restoreStores() {
  useChatNotifications.setState(notificationState, true);
  useSnapshotStore.setState(snapshotState, true);
  useChatStore.setState(chatState, true);
  useBootstrapStore.setState(bootstrapState, true);
  useModalStore.setState(modalState, true);
}
const errorToast = spyOn(toast, "error");
const successToast = spyOn(toast, "success");
const releases: Array<() => void> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function parkedResponse() {
  const gate = deferred<Response>();
  releases.push(() => gate.resolve(Response.json(null)));
  return gate;
}
// THE EventSource seam (../../../test/event-source-seam.ts) — this file's 7e
// inline stand-in became the shared derivation in step 8b (the three hooks
// suites joined the same boundary), so the class lives there now. Same
// member-for-member shape: assignable to `typeof EventSource`, real
// MessageEvent delivery, per-instance addEventListener call tracking.
const NetworkEvents = TestEventSource;
function summary(id = "old", chatId = "chat"): ChatSummaryRecord {
  return {
    id, chatId, branchId: "branch", label: id, content: `${id} memory`,
    summarizedFrom: 1, summarizedTo: 3, includeInContext: true, excludeSummarized: true,
    source: "manual", sortOrder: 0, contentHash: null, createdAt: "2026-10-29", updatedAt: "2026-10-29",
  };
}
const props = {
  onClose: () => {}, providers: [{ id: "provider", name: "Provider", defaultModel: "model", isActive: true }],
  contextWindow: { used: 0, limit: 100 }, currentSummary: "", messageCount: 12,
  onSummarize: async () => "", onSaveSummary: async () => "", onFetchModelsForProfile: async () => [],
};
function Harness({ isOpen = true, chatId = "chat" }: { isOpen?: boolean; chatId?: string }) {
  useChatEvents(chatId);
  const tab = useSummaryTab({ ...props, isOpen, activeChatId: chatId as ChatId });
  return isOpen ? <><h1>{tab.detailTitle}</h1>{tab.detailEditor}</> : null;
}
let rows: Record<string, ChatSummaryRecord[]>;
let running: ManualSummaryRunState;
let requests: string[];
let bodies: unknown[];
let postResponse: ReturnType<typeof parkedResponse>;
let stateResponse: ReturnType<typeof parkedResponse> | null;
let listResponse: ReturnType<typeof parkedResponse> | null;
let stopStatus: number;
let postSignal: AbortSignal | null | undefined;
async function network(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const path = new URL(url, "http://localhost").pathname.replace(/^\/null/, "");
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  requests.push(`${method} ${path}`);
  const match = path.match(/^\/api\/chats\/([^/]+)\/summaries(.*)$/);
  if (!match) throw new Error(`Unexpected request: ${method} ${path}`);
  const chatId = match[1]!;
  if (method === "GET" && match[2] === "") return listResponse?.promise ?? Response.json(rows[chatId] ?? []);
  if (method === "GET" && match[2] === "/generate") return stateResponse?.promise ?? Response.json(running);
  if (method === "POST" && match[2] === "/generate/stop") {
    return stopStatus === 200 ? Response.json({ stopped: true }) : Response.json({ error: "Stop failed" }, { status: stopStatus });
  }
  if (method === "POST" && match[2] === "/generate") {
    bodies.push(input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body)));
    postSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return postResponse.promise;
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
}
beforeEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  restoreStores();
  errorToast.mockClear();
  successToast.mockClear();
  useChatNotifications.setState({ byChat: {}, holdsByChat: {} });
  useSnapshotStore.getState().clear();
  useChatStore.setState({ activeChatId: "chat" as ChatId });
  useBootstrapStore.setState({ data: null });
  useModalStore.getState().setContextMemoryOpen(true);
  NetworkEvents.instances = [];
  rows = { chat: [summary()], other: [summary("other", "other")] };
  running = null;
  requests = [];
  bodies = [];
  postSignal = undefined;
  postResponse = parkedResponse();
  stateResponse = null;
  listResponse = null;
  stopStatus = 200;
  globalThis.fetch = Object.assign(network, { preconnect: originalFetch.preconnect });
  globalThis.EventSource = NetworkEvents;
});
afterEach(async () => { await act(async () => { for (const release of releases.splice(0)) release(); }); });
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  restoreStores();
  errorToast.mockRestore();
  successToast.mockRestore();
});
async function loaded() {
  const view = render(<Harness />);
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("old"));
  return view;
}
function source(chatId = "chat") {
  const result = NetworkEvents.instances.find((item) => item.url.slice(item.url.indexOf("/api/")).split("?")[0] === `/api/chats/${chatId}/events` && !item.closed);
  if (!result) throw new Error(`Missing source for ${chatId}`);
  return result;
}

test("a watched generation keeps its inputs, selects the returned summary and uses the existing controls", async () => {
  const view = await loaded();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_generate_range" })); });
  expect(bodies).toEqual([expect.objectContaining({
    providerProfileId: "provider", model: "model", targetSummaryId: "old", label: "old",
    summarizedFrom: 1, summarizedTo: 3, temperature: 0.3, maxOutputTokens: 8192, contextBudget: 128000,
    includePriorSummaries: true, maxPriorSummaries: 10,
  })]);
  expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy();
  const generated = summary("new");
  await act(async () => {
    postResponse.resolve(Response.json({ summary: generated.content, chatSummary: generated, snapshot: {} }));
  });
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("new"));
  expect((view.getByPlaceholderText("summary_placeholder_short") as HTMLTextAreaElement).value).toBe("new memory");
  expect(view.getByRole("button", { name: "summary_generate_range" })).toBeTruthy();
  rows.chat = [summary(), generated];
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: generated.id, label: generated.label }); });
  view.unmount();
});

test("every reopen queries this chat's active run and restores the existing stop control", async () => {
  running = { from: 4, to: 8, label: "Still writing", startedAt: 123 };
  const view = render(<Harness isOpen={false} />);
  expect(requests).toEqual([]);
  view.rerender(<Harness />);
  await waitFor(() => expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy());
  expect(view.queryByRole("button", { name: "summary_generate_range" })).toBeNull();
  expect(NetworkEvents.instances).toHaveLength(1);
  view.rerender(<Harness isOpen={false} />);
  view.rerender(<Harness />);
  await waitFor(() => expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy());
  expect(requests.filter((request) => request === "GET /api/chats/chat/summaries/generate")).toHaveLength(2);
  view.unmount();
});

test("stop calls the server without aborting the watched POST and cancellation stays quiet", async () => {
  const view = await loaded();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_generate_range" })); });
  running = { from: 1, to: 3, label: "old", startedAt: 123 };
  await act(async () => { source().emit("summary.started", { source: "manual" }); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_stop_btn" })); });
  expect(requests).toContain("POST /api/chats/chat/summaries/generate/stop");
  expect(postSignal?.aborted ?? false).toBe(false);
  expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy();
  running = null;
  await act(async () => {
    source().emit("summary.cancelled", { source: "manual" });
    postResponse.resolve(Response.json({ error: { kind: "Cancelled", message: "Cancelled" } }, { status: 499 }));
  });
  expect(view.getByRole("button", { name: "summary_generate_range" })).toBeTruthy();
  expect(errorToast).not.toHaveBeenCalled();
  expect(successToast).not.toHaveBeenCalled();
  expect(view.getByRole("heading").textContent).toBe("old");
  view.unmount();
});

test("a recovered run stops through the server even with no local request to abort", async () => {
  running = { from: 1, to: 3, label: "Remote", startedAt: 123 };
  const view = await loaded();
  await waitFor(() => expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy());
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_stop_btn" })); });
  expect(requests).toContain("POST /api/chats/chat/summaries/generate/stop");
  expect(bodies).toHaveLength(0);
  running = null;
  await act(async () => { source().emit("summary.cancelled", { source: "manual" }); });
  expect(view.getByRole("button", { name: "summary_generate_range" })).toBeTruthy();
  expect(errorToast).not.toHaveBeenCalled();
  view.unmount();
});

test("the shared generated event reloads the archive and selects its id, not the first row", async () => {
  running = { from: 1, to: 3, label: "Remote", startedAt: 123 };
  const view = await loaded();
  rows.chat = [summary(), summary("new")];
  running = null;
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "new", label: "new" }); });
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("new"));
  expect((view.getByPlaceholderText("summary_placeholder_short") as HTMLTextAreaElement).value).toBe("new memory");
  expect(requests.filter((request) => request === "GET /api/chats/chat/summaries")).toHaveLength(2);
  expect(view.getByRole("button", { name: "summary_generate_range" })).toBeTruthy();
  expect(successToast).not.toHaveBeenCalled();
  expect(NetworkEvents.instances).toHaveLength(1);
  view.unmount();
});

test("automatic completion refreshes the selected summary without clearing a manual run", async () => {
  running = { from: 1, to: 3, label: "Remote", startedAt: 123 };
  const view = await loaded();
  rows.chat = [summary(), { ...summary("automatic"), source: "auto" }];
  await act(async () => { source().emit("summary.generated", { summaryId: "automatic", label: "automatic" }); });
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("automatic"));
  expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy();
  await act(async () => { source().emit("summary.failed"); });
  expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy();
  view.unmount();
});

test("a background chat's completion cannot select its summary or change this chat's controls", async () => {
  const view = await loaded();
  await act(async () => { source().emit("summary.started", { source: "manual" }); });
  const oldSource = source();
  useChatStore.setState({ activeChatId: "other" as ChatId });
  view.rerender(<Harness chatId="other" />);
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("other"));
  const requestCount = requests.length;
  await act(async () => { oldSource.emit("summary.generated", { source: "manual", summaryId: "foreign", label: "Foreign" }); });
  expect(requests).toHaveLength(requestCount);
  expect(view.getByRole("heading").textContent).toBe("other");
  expect(view.getByRole("button", { name: "summary_generate_range" })).toBeTruthy();
  view.unmount();
});

test("closing detaches the listener and a late watched response cannot select into a reopened view", async () => {
  const view = await loaded();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_generate_range" })); });
  view.rerender(<Harness isOpen={false} />);
  const requestCount = requests.length;
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "late", label: "Late" }); });
  expect(requests).toHaveLength(requestCount);
  expect(postSignal?.aborted ?? false).toBe(false);
  view.rerender(<Harness />);
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("old"));
  await act(async () => {
    postResponse.resolve(Response.json({ summary: "Late", chatSummary: summary("late"), snapshot: {} }));
  });
  expect(view.getByRole("heading").textContent).toBe("old");
  expect(requests.filter((request) => request === "GET /api/chats/chat/summaries/generate")).toHaveLength(2);
  view.unmount();
});

test("a late recovery GET cannot revive a run after its completion event", async () => {
  const stale = parkedResponse();
  stateResponse = stale;
  const view = await loaded();
  expect((view.getByRole("button", { name: "summary_generate_range" }) as HTMLButtonElement).disabled).toBe(true);
  rows.chat = [summary(), summary("new")];
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "new", label: "new" }); });
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("new"));
  await act(async () => { stale.resolve(Response.json({ from: 1, to: 3, label: "Stale", startedAt: 123 })); });
  expect(view.queryByRole("button", { name: "summary_stop_btn" })).toBeNull();
  expect((view.getByRole("button", { name: "summary_generate_range" }) as HTMLButtonElement).disabled).toBe(false);
  view.unmount();
});

test("a stale initial list cannot overwrite the selection from a newer generated event", async () => {
  const stale = parkedResponse();
  listResponse = stale;
  const view = render(<Harness />);
  listResponse = null;
  rows.chat = [summary(), summary("new")];
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "new", label: "new" }); });
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("new"));
  await act(async () => { stale.resolve(Response.json([summary()])); });
  expect(view.getByRole("heading").textContent).toBe("new");
  view.unmount();
});

test("delayed list and state responses from another chat are ignored", async () => {
  const staleList = parkedResponse();
  const staleState = parkedResponse();
  listResponse = staleList;
  stateResponse = staleState;
  const view = render(<Harness />);
  listResponse = null;
  stateResponse = null;
  view.rerender(<Harness chatId="other" />);
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("other"));
  await act(async () => {
    staleList.resolve(Response.json([summary("foreign")]));
    staleState.resolve(Response.json({ from: 1, to: 3, label: "Foreign", startedAt: 123 }));
  });
  expect(view.getByRole("heading").textContent).toBe("other");
  expect(view.queryByRole("button", { name: "summary_stop_btn" })).toBeNull();
  view.unmount();
});

test("two generated events select the latest result even when the first reload finishes last", async () => {
  const view = await loaded();
  const stale = parkedResponse();
  listResponse = stale;
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "first", label: "first" }); });
  listResponse = null;
  rows.chat = [summary(), summary("first"), summary("second")];
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "second", label: "second" }); });
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("second"));
  await act(async () => { stale.resolve(Response.json([summary(), summary("first")])); });
  expect(view.getByRole("heading").textContent).toBe("second");
  view.unmount();
});

test("a failed stop preserves its control and a remote manual failure clears it", async () => {
  running = { from: 1, to: 3, label: "Remote", startedAt: 123 };
  const view = await loaded();
  stopStatus = 503;
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_stop_btn" })); });
  expect(errorToast).toHaveBeenCalledWith("Stop failed");
  expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy();
  running = null;
  await act(async () => { source().emit("summary.failed", { source: "manual" }); });
  expect(view.getByRole("button", { name: "summary_generate_range" })).toBeTruthy();
  view.unmount();
});

test("a duplicate start recovers the server's run instead of dropping back to generate", async () => {
  const view = await loaded();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_generate_range" })); });
  running = { from: 1, to: 3, label: "Remote", startedAt: 123 };
  await act(async () => { postResponse.resolve(Response.json({ error: "Already running", code: "AGENT_RUN_ACTIVE" }, { status: 409 })); });
  expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy();
  expect(requests.filter((request) => request === "GET /api/chats/chat/summaries/generate")).toHaveLength(2);
  expect(errorToast).not.toHaveBeenCalled();
  view.unmount();
});

test("a delayed watched response cannot replace a newer completed summary's selection", async () => {
  const view = await loaded();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_generate_range" })); });
  rows.chat = [summary(), summary("first")];
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "first", label: "first" }); });
  rows.chat = [summary(), summary("first"), summary("second")];
  await act(async () => { source().emit("summary.generated", { source: "manual", summaryId: "second", label: "second" }); });
  await waitFor(() => expect(view.getByRole("heading").textContent).toBe("second"));
  await act(async () => { postResponse.resolve(Response.json({ summary: "first memory", chatSummary: summary("first"), snapshot: {} })); });
  expect(view.getByRole("heading").textContent).toBe("second");
  expect((view.getByPlaceholderText("summary_placeholder_short") as HTMLTextAreaElement).value).toBe("second memory");
  view.unmount();
});

test("a disconnected POST recovers the still-running job rather than pretending it stopped", async () => {
  const view = await loaded();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "summary_generate_range" })); });
  running = { from: 1, to: 3, label: "Still running", startedAt: 123 };
  await act(async () => { postResponse.resolve(Response.json({ error: "Connection lost" }, { status: 502 })); });
  expect(errorToast).toHaveBeenCalledWith("Connection lost");
  expect(view.getByRole("button", { name: "summary_stop_btn" })).toBeTruthy();
  expect(requests.filter((request) => request === "GET /api/chats/chat/summaries/generate")).toHaveLength(2);
  view.unmount();
});
