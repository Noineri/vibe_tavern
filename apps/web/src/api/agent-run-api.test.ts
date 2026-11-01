import { afterAll, beforeEach, expect, test } from "bun:test";
import { isAgentThreadRunning, subscribeAgentThreadRun, stopAgentThreadRun } from "./agent-run-api.js";
import { streamExperienceCopilot } from "./experience-copilot-api.js";
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

test("active discovery is thread-scoped and validates the response", async () => {
  response = () => Response.json([{ threadId: "other" }, { threadId: "active" }]);
  expect(await isAgentThreadRunning("active")).toBe(true);
  expect(await isAgentThreadRunning("absent")).toBe(false);
  response = () => Response.json({ invalid: true });
  await expect(isAgentThreadRunning("active")).rejects.toThrow("Invalid agent run list");
});

test("GET replay carries its cursor, suppresses duplicate ids and dispatches through the real parser", async () => {
  const event = (id: number, name: string, data: unknown) => `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  response = () => new Response([
    event(2, "text-delta", { delta: "Already seen" }),
    event(3, "text-delta", { delta: "Replayed" }), event(3, "text-delta", { delta: "Duplicate" }),
    event(4, "tool-result", { toolCallId: "code", toolName: "write_buffer", output: { target: "code", proposed: "", summary: "Cleared" } }),
    event(5, "finish", { finishReason: "stop", metrics: { total: 1 } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
  const text: string[] = [];
  const tools: unknown[] = [];
  const result = await subscribeAgentThreadRun("thread", 2, { onStatus: () => {}, onChunk: (delta) => text.push(delta), onToolResult: (info) => tools.push(info) });
  expect(requests[0]!.url.pathname).toBe("/api/experience-copilot/thread/run");
  expect(requests[0]!.url.searchParams.get("after")).toBe("2");
  expect(requests[0]!.init?.method).toBe("GET");
  expect(requests[0]!.init?.body).toBeUndefined();
  expect(text).toEqual(["Replayed"]);
  expect(tools).toEqual([{ toolCallId: "code", toolName: "write_buffer", output: { target: "code", proposed: "", summary: "Cleared" }, isError: false }]);
  expect(result.metrics).toEqual({ total: 1 });
});

test("only the explicit stop operation POSTs /stop", async () => {
  response = () => Response.json({ stopped: true });
  expect(await stopAgentThreadRun("thread")).toEqual({ stopped: true });
  expect(requests.map(({ url, init }) => [url.pathname, init?.method])).toEqual([["/api/experience-copilot/thread/stop", "POST"]]);
});

test("409 active-run refusal retains its typed code at the shared stream boundary", async () => {
  response = () => Response.json({ error: { code: "AGENT_RUN_ACTIVE", message: "Already running" } }, { status: 409 });
  let failure: unknown;
  try { await streamExperienceCopilot("thread", { content: "Send", providerProfileId: "provider" }, { onStatus: () => {}, onChunk: () => {} }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ProviderStreamError);
  expect((failure as ProviderStreamError).code).toBe("AGENT_RUN_ACTIVE");
});
