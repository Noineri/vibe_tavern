/** BR-1b: real routes, adapter, SDK and SQLite; only the remote provider is a local server. */
import { afterEach, describe, expect, test } from "bun:test";
import { createStoreContainer } from "@vibe-tavern/db";
import { experienceCopilotRunActiveErrorSchema, experienceCopilotStopRunResponseSchema } from "@vibe-tavern/api-contracts";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";
import "../src/domain/agent/kinds/experience-kind.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Frame = { id: string; event: string; data: string };
function frames(text: string): Frame[] {
  return text.split("\n\n").filter((frame) => frame.includes("data:")).map((frame) => {
    const fields = Object.fromEntries(frame.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
    }));
    return { id: fields.id!, event: fields.event!, data: fields.data! };
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const lanes: ReturnType<typeof lane>[] = [];
  let providerCalls = 0;
  function lane() {
    const release = deferred<void>();
    const entered = deferred<void>();
    const completed = deferred<void>();
    const result = { release, entered, completed };
    lanes.push(result);
    return result;
  }
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      await request.text();
      const current = lanes[providerCalls++];
      if (!current) return new Response("No provider lane reserved", { status: 400 });
      current.entered.resolve();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "First" })));
          await current.release.promise;
          controller.enqueue(encoder.encode(chunk({ content: " last" }) + chunk({}, "stop") + "data: [DONE]\n\n"));
          controller.close();
          current.completed.resolve();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanups.push(async () => {
    for (const current of lanes) current.release.resolve();
    await server.stop(true);
  });
  const stores = await createStoreContainer(":memory:");
  await stores.uiSettings.ensureDefaults();
  const profile = await stores.providers.create({
    name: "Background route provider", providerPreset: "openai_compat", endpoint: `http://127.0.0.1:${server.port}/v1`,
    defaultModel: "model", proxyMode: "direct",
  });
  const adapter = new ExperienceCopilotAdapter(stores);
  const app = createExperienceCopilotRoutes(adapter);
  const thread = await stores.experienceCopilot.startNewSession("script-background", "Background", false);
  const path = `/api/experience-copilot/${thread.id}`;
  function send(signal?: AbortSignal, content = "Hello", providerProfileId = profile.id) {
    return app.request(`${path}/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, providerProfileId }), signal,
    });
  }
  async function replay(after?: number) {
    return app.request(`${path}/run${after === undefined ? "" : `?after=${after}`}`);
  }
  async function stored() {
    return (await stores.experienceCopilot.listMessages(thread.id)).map(({ role, content, toolCallsJson, toolCallId, reasoning }) =>
      ({ role, content, toolCallsJson, toolCallId, reasoning }));
  }
  async function waitForSavedReply(content: string) {
    // Observe the terminal DB state BEFORE reconnecting: a replay must not be
    // what makes the generator advance/persist. Yield I/O, never a fixed sleep.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if ((await stored()).some((message) => message.role === "assistant" && message.content === content)) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Detached turn did not persist '${content}' without a subscriber`);
  }
  return { adapter, app, stores, thread, profile, path, lane, send, replay, stored, waitForSavedReply, providerCalls: () => providerCalls };
}

/** Read through a real delta before disconnecting, without a sleep/timing guess. */
async function firstDelta(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("Stream ended before the first delta");
    text += decoder.decode(next.value, { stream: true });
  }
  expect(frames(text)).toEqual([{ id: "1", event: "text-delta", data: '{"delta":"First"}' }]);
  return reader;
}

