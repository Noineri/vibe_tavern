import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentTransportTrace, AGENT_TRACE_HEADER } from "../src/shared/agent-transport-trace.js";
import type { ProviderFetch } from "../src/domain/providers/provider-fetch-factory.js";

// L1: derived paths; no global patches; awaited flush; portable joins;
// real filesystem + injected HTTP edge; stable final records; no DB/setup replay.
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "agent-transport-trace-"));
  roots.push(dir);
  return dir;
}
async function rows(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("agent transport forensic trace", () => {
  it("is absent when explicitly disabled", () => {
    expect(createAgentTransportTrace({ threadId: "thread", operation: "send" }, null)).toBeUndefined();
  });

  it("records full immutable snapshots in order without authorization headers or payload changes", async () => {
    const trace = createAgentTransportTrace({ threadId: "thread", operation: "send" }, await directory())!;
    const content = "a".repeat(5000) + "\u041f\u0440\u0438\u0432\u0435\u0442";
    const messages = [{ role: "user", content }];
    trace.record("assembled", { messages });
    messages[0]!.content = "mutated after capture";
    const body = JSON.stringify({ messages: [{ role: "user", content }] });
    let seenInit: RequestInit | undefined;
    const response = new Response("data: intact\n\n", { headers: { "x-agy-trace-id": "proxy-id" } });
    const edge: ProviderFetch = Object.assign(async (_input: Parameters<ProviderFetch>[0], init?: Parameters<ProviderFetch>[1]) => {
      seenInit = init;
      return response;
    }, { preconnect() {} });
    const result = await trace.wrapFetch(edge)("http://127.0.0.1:8090/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer never-log-me" }, body });
    expect(result).toBe(response);
    expect(await result.text()).toBe("data: intact\n\n");
    expect(seenInit?.body).toBe(body);
    expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer never-log-me");
    expect(new Headers(seenInit?.headers).get(AGENT_TRACE_HEADER)).toBe(`${trace.id}.1`);
    await trace.flush();
    const captured = await rows(trace.path);
    expect(captured.map((row) => row.seq)).toEqual(captured.map((_, index) => index));
    expect(captured.find((row) => row.event === "assembled").data.messages[0].content).toBe(content);
    expect(captured.find((row) => row.event === "http.request").data.body).toBe(body);
    expect(captured.find((row) => row.event === "http.response").data.proxyTraceId).toBe("proxy-id");
    expect(await readFile(trace.path, "utf8")).not.toContain("never-log-me");
  });

  it("distinguishes concurrent turns and repeated provider attempts", async () => {
    const dir = await directory();
    const a = createAgentTransportTrace({ threadId: "one", operation: "regenerate" }, dir)!;
    const b = createAgentTransportTrace({ threadId: "two", operation: "send" }, dir)!;
    const seen: Array<string | null> = [];
    const edge: ProviderFetch = Object.assign(async (_input: Parameters<ProviderFetch>[0], init?: Parameters<ProviderFetch>[1]) => {
      seen.push(new Headers(init?.headers).get(AGENT_TRACE_HEADER));
      return new Response("ok");
    }, { preconnect() {} });
    await Promise.all([a.wrapFetch(edge)("http://localhost:8090/v1/chat/completions"), b.wrapFetch(edge)("http://localhost:8090/v1/chat/completions")]);
    await a.wrapFetch(edge)("http://localhost:8090/v1/chat/completions");
    await Promise.all([a.flush(), b.flush()]);
    expect(new Set(seen).size).toBe(3);
    expect(a.path).not.toBe(b.path);
    expect((await rows(a.path)).filter((row) => row.event === "http.request")).toHaveLength(2);
    expect((await rows(b.path)).filter((row) => row.event === "http.request")).toHaveLength(1);
  });

  it("does not send diagnostic headers remotely or swallow provider failures", async () => {
    const trace = createAgentTransportTrace({ threadId: "thread", operation: "send" }, await directory())!;
    const error = new Error("provider stopped");
    const edge: ProviderFetch = Object.assign(async (_input: Parameters<ProviderFetch>[0], init?: Parameters<ProviderFetch>[1]) => {
      expect(new Headers(init?.headers).has(AGENT_TRACE_HEADER)).toBe(false);
      throw error;
    }, { preconnect() {} });
    await expect(trace.wrapFetch(edge)("https://example.invalid/v1/chat?key=not-for-log", { body: "payload", method: "POST" })).rejects.toBe(error);
    await trace.flush();
    const log = await readFile(trace.path, "utf8");
    expect(log).toContain("http.error");
    expect(log).not.toContain("not-for-log");
  });
});
