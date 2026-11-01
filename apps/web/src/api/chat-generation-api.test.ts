import { afterAll, beforeEach, expect, test } from "bun:test";
import { isChatGenerationRunning, subscribeChatGeneration, stopChatGeneration } from "./chat-generation-api.js";
import { streamChatEndpoint } from "./stream.js";
import { ProviderStreamError } from "./provider-stream-error.js";

const originalFetch = globalThis.fetch;
let requests: Array<{ url: URL; init?: RequestInit }>;
let response: () => Response;
beforeEach(() => {
  globalThis.fetch = originalFetch;
  requests = [];
  response = () => Response.json([]);
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: new URL(String(input), "http://gateway.test"), init });
    return response();
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; });

const frame = (id: number, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const context = { runId: "run", chatId: "chat", branchId: "original", operation: "regenerate", messageId: "assistant" };

test("discovery uses the shared registry's chat namespace, not a colliding agent id", async () => {
  response = () => Response.json([{ threadId: "chat" }, { threadId: "chat:running" }]);
  expect(await isChatGenerationRunning("chat")).toBe(false);
  expect(await isChatGenerationRunning("running")).toBe(true);
});

test("replay dispatches typed context and saved-user identity through the real parser without a new send", async () => {
  response = () => new Response([frame(1, "generation-context", context), frame(2, "user-message-saved", { messageId: "user" }),
    frame(3, "text-delta", { delta: "Reply" }), frame(3, "text-delta", { delta: "Duplicate" }), frame(4, "finish", { finishReason: "stop" })].join(""));
  const contexts: unknown[] = [], users: unknown[] = [], text: string[] = [];
  await subscribeChatGeneration("chat", 0, { onStatus: () => {}, onChunk: (delta) => text.push(delta),
    onGenerationContext: (value) => contexts.push(value), onUserMessageSaved: (value) => users.push(value) });
  expect(contexts).toEqual([context]); expect(users).toEqual([{ messageId: "user" }]); expect(text).toEqual(["Reply"]);
  expect(requests.map(({ url, init }) => [url.pathname, url.searchParams.get("after"), init?.method, init?.body]))
    .toEqual([["/api/chats/chat/generation", "0", "GET", undefined]]);
});

test("resume skips projected frames and validates cursors; 204 settles as no retained run", async () => {
  response = () => new Response(frame(2, "text-delta", { delta: "old" }) + frame(3, "text-delta", { delta: "new" }));
  const text: string[] = [];
  await subscribeChatGeneration("chat", 2, { onStatus: () => {}, onChunk: (delta) => text.push(delta) });
  expect(text).toEqual(["new"]);
  expect(requests[0]!.url.searchParams.get("after")).toBe("2");
  for (const after of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => subscribeChatGeneration("chat", after, { onStatus: () => {}, onChunk: () => {} })).toThrow();
  response = () => new Response(null, { status: 204 });
  expect((await subscribeChatGeneration("chat", 0, { onStatus: () => {}, onChunk: () => {} })).finishReason).toBe("not-running");
});

test("Stop keeps observing until EOF instead of treating the immediate ack or abort frame as finalization", async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  response = () => new Response(new ReadableStream({ start(controller) { writer = controller; } }));
  let abortFrame!: () => void;
  const observedAbort = new Promise<void>((resolve) => { abortFrame = resolve; });
  let settled = false;
  let closed = false;
  const watching = subscribeChatGeneration("chat", 0, { onChunk: () => {}, onStatus: (status) => { if (status === "cancelled") abortFrame(); } }).then((value) => { settled = true; return value; });
  try {
    response = () => Response.json({ stopped: true });
    expect(await stopChatGeneration("chat")).toEqual({ stopped: true });
    writer.enqueue(encoder.encode(frame(1, "abort", { partialLength: 4 })));
    await observedAbort;
    expect(settled).toBe(false);
    writer.close();
    closed = true;
    expect((await watching).finishReason).toBe("cancelled");
    expect(requests[1]!.url.pathname).toBe("/api/chats/chat/generation/stop");
  } finally { if (!closed) writer.close(); await watching; }
});

test("the actual top-level active-run refusal code survives the shared POST transport", async () => {
  response = () => Response.json({ error: "Already running", code: "AGENT_RUN_ACTIVE" }, { status: 409 });
  const pending = streamChatEndpoint("/api/chats/chat/messages/stream", {}, { onStatus: () => {}, onChunk: () => {} });
  await expect(pending).rejects.toBeInstanceOf(ProviderStreamError);
  await expect(pending).rejects.toMatchObject({ code: "AGENT_RUN_ACTIVE" });
});
