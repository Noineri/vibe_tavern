import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { brandId, type ChatId, type MessageVariantId } from "@vibe-tavern/domain";
import type { ChatGenerationJob } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import type { AppSnapshot } from "../api/types.js";
import { useChatStore } from "../stores/chat-store.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { cancelQueueJob, clearQueuePending, enqueueGenerateMore, useGenerationQueue } from "./use-generation-queue.js";
import { refreshGenerationQueue } from "../lib/chat-generation-queue-client.js";
import { useDomEnv } from "../../test/dom-env.js";
import { wireMessage, wireVariant } from "../../test/wire-fixtures.js";

useDomEnv();
const { act, renderHook, waitFor } = await import("@testing-library/react");
const A = brandId<ChatId>("queue-chat-a"), B = brandId<ChatId>("queue-chat-b"), MESSAGE = "assistant-message";
const originalFetch = globalThis.fetch;
const originalChat = useChatStore.getState(), originalSnapshot = useSnapshotStore.getState(), originalQueue = useGenerationQueueStore.getState();
const errorToast = spyOn(toast, "error").mockImplementation(() => "error");
let jobs: ChatGenerationJob[] = [], calls: Array<{ path: string; method: string; body?: unknown }> = [];
let failEnqueue = false;
function job(id: string, status: ChatGenerationJob["status"] = "pending"): ChatGenerationJob {
  return { id, chatId: A, messageId: MESSAGE, model: id, promptPresetId: null, status, enqueuedAt: 1 };
}
function setVariants(ids: string[]) {
  useSnapshotStore.setState({
    messagesById: { [MESSAGE]: wireMessage(MESSAGE, {
      variants: ids.map((id, variantIndex) => wireVariant(MESSAGE, variantIndex, { id: brandId<MessageVariantId>(id) })),
    }) },
    messageOrder: [MESSAGE],
  });
}
beforeEach(() => {
  globalThis.fetch = originalFetch; errorToast.mockClear(); failEnqueue = false; calls = []; jobs = [];
  useChatStore.setState({ activeChatId: A, generations: {} });
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
  useSnapshotStore.setState({ activeChat: { id: A, mode: "rp" } as AppSnapshot["activeChat"] });
  setVariants(["original"]);
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (method === "GET") return Response.json(jobs);
    if (method === "POST" && path.endsWith("/queue")) {
      if (failEnqueue) return Response.json({ error: "Enqueue refused" }, { status: 400 });
      const next = { ...job(`server-${jobs.length}`), ...body }; jobs = [...jobs, next]; return Response.json(next, { status: 201 });
    }
    if (method === "DELETE") jobs = jobs.map((item) => path.endsWith(`/${item.id}`) ? { ...item, status: "cancelled" } : item);
    if (path.endsWith("/clear")) jobs = jobs.filter((item) => item.status !== "pending");
    return Response.json({ ok: true });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch; errorToast.mockRestore();
  useChatStore.setState(originalChat, true); useSnapshotStore.setState(originalSnapshot, true); useGenerationQueueStore.setState(originalQueue, true);
});

test("enqueue sends ordered complete frozen keys; browser never starts a regenerate", async () => {
  await act(async () => { await Promise.all([enqueueGenerateMore(MESSAGE, "model-a", "preset-a"), enqueueGenerateMore(MESSAGE, "model-b", null)]); });
  expect(calls.filter((call) => call.method === "POST")).toEqual([
    { path: `/api/chats/${A}/queue`, method: "POST", body: { messageId: MESSAGE, model: "model-a", promptPresetId: "preset-a" } },
    { path: `/api/chats/${A}/queue`, method: "POST", body: { messageId: MESSAGE, model: "model-b", promptPresetId: null } },
  ]);
  expect(useGenerationQueueStore.getState().jobsByChat[A]?.map((item) => item.id)).toEqual(["server-0", "server-1"]);
  expect(useGenerationQueueStore.getState().recordsByChat[A]?.map((record) => record.status)).toEqual(["pending", "pending"]);
});

test("server progress continues while another chat is on screen without replacing its snapshot", async () => {
  await enqueueGenerateMore(MESSAGE, "model-a", null);
  useChatStore.getState().setActiveChatId(B);
  useSnapshotStore.setState({ activeChat: { id: B } as AppSnapshot["activeChat"] });
  jobs = jobs.map((item) => ({ ...item, status: "done", variantIndex: 1 }));
  await refreshGenerationQueue(A);
  expect(useGenerationQueueStore.getState().jobsByChat[A]?.[0]?.status).toBe("done");
  expect(useGenerationQueueStore.getState().recordsByChat[A]).toEqual([]);
  expect(useSnapshotStore.getState().activeChat?.id).toBe(B);
  expect(useChatStore.getState().activeChatId).toBe(B);
  expect(calls.every((call) => !call.path.includes("regenerate"))).toBe(true);
});