describe("server-owned copilot routes", () => {
  test("a cancelled response still finishes and persists the same turn as a watched run", async () => {
    const watched = await setup();
    const watchedLane = watched.lane();
    const watchedResponse = await watched.send();
    const watchedText = watchedResponse.text();
    await watchedLane.entered.promise;
    watchedLane.release.resolve();
    const watchedEvents = frames(await watchedText);
    expect(watchedEvents.map(({ id, event }) => ({ id, event }))).toEqual([
      { id: "1", event: "text-delta" }, { id: "2", event: "text-delta" }, { id: "3", event: "finish" },
    ]);

    const detached = await setup();
    const detachedLane = detached.lane();
    const reader = await firstDelta(await detached.send());
    await reader.cancel();
    expect(detached.adapter.agentRuns.active()).toHaveLength(1);
    detachedLane.release.resolve();
    await detachedLane.completed.promise;
    await detached.waitForSavedReply("First last");
    const replayed = frames(await (await detached.replay()).text());
    expect(replayed.map(({ id, event }) => ({ id, event }))).toEqual(watchedEvents.map(({ id, event }) => ({ id, event })));
    expect(replayed.slice(0, 2)).toEqual(watchedEvents.slice(0, 2));
    expect(await detached.stored()).toEqual(await watched.stored());
    expect((await detached.stored()).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Hello" }, { role: "assistant", content: "First last" },
    ]);
    expect(detached.adapter.agentRuns.active()).toEqual([]);
  });

  test("request abort detaches a silent writer without aborting the provider turn", async () => {
    const h = await setup();
    const current = h.lane();
    const client = new AbortController();
    const response = await h.send(client.signal);
    const reader = await firstDelta(response);
    client.abort();
    expect(await reader.read()).toMatchObject({ done: true });
    expect(h.adapter.agentRuns.active()).toHaveLength(1);
    current.release.resolve();
    const replayed = frames(await (await h.replay(1)).text());
    expect(replayed.map(({ id, event }) => ({ id, event }))).toEqual([
      { id: "2", event: "text-delta" }, { id: "3", event: "finish" },
    ]);
    expect((await h.stored()).at(-1)?.content).toBe("First last");
  });

  test("resume tails live events; cancelling one resumed client leaves the others attached", async () => {
    const h = await setup();
    const current = h.lane();
    await (await firstDelta(await h.send())).cancel();
    const resumed = await h.replay(1);
    const cancelled = await h.replay(1);
    await cancelled.body!.cancel();
    const tail = resumed.text();
    current.release.resolve();
    const events = frames(await tail);
    expect(events.map(({ id }) => id)).toEqual(["2", "3"]);
    expect(events.map(({ event }) => event)).toEqual(["text-delta", "finish"]);
    expect(await (await h.replay(3)).text()).toBe("");
  });

  test("stop aborts a detached turn, persists its partial reply and permits the next run after exhaustion", async () => {
    const h = await setup();
    h.lane();
    await (await firstDelta(await h.send())).cancel();
    const stopped = await h.app.request(`${h.path}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(experienceCopilotStopRunResponseSchema.parse(await stopped.json())).toEqual({ stopped: true });
    const events = frames(await (await h.replay(1)).text());
    expect(events).toEqual([{ id: "2", event: "abort", data: '{"partialLength":5}' }]);
    expect((await h.stored()).at(-1)?.content).toBe("First");
    expect(await (await h.app.request(`${h.path}/stop`, { method: "POST" })).json()).toEqual({ stopped: false });
    const next = h.lane();
    const response = await h.send(undefined, "Again");
    const reader = await firstDelta(response);
    await reader.cancel();
    next.release.resolve();
    expect(frames(await (await h.replay()).text()).at(-1)?.event).toBe("finish");
    expect(h.providerCalls()).toBe(2);
  });

  test("concurrent sends return JSON 409 before SSE and never persist a second input", async () => {
    const h = await setup();
    const current = h.lane();
    await (await firstDelta(await h.send())).cancel();
    const conflicts = await Promise.all([h.send(undefined, "Duplicate A"), h.send(undefined, "Duplicate B")]);
    for (const response of conflicts) {
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(experienceCopilotRunActiveErrorSchema.parse(await response.json()).code).toBe("AGENT_RUN_ACTIVE");
    }
    expect(h.providerCalls()).toBe(1);
    current.release.resolve();
    await (await h.replay()).text();
    expect((await h.stored()).filter(({ role }) => role === "user").map(({ content }) => content)).toEqual(["Hello"]);
  });

  test("no retained run is 204, absent stops are quiet, and malformed cursors are HTTP 400", async () => {
    const h = await setup();
    expect((await h.replay()).status).toBe(204);
    expect((await h.app.request("/api/experience-copilot/missing/run")).status).toBe(204);
    expect(await (await h.app.request(`${h.path}/stop`, { method: "POST" })).json()).toEqual({ stopped: false });
    for (const after of ["", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e2", " "]) {
      const response = await h.app.request(`${h.path}/run?after=${encodeURIComponent(after)}`);
      expect(response.status).toBe(400);
    }
    expect((await h.app.request(`${h.path}/run?after=0`)).status).toBe(204);
  });

  test("an unwatched pre-provider failure is numbered and retained for replay", async () => {
    const h = await setup();
    const response = await h.send(undefined, "Hello", "missing-provider");
    await response.body!.cancel();
    const replayed = frames(await (await h.replay()).text());
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ id: "1", event: "error" });
    expect(JSON.parse(replayed[0]!.data).message).toContain("missing-provider");
    expect(frames(await (await h.replay()).text())).toEqual(replayed);
    expect(h.providerCalls()).toBe(0);
    expect(h.adapter.agentRuns.active()).toEqual([]);
  });

  test("different threads run concurrently with real owner metadata; a new server adapter has no replay", async () => {
    const h = await setup();
    const first = h.lane();
    await (await firstDelta(await h.send())).cancel();
    const other = await h.stores.experienceCopilot.startNewSession("other-script", "Other", false);
    const second = h.lane();
    const response = await h.app.request(`/api/experience-copilot/${other.id}/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Hello", providerProfileId: h.profile.id }),
    });
    await (await firstDelta(response)).cancel();
    expect(h.adapter.agentRuns.active().map(({ threadId, owner }) => ({ threadId, owner }))).toEqual([
      { threadId: h.thread.id, owner: { kind: "script", scriptId: "script-background" } },
      { threadId: other.id, owner: { kind: "script", scriptId: "other-script" } },
    ]);
    expect(h.adapter.agentRuns.active().every(({ startedAt }) => Number.isSafeInteger(startedAt))).toBe(true);
    second.release.resolve();
    await (await h.app.request(`/api/experience-copilot/${other.id}/run`)).text();
    expect(h.adapter.agentRuns.active().map(({ threadId }) => threadId)).toEqual([h.thread.id]);
    first.release.resolve();
    await h.waitForSavedReply("First last");
    await (await h.replay()).text();
    const restarted = createExperienceCopilotRoutes(new ExperienceCopilotAdapter(h.stores));
    expect((await restarted.request(`${h.path}/run`)).status).toBe(204);
    expect((await h.stores.experienceCopilot.listMessages(h.thread.id)).at(-1)?.content).toBe("First last");
  });
});
