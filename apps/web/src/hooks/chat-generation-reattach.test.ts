/** Real app attachment/controller/HTTP/parser/stores; only fetch is doubled. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import type { ChatGenerationOperation } from "@vibe-tavern/api-contracts";
import type { AppSnapshot, ProviderProfileRecord } from "../api/types.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { useChatController } = await import("./use-chat-controller.js");
const { useChatGenerationAttachment } = await import("./use-chat-generation-attachment.js");
const { useChatStore } = await import("../stores/chat-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useCoauthorTurnStore } = await import("../stores/coauthor-turn-store.js");
const { useProviderStore } = await import("../stores/provider-store.js");
const { useProviderDataStore } = await import("../stores/provider-data-store.js");
const { useGenerationQueueStore } = await import("../stores/generation-queue-store.js");
const { cancelQueueJob } = await import("./use-generation-queue.js");

const originalFetch = globalThis.fetch;
const stores = [useChatStore, useSnapshotStore, useCoauthorTurnStore, useProviderStore, useProviderDataStore, useGenerationQueueStore] as const;
// Each store's own closure preserves its type; no process-global reset leaks.
const restores = stores.map((store) => {
  const state = store.getState();
  return () => { Reflect.apply(store.setState, store, [state, true]); };
});
beforeEach(() => { globalThis.fetch = originalFetch; restores.forEach((restore) => restore()); });
afterAll(() => { globalThis.fetch = originalFetch; restores.forEach((restore) => restore()); });

const A = brandId<ChatId>("reattach-a"), B = brandId<ChatId>("reattach-b");
function snapshot(chatId: ChatId, mode: "rp" | "coauthor", content?: string): AppSnapshot {
  return { activeChat: { id: chatId, characterId: "character", mode, insightsConfig: { objectiveEnabled: false, trackerEnabled: false } },
    character: { id: "character", name: "Character" }, activeBranch: { id: `branch-${chatId}`, chatId },
    messages: [{ id: "user", chatId, branchId: `branch-${chatId}`, role: "user", content: "Committed request", variants: [] },
      ...(content ? [{ id: "assistant", chatId, branchId: `branch-${chatId}`, role: "assistant", content, variants: [], selectedVariantIndex: null }] : [])],
  } as unknown as AppSnapshot;
}
const frame = (id: number, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function fixture(mode: "rp" | "coauthor", operation: ChatGenerationOperation, run: (h: ReturnType<typeof setup>) => Promise<void>) {
  const h = setup(mode, operation);
  try { await run(h); }
  finally { await act(async () => { h.unmount?.(); h.closeAll(); await Promise.resolve(); }); }
}
function setup(mode: "rp" | "coauthor", operation: ChatGenerationOperation) {
  let active = true, refused = false;
  let current = snapshot(A, mode, operation.messageId ? "Old assistant" : undefined);
  const requests: string[] = [];
  const readers: Array<{ writer: ReadableStreamDefaultController<Uint8Array>; closed: boolean; seq: number }> = [];
  const encoder = new TextEncoder();
  let snapshotOverride: (() => Promise<Response>) | undefined;
  const context = { ...operation, runId: "run-a", chatId: A, branchId: `branch-${A}` };
  const send = (reader: typeof readers[number], event: string, data: unknown) => {
    if (!reader.closed) reader.writer.enqueue(encoder.encode(frame(++reader.seq, event, data)));
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://gateway.test");
    const path = url.pathname.slice(url.pathname.indexOf("/api/")), method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (path === "/api/agent-runs") return Response.json(active ? [{ threadId: `chat:${A}` }] : []);
    if (path === `/api/chats/${A}/generation/stop`) return Response.json({ stopped: true });
    if (path === `/api/chats/${A}/generation`) return new Response(new ReadableStream<Uint8Array>({
      start(writer) {
        const reader = { writer, closed: false, seq: 0 };
        readers.push(reader);
        send(reader, "generation-context", context);
        if (operation.operation === "send") send(reader, "user-message-saved", { messageId: "user" });
        send(reader, "generation-metadata", { modelId: "resolved", presetName: "Preset" });
        send(reader, "reasoning-delta", { delta: "Thinking" });
        send(reader, "text-delta", { delta: "Partial reply" });
      },
      cancel() { const reader = readers.at(-1); if (reader) reader.closed = true; },
    }));
    if (path === `/api/chats/${A}`) return snapshotOverride ? snapshotOverride() : Response.json(current);
    if (path === `/api/chats/${B}`) return Response.json(snapshot(B, "rp", "Other chat"));
    if (method === "POST" && refused) return Response.json({ code: "AGENT_RUN_ACTIVE", error: "Already running" }, { status: 409 });
    throw new Error(`Unexpected request ${method} ${path}`);
  }) as typeof fetch;
  useSnapshotStore.getState().clear();
  useSnapshotStore.getState().ingestSnapshot(current);
  useChatStore.setState({ activeChatId: A, generations: {}, draft: "Keep my draft", draftAttachments: [], messageActionId: null });
  useProviderDataStore.setState({ profiles: [{ id: "provider", isActive: true, defaultModel: "model" } as ProviderProfileRecord] });
  useProviderStore.setState((s) => ({ connection: { ...s.connection, streamResponse: true } }));
  useGenerationQueueStore.setState({ jobsByChat: {}, recordsByChat: {}, batchesByChat: {} });
  const h = {
    requests, readers, context, unmount: undefined as (() => void) | undefined,
    mount() {
      const hook = renderHook(() => { const chat = useChatController(); useChatGenerationAttachment(chat.reattachGeneration); return chat; });
      h.unmount = hook.unmount;
      return hook;
    },
    setActive(value: boolean) { active = value; },
    refuse() { refused = true; },
    delaySnapshot(fn: () => Promise<Response>) { snapshotOverride = fn; },
    finish(cancelled = false) {
      active = false; current = snapshot(A, mode, cancelled ? "Partial reply" : "Final reply");
      for (const reader of readers) if (!reader.closed) {
        send(reader, cancelled ? "abort" : "finish", cancelled ? { partialLength: 13 } : { finishReason: "stop" });
        reader.writer.close(); reader.closed = true;
      }
    },
    closeAll() { for (const reader of readers) if (!reader.closed) { reader.writer.close(); reader.closed = true; } },
  };
  return h;
}

for (const mode of ["rp", "coauthor"] as const) for (const operation of [
  { operation: "send", messageId: null }, { operation: "generate", messageId: null },
  { operation: "regenerate", messageId: "assistant" }, { operation: "continue", messageId: "assistant" },
] satisfies ChatGenerationOperation[]) {
  test(`${mode} ${operation.operation}: reload reattaches to the exact target and final message without consuming the draft`, async () => {
    await fixture(mode, operation, async (h) => {
      h.mount();
      await waitFor(() => expect(useChatStore.getState().generations[A]?.streamingReasoningText).toBe("Thinking"));
      expect(useChatStore.getState().generations[A]).toMatchObject({ isSending: true, context: h.context, streamingMessageId: operation.messageId, pendingUserMessageContent: null, modelId: "resolved" });
      expect(useChatStore.getState().draft).toBe("Keep my draft");
      expect(h.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
      await act(async () => { h.finish(); });
      await waitFor(() => expect(useChatStore.getState().generations[A]?.isSending).toBe(false));
      expect(useSnapshotStore.getState().messagesById.assistant?.content).toBe("Final reply");
      expect(useSnapshotStore.getState().messageOrder.filter((id) => id === "user")).toHaveLength(1);
    });
  });
}

for (const mode of ["rp", "coauthor"] as const) {
  test(`${mode}: switch away detaches GET without Stop; returning replays once with no doubled text`, async () => {
    await fixture(mode, { operation: "send", messageId: null }, async (h) => {
      const hook = h.mount();
      await waitFor(() => expect(h.readers).toHaveLength(1));
      await act(async () => { await hook.result.current.handleSwitchChat(B); });
      expect(h.requests.filter((request) => request.endsWith("/stop"))).toEqual([]);
      expect(useSnapshotStore.getState().activeChat?.id).toBe(B);
      await act(async () => { await hook.result.current.handleSwitchChat(A); });
      await waitFor(() => expect(h.readers).toHaveLength(2));
      await waitFor(() => expect(useChatStore.getState().generations[A]?.streamingRevealedText).toBe("Partial reply"));
      await act(async () => { h.finish(); });
      await waitFor(() => expect(useChatStore.getState().generations[A]?.isSending).toBe(false));
    });
  });

  test(`${mode}: Stop after reattach POSTs once and keeps busy until partial persistence`, async () => {
    await fixture(mode, { operation: "regenerate", messageId: "assistant" }, async (h) => {
      const hook = h.mount();
      await waitFor(() => expect(useChatStore.getState().generations[A]?.context).toEqual(h.context));
      await act(async () => { hook.result.current.handleCancelGeneration(); hook.result.current.handleCancelGeneration(); });
      expect(h.requests.filter((request) => request.endsWith("/stop"))).toHaveLength(1);
      expect(useChatStore.getState().generations[A]?.isSending).toBe(true);
      expect(useChatStore.getState().generations[A]?.abortController?.signal.aborted).toBe(false);
      await act(async () => { h.finish(true); });
      await waitFor(() => expect(useChatStore.getState().generations[A]?.isSending).toBe(false));
      expect(useSnapshotStore.getState().messagesById.assistant?.content).toBe("Partial reply");
    });
  });
}

test("HTTP 409 follows the winning run, restores only the refused draft and never repeats POST", async () => {
  await fixture("rp", { operation: "regenerate", messageId: "assistant" }, async (h) => {
    h.refuse();
    // Exercise the action without the app's discovery effect (the send/409 race).
    const hook = renderHook(() => useChatController()); h.unmount = hook.unmount;
    let pending!: Promise<void>;
    await act(async () => { pending = hook.result.current.handleSend(); });
    await waitFor(() => expect(h.readers).toHaveLength(1));
    expect(useChatStore.getState().draft).toBe("Keep my draft");
    expect(useChatStore.getState().generations[A]?.streamingMessageId).toBe("assistant");
    await act(async () => { h.finish(); await pending; });
    expect(h.requests.filter((request) => request === `POST /api/chats/${A}/messages/stream`)).toHaveLength(1);
  });
});

test("a running queue job uses the same explicit server Stop rather than aborting the reader", async () => {
  await fixture("rp", { operation: "regenerate", messageId: "assistant" }, async (h) => {
    h.mount();
    await waitFor(() => expect(useChatStore.getState().generations[A]?.context).toEqual(h.context));
    useGenerationQueueStore.getState().enqueueJob({ chatId: A, messageId: "assistant", model: "model", promptPresetId: null });
    const job = useGenerationQueueStore.getState().jobsByChat[A]![0]!;
    useGenerationQueueStore.getState().markRunning(job.id);
    await act(async () => { cancelQueueJob(job.id); });
    expect(h.requests).toContain(`POST /api/chats/${A}/generation/stop`);
    expect(useChatStore.getState().generations[A]?.isSending).toBe(true);
    await act(async () => { h.finish(true); });
    await waitFor(() => expect(useChatStore.getState().generations[A]?.isSending).toBe(false));
  });
});

test("idle discovery neither erases the draft nor attaches a retained completed stream", async () => {
  await fixture("rp", { operation: "generate", messageId: null }, async (h) => {
    h.setActive(false); h.mount();
    await waitFor(() => expect(h.requests).toContain("GET /api/agent-runs"));
    expect(h.readers).toHaveLength(0);
    expect(useChatStore.getState().draft).toBe("Keep my draft");
    expect(useChatStore.getState().generations[A]?.isSending ?? false).toBe(false);
  });
});

test("completion between navigation and discovery refetches the final snapshot without replaying it", async () => {
  await fixture("rp", { operation: "generate", messageId: null }, async (h) => {
    h.finish(); h.mount();
    await waitFor(() => expect(useSnapshotStore.getState().messagesById.assistant?.content).toBe("Final reply"));
    expect(h.readers).toHaveLength(0);
    expect(useChatStore.getState().draft).toBe("Keep my draft");
  });
});

test("existing local reader and repeated controller consumers do not create another GET", async () => {
  await fixture("rp", { operation: "generate", messageId: null }, async (h) => {
    useChatStore.getState().startGeneration(A);
    const hook = renderHook(() => {
      const chat = useChatController(); useChatController(); useChatController();
      useChatGenerationAttachment(chat.reattachGeneration);
      return chat;
    }); h.unmount = hook.unmount;
    expect(h.readers).toHaveLength(0);
    expect(h.requests).toEqual([]);
  });
});

test("a slow saved-user snapshot from a detached subscription cannot repaint a reopened chat", async () => {
  await fixture("rp", { operation: "send", messageId: null }, async (h) => {
    const slow = deferred<Response>(), requested = deferred<void>();
    let first = true;
    h.delaySnapshot(() => {
      if (first) { first = false; requested.resolve(); return slow.promise; }
      return Promise.resolve(Response.json(snapshot(A, "rp", "Reopened")));
    });
    const hook = h.mount();
    await requested.promise;
    await act(async () => { useChatStore.getState().setActiveChatId(B); });
    await act(async () => {
      useSnapshotStore.getState().ingestSnapshot(snapshot(A, "rp", "Reopened"));
      useChatStore.getState().setActiveChatId(A);
    });
    try {
      slow.resolve(Response.json(snapshot(A, "rp", "Stale")));
      await act(async () => { await Promise.resolve(); });
      expect(useSnapshotStore.getState().messagesById.assistant?.content).not.toBe("Stale");
    } finally { hook.unmount(); }
  });
});
