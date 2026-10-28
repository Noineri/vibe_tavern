/** BR-0: real controller -> HTTP/SSE -> snapshot stores, with only fetch doubled. */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot, ProviderProfileRecord } from "../api/types.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { useChatController } = await import("./use-chat-controller.js");
const { refreshChatSnapshotCache } = await import("./generation-batch-lifecycle.js");
const { useChatStore } = await import("../stores/chat-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useProviderStore } = await import("../stores/provider-store.js");
const { useProviderDataStore } = await import("../stores/provider-data-store.js");
const { useGenerationQueueStore } = await import("../stores/generation-queue-store.js");
const { useBootstrapStore } = await import("../stores/api-actions/bootstrap-actions.js");

const originalFetch = globalThis.fetch;
const originalProviders = useProviderDataStore.getState();
const originalConnection = useProviderStore.getState().connection;
const A = brandId<ChatId>("chat-a");
const B = brandId<ChatId>("chat-b");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Fields unrelated to snapshot ingestion are deliberately absent on this wire fixture. */
function snapshot(chatId: ChatId, content: string, insights = false): AppSnapshot {
  return {
    activeChat: { id: chatId, characterId: `character-${chatId}`, mode: "rp", insightsConfig: { objectiveEnabled: insights, trackerEnabled: false } },
    character: { id: `character-${chatId}`, name: `Character ${chatId}` },
    activeBranch: { id: `branch-${chatId}`, chatId },
    messages: [{
      id: `reply-${chatId}`, chatId, branchId: `branch-${chatId}`, role: "assistant",
      content, variants: [], selectedVariantIndex: null,
    }],
  } as unknown as AppSnapshot;
}

let snapshots: Record<string, AppSnapshot>;
let generation: ReturnType<typeof deferred<Response>>;
let requested: ReturnType<typeof deferred<void>>;
let completion: ReturnType<typeof deferred<void>>;
let requests: string[];

beforeEach(() => {
  globalThis.fetch = originalFetch;
  snapshots = { [A]: snapshot(A, "Old reply A", true), [B]: snapshot(B, "Visible reply B") };
  generation = deferred<Response>();
  requested = deferred<void>();
  completion = deferred<void>();
  requests = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(url.indexOf("/api/"));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push(`${method} ${path}`);
    if (method === "GET" && path === `/api/chats/${A}`) return Response.json(snapshots[A]);
    if (method === "GET" && path === `/api/chats/${B}`) return Response.json(snapshots[B]);
    if (path === `/api/chats/${A}/insights/completion-refresh`) {
      completion.resolve();
      const { target } = JSON.parse(String(init?.body)) as { target: Record<string, unknown> };
      return Response.json({ target: { chatId: A, ...target }, patch: {} });
    }
    if (method === "POST" && path.startsWith(`/api/chats/${A}/`)) {
      requested.resolve();
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
        void generation.promise.then(resolve, reject);
      });
    }
    throw new Error(`Unexpected HTTP request: ${method} ${path}`);
  }, { preconnect: originalFetch.preconnect });
  useSnapshotStore.getState().clear();
  useSnapshotStore.getState().ingestSnapshot(snapshots[A]!);
  useChatStore.setState({ activeChatId: A, selectedCharacterId: `character-${A}`, generations: {}, draft: "Hello A", draftAttachments: [], messageActionId: null });
  useProviderDataStore.setState({ profiles: [{ id: "profile", isActive: true, defaultModel: "model" } as ProviderProfileRecord] });
  useProviderStore.setState({ connection: { ...originalConnection, streamResponse: true } });
  useGenerationQueueStore.setState({ jobsByChat: {}, recordsByChat: {}, batchesByChat: {} });
  useBootstrapStore.setState({ data: null });
});

afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => {
  globalThis.fetch = originalFetch;
  useProviderDataStore.setState(originalProviders);
  useProviderStore.setState({ connection: originalConnection });
});

function expectVisible(chatId: ChatId, content: string): void {
  const state = useSnapshotStore.getState();
  expect(useChatStore.getState().activeChatId).toBe(chatId);
  expect(useChatStore.getState().selectedCharacterId).toBe(`character-${chatId}`);
  expect(state.activeChat?.id).toBe(chatId);
  expect(state.character?.id).toBe(`character-${chatId}`);
  expect(state.character?.name).toBe(`Character ${chatId}`);
  expect(state.messageOrder).toEqual([`reply-${chatId}`]);
  expect(state.messagesById[`reply-${chatId}`]?.content).toBe(content);
}

type Controller = ReturnType<typeof useChatController>;
const lanes: Array<[string, (controller: Controller) => Promise<unknown>]> = [
  ["send", (controller) => controller.handleSend()],
  ["regenerate", (controller) => controller.handleRegenerateMessage(`reply-${A}`)],
  ["continue", (controller) => controller.handleContinueMessage(`reply-${A}`)],
  ["generate-reply", (controller) => controller.handleResend()],
  ["queue", (controller) => controller.runRegenerateJob(A, `reply-${A}`)],
];