test("clear calls the server and preserves running and failed evidence", async () => {
  jobs = [job("running", "running"), job("pending"), { ...job("failed", "failed"), error: "Provider cut" }];
  await refreshGenerationQueue(A);
  await clearQueuePending();
  expect(calls).toContainEqual({ path: `/api/chats/${A}/queue/clear`, method: "POST", body: undefined });
  expect(useGenerationQueueStore.getState().jobsByChat[A]?.map((item) => item.status)).toEqual(["running", "failed"]);
  expect(useGenerationQueueStore.getState().recordsByChat[A]?.map((record) => record.status)).toEqual(["running", "failed"]);
});

test("pending cancellation removes only its projected record and retains canonical cancelled history", async () => {
  jobs = [job("cancel"), job("survivor")]; await refreshGenerationQueue(A);
  await cancelQueueJob("cancel");
  expect(calls).toContainEqual({ path: `/api/chats/${A}/queue/cancel`, method: "DELETE", body: undefined });
  expect(useGenerationQueueStore.getState().jobsByChat[A]?.map((item) => item.status)).toEqual(["cancelled", "pending"]);
  expect(useGenerationQueueStore.getState().recordsByChat[A]?.map((record) => record.id)).toEqual(["survivor"]);
});

for (const partial of [true, false]) test(`running cancellation preserves ${partial ? "a partial" : "no invented"} server variant and does not abort the local reader`, async () => {
  jobs = [job("running", "running")]; await refreshGenerationQueue(A);
  const reader = useChatStore.getState().startGeneration(A, null, [], MESSAGE);
  setVariants(partial ? ["original", "partial"] : ["original"]);
  await cancelQueueJob("running");
  expect(reader.signal.aborted).toBe(false);
  expect(useChatStore.getState().generations[A]?.isSending).toBe(true);
  expect(useSnapshotStore.getState().messagesById[MESSAGE]?.variants.map((variant) => String(variant.id))).toEqual(partial ? ["original", "partial"] : ["original"]);
  expect(useGenerationQueueStore.getState().recordsByChat[A]).toEqual([]);
  useChatStore.getState().finishGeneration(A);
});

test("failed work retains server error text and does not prevent later successful work from projecting", async () => {
  jobs = [{ ...job("failed", "failed"), error: "provider rate limit" }, { ...job("done", "done"), variantIndex: 1 }];
  await refreshGenerationQueue(A);
  expect(useGenerationQueueStore.getState().recordsByChat[A]).toMatchObject([{ status: "failed", error: "provider rate limit" }]);
  expect(useGenerationQueueStore.getState().jobsByChat[A]?.[1]?.status).toBe("done");
});

test("reload restores server-only jobs, batch, failed records and no client timeline identity is required", async () => {
  jobs = [job("running", "running"), job("waiting"), { ...job("interrupted", "failed"), error: "Retry this job" }];
  const hook = renderHook(() => useGenerationQueue());
  await waitFor(() => expect(useGenerationQueueStore.getState().jobsByChat[A]).toHaveLength(3));
  expect(useGenerationQueueStore.getState().batchesByChat[A]).toEqual({ messageId: MESSAGE, variantIdsAtStart: ["original"] });
  expect(useGenerationQueueStore.getState().jobsByChat[A]?.[0]?.recordId).toBe("running");
  hook.unmount(); await refreshGenerationQueue(A);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("an enqueue HTTP failure leaves no invented pending job and a later retry succeeds", async () => {
  failEnqueue = true; await enqueueGenerateMore(MESSAGE, "model", null);
  expect(useGenerationQueueStore.getState().jobsByChat[A] ?? []).toEqual([]);
  expect(errorToast).toHaveBeenCalledTimes(1);
  failEnqueue = false; await enqueueGenerateMore(MESSAGE, "model", null);
  expect(useGenerationQueueStore.getState().jobsByChat[A]).toHaveLength(1);
});

test("a parked older hydration cannot overwrite a later cancellation", async () => {
  jobs = [job("cancel")]; await refreshGenerationQueue(A);
  const transport = globalThis.fetch;
  let release!: (response: Response) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let park = true;
  globalThis.fetch = (async (input, init) => {
    if (park && (!init?.method || init.method === "GET")) { park = false; entered(); return new Promise<Response>((resolve) => { release = resolve; }); }
    return transport(input, init);
  }) as typeof fetch;
  const older = refreshGenerationQueue(A); await ready;
  const cancel = cancelQueueJob("cancel");
  release(Response.json(jobs)); await older; await cancel;
  expect(useGenerationQueueStore.getState().jobsByChat[A]?.[0]?.status).toBe("cancelled");
});
