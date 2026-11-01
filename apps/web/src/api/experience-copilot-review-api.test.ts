/** BR-2c2: exercise the real RPC/auth seam at the fetch boundary. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { buildAgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import { getExperienceCopilotReview, putExperienceCopilotReview, deleteExperienceCopilotReview, isExperienceCopilotRunning } from "./experience-copilot-api.js";

const originalFetch = globalThis.fetch;
let requests: Array<{ method: string; path: string; body: unknown }> = [];
let response: unknown = null;
let status = 200;
beforeEach(() => {
  globalThis.fetch = originalFetch;
  requests = [];
  response = null;
  status = 200;
  globalThis.fetch = (async (input, init) => {
    requests.push({ method: init?.method ?? "GET", path: new URL(String(input), "http://gateway.test").pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; });

test("GET/PUT/DELETE use the shared per-thread review route and preserve the envelope", async () => {
  expect(await getExperienceCopilotReview("thread")).toBeNull();
  const envelope = buildAgentReviewEnvelope(null, [{ toolCallId: "r", toolName: "write_buffer", status: "done", target: "rules", proposed: "New" }], { rules: "Old", visual: "" })!;
  response = envelope;
  expect(await putExperienceCopilotReview("thread", envelope)).toEqual(envelope);
  response = { ok: true };
  expect(await deleteExperienceCopilotReview("thread")).toEqual({ ok: true });
  expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "DELETE"]);
  expect(requests.every((request) => request.path.endsWith("/api/experience-copilot/thread/review"))).toBe(true);
  expect(requests[1]!.body).toEqual(envelope);
});

test("run ownership is checked against the feature-registered active list", async () => {
  response = [{ threadId: "other" }];
  expect(await isExperienceCopilotRunning("thread")).toBe(false);
  response = [{ threadId: "thread" }];
  expect(await isExperienceCopilotRunning("thread")).toBe(true);
  expect(requests.every((request) => request.path.endsWith("/api/agent-runs"))).toBe(true);
});

test("RPC errors propagate rather than pretending a failed load is an absent review", async () => {
  status = 500;
  response = { error: { message: "Corrupt review" } };
  await expect(getExperienceCopilotReview("thread")).rejects.toThrow("Corrupt review");
  await expect(isExperienceCopilotRunning("thread")).rejects.toThrow("Corrupt review");
});
