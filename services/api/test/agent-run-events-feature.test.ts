/** BR-1c: real registry/bus/SSE, with parked turn generators at the existing registry seam. */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createStoreContainer } from "@vibe-tavern/db";
import { EventBus, type AgentRunNotification, type AgentRunOwner } from "@vibe-tavern/domain";
import { AgentRunRegistry } from "../src/domain/agent/agent-run-registry.js";
import { createAgentRunEventsFeature } from "../src/domain/agent/agent-run-events-feature.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";
import "../src/domain/agent/kinds/sidechat-ooc-kind.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const OWNER: AgentRunOwner = { kind: "script", scriptId: "script" };
const LABEL = { kind: "experience", title: "Counter mini-app" };
const FINISH = { event: "finish", data: '{"finishReason":"stop"}' };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(registry = new AgentRunRegistry<AgentRunOwner>()) {
  const events = new EventBus();
  const app = new Hono();
  const feature = createAgentRunEventsFeature({ registry });
  feature.activate({ events, router: app });
  cleanups.push(() => feature.deactivate());
  return { app, events, feature, registry };
}

async function connect(app: Hono, signal?: AbortSignal) {
  const response = await app.request("/api/agent-runs/events", { signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  cleanups.push(() => reader.cancel());
  const decoder = new TextDecoder();
  let buffer = "";
  async function next() {
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before the expected event");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.indexOf("\n\n");
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return {
      event: frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim(),
      data: JSON.parse(frame.split("\n").find((line) => line.startsWith("data:"))!.slice(5)),
    };
  }
  expect(await next()).toEqual({ event: "ready", data: {} });
  return { reader, next };
}

describe("agent run events feature", () => {
  test("all five registry lifecycle states reach the connected client in order", async () => {
    const h = setup();
    const client = await connect(h.app);
    const cases = [
      { state: "finished", events: [FINISH] },
      { state: "asking", events: [{ event: "tool-result", data: JSON.stringify({ toolName: "ask_user", output: { status: "awaiting_answer", question: "Which?" } }) }, FINISH] },
      { state: "failed", events: [{ event: "error", data: '{"message":"Provider failed"}' }] },
      { state: "stopped", events: [{ event: "abort", data: '{"partialLength":0}' }] },
    ];
    for (const { state, events } of cases) {
      await h.registry.start("thread", OWNER, async function* () { yield* events; }, LABEL).done;
      expect(await client.next()).toEqual({ event: "agent.run", data: { threadId: "thread", owner: OWNER, ...LABEL, state: "started" } });
      expect(await client.next()).toEqual({ event: "agent.run", data: { threadId: "thread", owner: OWNER, ...LABEL, state } });
    }
  });

  test("GET lists the running descriptor and removes it only after persistence finishes", async () => {
    const h = setup();
    const persist = deferred<void>();
    cleanups.push(() => persist.resolve());
    const client = await connect(h.app);
    const run = h.registry.start("thread", OWNER, async function* () { yield FINISH; await persist.promise; }, LABEL);
    expect((await client.next()).data.state).toBe("started");
    const running = await h.app.request("/api/agent-runs");
    expect(await running.json()).toEqual([{ threadId: "thread", owner: OWNER, startedAt: run.startedAt, ...LABEL }]);
    persist.resolve();
    await run.done;
    expect((await client.next()).data.state).toBe("finished");
    expect(await (await h.app.request("/api/agent-runs")).json()).toEqual([]);
  });

  test("response cancellation and request abort remove only their own bus subscriptions", async () => {
    const h = setup();
    const a = await connect(h.app);
    const signal = new AbortController();
    const b = await connect(h.app, signal.signal);
    expect(h.events.listenerCount("agent.run")).toBe(2);
    await a.reader.cancel();
    expect(h.events.listenerCount("agent.run")).toBe(1);
    signal.abort();
    expect(await b.reader.read()).toMatchObject({ done: true });
    expect(h.events.listenerCount("agent.run")).toBe(0);
  });

  test("feature deactivation closes clients and stops forwarding, but never stops a turn", async () => {
    const h = setup();
    const notifications: AgentRunNotification[] = [];
    const off = h.events.on("agent.run", (event) => { notifications.push(event); });
    cleanups.push(off);
    const release = deferred<void>();
    cleanups.push(() => release.resolve());
    const client = await connect(h.app);
    const run = h.registry.start("thread", OWNER, async function* (signal) { await release.promise; expect(signal.aborted).toBe(false); yield FINISH; }, LABEL);
    expect((await client.next()).data.state).toBe("started");
    h.feature.deactivate();
    expect(await client.reader.read()).toMatchObject({ done: true });
    // The test's own independent observer remains; only the SSE listener leaves.
    expect(h.events.listenerCount("agent.run")).toBe(1);
    expect(h.registry.active()).toHaveLength(1);
    release.resolve();
    await run.done;
    expect(h.registry.active()).toEqual([]);
    expect(notifications.map(({ state }) => state)).toEqual(["started"]);
  });

  test("a real stop publishes stopped only after abort-event persistence, not at the stop request", async () => {
    const h = setup();
    const client = await connect(h.app);
    const entered = deferred<void>();
    const persist = deferred<void>();
    cleanups.push(() => persist.resolve());
    let persisted = false;
    const run = h.registry.start("thread", OWNER, async function* (signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        entered.resolve();
      });
      yield { event: "abort", data: '{"partialLength":0}' };
      await persist.promise;
      persisted = true;
    }, LABEL);
    await entered.promise;
    expect((await client.next()).data.state).toBe("started");
    expect(h.registry.stop("thread")).toBe(true);
    const turn = h.registry.subscribe("thread")!;
    expect((await turn.next()).value?.event).toBe("abort");
    expect(h.registry.active()).toHaveLength(1);
    expect(persisted).toBe(false);
    persist.resolve();
    await run.done;
    expect((await client.next()).data.state).toBe("stopped");
    expect(persisted).toBe(true);
    expect(await (await h.app.request("/api/agent-runs")).json()).toEqual([]);
    await turn.return();
  });

  test("ask detection needs its awaiting result; failure/stop override asks and malformed JSON is harmless", async () => {
    const h = setup();
    const client = await connect(h.app);
    const ask = { event: "tool-result", data: '{"toolName":"ask_user","output":{"status":"awaiting_answer"}}' };
    const cases = [
      { state: "finished", events: [{ event: "tool-call", data: '{"toolName":"ask_user"}' }, FINISH] },
      { state: "finished", events: [{ event: "tool-result", data: '{"toolName":"ask_user","output":{"status":"answered"}}' }, FINISH] },
      { state: "finished", events: [{ event: "tool-result", data: '{"toolName":"ask_user","output":{"status":"awaiting_answer"},"isError":true}' }, FINISH] },
      { state: "finished", events: [{ event: "tool-result", data: "broken JSON" }, FINISH] },
      { state: "finished", events: [{ event: "tool-result", data: '{"toolName":"read_message_prompt","output":{"status":"awaiting_permission"}}' }, FINISH] },
      { state: "failed", events: [ask, { event: "error", data: "{}" }] },
      { state: "failed", events: [ask, { event: "finish", data: '{"finishReason":"error"}' }] },
      { state: "stopped", events: [ask, { event: "abort", data: "{}" }] },
    ];
    for (const { state, events } of cases) {
      await h.registry.start("thread", OWNER, async function* () { yield* events; }, LABEL).done;
      expect((await client.next()).data.state).toBe("started");
      expect((await client.next()).data.state).toBe(state);
    }
    const failure = new Error("Factory failure");
    await h.registry.start("thread", OWNER, () => { throw failure; }, LABEL).done;
    expect((await client.next()).data.state).toBe("started");
    expect((await client.next()).data.state).toBe("failed");
    await expect(h.registry.subscribe("thread")!.next()).rejects.toBe(failure);
  });

  test("a generator throwing on explicit cancellation reports stopped, not provider failure", async () => {
    const h = setup();
    const client = await connect(h.app);
    const entered = deferred<void>();
    const failure = new DOMException("Cancelled", "AbortError");
    const run = h.registry.start("thread", OWNER, async function* (signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        entered.resolve();
      });
      throw failure;
    }, LABEL);
    await entered.promise;
    expect((await client.next()).data.state).toBe("started");
    h.registry.stop("thread");
    await run.done;
    expect((await client.next()).data.state).toBe("stopped");
    // Lifecycle classification does not swallow/change the original replay failure.
    await expect(h.registry.subscribe("thread")!.next()).rejects.toBe(failure);
  });

  test("boot lists a run that predates the feature connection without replaying old lifecycle events", async () => {
    const registry = new AgentRunRegistry<AgentRunOwner>();
    const release = deferred<void>();
    cleanups.push(() => release.resolve());
    const run = registry.start("thread", OWNER, async function* () { await release.promise; yield FINISH; }, LABEL);
    const h = setup(registry);
    const client = await connect(h.app);
    expect(await (await h.app.request("/api/agent-runs")).json()).toEqual([{ threadId: "thread", owner: OWNER, ...LABEL, startedAt: run.startedAt }]);
    release.resolve();
    await run.done;
    expect((await client.next()).data.state).toBe("finished");
  });

  test("the production adapter publishes real script, mini-app and chat names", async () => {
    const stores = await createStoreContainer(":memory:");
    await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
    const adapter = new ExperienceCopilotAdapter(stores);
    const h = setup(adapter.agentRuns);
    const client = await connect(h.app);
    for (const scriptKind of ["interactive", "prompt"]) {
      const script = await stores.scripts.create({ name: `Host ${scriptKind}`, scriptKind, code: "" });
      const thread = await stores.experienceCopilot.startNewSession(script.id, "Session, NOT host title", false);
      const subscription = await adapter.experienceCopilotStartRun(thread.id, { content: "Hello", providerProfileId: "missing-provider" });
      for await (const _event of subscription) { /* Wait through real pre-provider failure and persistence. */ }
      const started = await client.next();
      expect(started.data).toEqual({ threadId: thread.id, owner: { kind: "script", scriptId: script.id }, kind: scriptKind === "interactive" ? "experience" : "script", title: script.name, state: "started" });
      expect((await client.next()).data.state).toBe("failed");
    }
    const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
    const snapshot = await runtime.character.createFromScratch({ name: "Chat host", firstMessage: "Hello" });
    const chat = (await stores.chats.getById(snapshot.activeChatId))!;
    const thread = await stores.experienceCopilot.startNewChatSession(chat.id, chat.activeBranchId!, "sidechat-ooc", "Session title", false);
    const subscription = await adapter.experienceCopilotStartRun(thread.id, { content: "Hello", providerProfileId: "missing-provider" });
    for await (const _event of subscription) { /* Wait for terminal generator state. */ }
    expect((await client.next()).data).toEqual({ threadId: thread.id, owner: { kind: "chat", chatId: chat.id, branchId: chat.activeBranchId, agentKind: "sidechat-ooc" }, kind: "sidechat-ooc", title: chat.title, state: "started" });
    expect((await client.next()).data.state).toBe("failed");
  });

  test("subscribing before ready preserves an event emitted during the handshake", async () => {
    const h = setup();
    const response = await h.app.request("/api/agent-runs/events");
    const notification: AgentRunNotification = { threadId: "thread", owner: OWNER, ...LABEL, state: "started" };
    expect(h.events.listenerCount("agent.run")).toBe(1);
    h.events.emit("agent.run", notification);
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"state":"started"')) text += decoder.decode((await reader.read()).value);
    expect(text.indexOf("event: ready")).toBeLessThan(text.indexOf("event: agent.run"));
  });

  test("a pre-aborted request leaves no subscription or held SSE response", async () => {
    const h = setup();
    const client = new AbortController();
    client.abort();
    const response = await h.app.request("/api/agent-runs/events", { signal: client.signal });
    expect(await response.text()).toBe("");
    expect(h.events.listenerCount("agent.run")).toBe(0);
  });
});