for (const streaming of [true, false]) {
describe(`generation isolation (streaming=${streaming})`, () => {
  test.each(lanes)("%s finishes away from its chat without replacing the visible snapshot", async (_name, run) => {
    useProviderStore.setState({ connection: { ...originalConnection, streamResponse: streaming } });
    const { result } = renderHook(() => useChatController());
    let pending!: Promise<unknown>;
    await act(async () => { pending = run(result.current); await requested.promise; });
    expect(useChatStore.getState().generations[A]?.isSending).toBe(true);
    await act(async () => { await result.current.handleSwitchChat(B); });
    expect(useChatStore.getState().generations[A]?.isSending).toBe(true);
    expect(useChatStore.getState().generations[A]?.abortController?.signal.aborted).toBe(false);
    expectVisible(B, "Visible reply B");
    snapshots[A] = snapshot(A, "Finished reply A", true);

    await act(async () => {
      generation.resolve(streaming
        ? new Response('event: text-delta\ndata: {"delta":"A"}\n\nevent: finish\ndata: {"finishReason":"stop"}\n\n', { headers: { "Content-Type": "text/event-stream" } })
        : Response.json(snapshots[A]));
      await pending;
    });

    expectVisible(B, "Visible reply B");
    expect(useChatStore.getState().generations[A]?.isSending).toBe(false);
    if (_name === "send" || _name === "generate-reply") {
      expect(requests).toContain(`POST /api/chats/${A}/insights/completion-refresh`);
      await completion.promise;
    }
    await act(async () => { await result.current.handleSwitchChat(A); });
    expectVisible(A, "Finished reply A");
  });

  test("an abort after switching keeps the visible chat and loads the partial reply on return", async () => {
    useProviderStore.setState({ connection: { ...originalConnection, streamResponse: streaming } });
    const { result } = renderHook(() => useChatController());
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.handleSend(); await requested.promise; });
    if (streaming) {
      // Keep the real SSE reader parked mid-body, not just the HTTP headers.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: text-delta\ndata: {"delta":"A"}\n\n'));
        },
      });
      await act(async () => {
        generation.resolve(new Response(body));
        await waitFor(() => expect(useChatStore.getState().generations[A]?.generationStatus).toBe("streaming"));
      });
    }
    await act(async () => { await result.current.handleSwitchChat(B); });
    snapshots[A] = snapshot(A, "Partial reply A", true);

    await act(async () => { useChatStore.getState().abortGeneration(A); await pending; });

    expectVisible(B, "Visible reply B");
    expect(useChatStore.getState().generations[A]?.isSending).toBe(false);
    expect(requests).toContain(`GET /api/chats/${A}`);
    await act(async () => { await result.current.handleSwitchChat(A); });
    expectVisible(A, "Partial reply A");
  });

  test("failure recovery fetches the generating chat without replacing the visible one", async () => {
    useProviderStore.setState({ connection: { ...originalConnection, streamResponse: streaming } });
    const { result } = renderHook(() => useChatController());
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.handleSend(); await requested.promise; });
    await act(async () => { await result.current.handleSwitchChat(B); });
    snapshots[A] = snapshot(A, "Reply kept after provider failure", true);
    await act(async () => {
      generation.resolve(streaming
        ? new Response('event: user-message-saved\ndata: {}\n\nevent: error\ndata: {"message":"Provider disconnected","category":"network","partialSaved":true}\n\n')
        : Response.json({ error: { message: "Provider disconnected", userMessageSaved: true } }, { status: 502 }));
      await pending;
    });
    expect(requests).toContain(`GET /api/chats/${A}`);
    expectVisible(B, "Visible reply B");
    await act(async () => { await result.current.handleSwitchChat(A); });
    expectVisible(A, "Reply kept after provider failure");
  });

  test("a generation watched in its own chat still ingests its final snapshot", async () => {
    useProviderStore.setState({ connection: { ...originalConnection, streamResponse: streaming } });
    const { result } = renderHook(() => useChatController());
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.handleSend(); await requested.promise; });
    snapshots[A] = snapshot(A, "Finished reply A", true);
    await act(async () => {
      generation.resolve(streaming
        ? new Response('event: finish\ndata: {"finishReason":"stop"}\n\n')
        : Response.json(snapshots[A]));
      await pending;
    });
    expectVisible(A, "Finished reply A");
    expect(requests).toContain(`POST /api/chats/${A}/insights/completion-refresh`);
  });
});
}

test("a refresh checks the active chat after its HTTP response, not before it", async () => {
  const response = deferred<Response>();
  const fetched = deferred<void>();
  const transport = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith(`/api/chats/${A}`)) {
      fetched.resolve();
      return response.promise;
    }
    return transport(input, init);
  }, { preconnect: originalFetch.preconnect });
  const pending = refreshChatSnapshotCache(A);
  await fetched.promise;
  const { result } = renderHook(() => useChatController());
  await act(async () => { await result.current.handleSwitchChat(B); });
  response.resolve(Response.json(snapshot(A, "Late reply A")));
  await pending;

  expectVisible(B, "Visible reply B");
});
