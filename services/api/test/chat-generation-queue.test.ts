import { expect, test } from "bun:test";
import { createStoreContainer } from "@vibe-tavern/db";
import { EventBus, type AgentRunOwner } from "@vibe-tavern/domain";
import { AgentRunRegistry } from "../src/domain/agent/agent-run-registry.js";
import { ChatGenerationQueue } from "../src/domain/chat/chat-generation-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}
async function setup() {
  const stores = await createStoreContainer(":memory:");
  const now = new Date().toISOString();
  await stores.db.insert((await import("@vibe-tavern/db")).characters).values({ id: "character", name: "Queue", createdAt: now, updatedAt: now }).run();
  const chat = await stores.chats.createChat({ characterId: "character", title: "Queue", promptPresetId: null });
  const target = await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: "assistant", authorType: "character", content: "Original" });
  const registry = new AgentRunRegistry<AgentRunOwner>();
  const events = new EventBus();
  const order: string[] = [];
  const notices: string[] = [];
  events.on("chat.notification", (event) => { notices.push(event.kind); });
  let produce = async function* (model: string, signal: AbortSignal) {
    order.push(model);
    if (model === "failed") { yield { event: "error", data: '{"message":"Provider cut"}' }; return; }
    await stores.messages.addVariant(target.id, model);
    yield { event: "finish", data: '{"finishReason":"stop"}' };
  };
  const runner = new ChatGenerationQueue({ stores, registry,
    start: async (job, _branch, turn) => {
      registry.start(`chat:${job.chatId}`, { kind: "chat", chatId: job.chatId, mode: "rp" }, turn, { kind: "rp", title: "Queue" });
      return registry.subscribe(`chat:${job.chatId}`)!;
    }, regenerate: (job, signal) => produce(job.model, signal),
  });
  const input = { chatId: chat.id, messageId: target.id, model: "one", promptPresetId: null };
  return { stores, chat, target, registry, events, runner, input, order, notices,
    setProducer: (fn: typeof produce) => { produce = fn; } };
}

test("three jobs run in insertion order, failure advances, settlement precedes finished lifecycle", async () => {
  const h = await setup();
  for (const model of ["one", "failed", "three"]) await h.stores.chatGenerationJobs.enqueue({ ...h.input, model });
  const observed: Array<Promise<string[]>> = [];
  h.registry.onLifecycle((event) => {
    if (event.state !== "started") observed.push(h.stores.chatGenerationJobs.listByChat(h.chat.id).then((jobs) => jobs.map((job) => job.status)));
  });
  await h.runner.activate(h.events);
  await h.runner.kick(h.chat.id);
  expect(h.order).toEqual(["one", "failed", "three"]);
  expect((await h.runner.list(h.chat.id)).map((job) => job.status)).toEqual(["done", "failed", "done"]);
  expect((await h.runner.list(h.chat.id)).map((job) => job.variantIndex)).toEqual([1, undefined, 2]);
  expect((await h.runner.list(h.chat.id))[1]?.error).toBe("Provider cut");
  expect(h.registry.active()).toHaveLength(0);
  expect(h.notices).toEqual(Array(6).fill("queue.updated"));
  expect(await Promise.all(observed)).toEqual([["done", "pending", "pending"], ["done", "failed", "pending"], ["done", "failed", "done"]]);
  h.runner.deactivate();
});

test("an ordinary generation blocks pending work and its completion wakes the queue without a subscriber", async () => {
  const h = await setup();
  const release = deferred();
  const ordinary = h.registry.start(`chat:${h.chat.id}`, { kind: "chat", chatId: h.chat.id, mode: "rp" }, async function* () { await release.promise; }, { kind: "rp", title: "Queue" });
  await h.runner.activate(h.events);
  await h.runner.enqueue(h.chat.id, h.input);
  await h.runner.kick(h.chat.id);
  expect(h.order).toEqual([]);
  expect((await h.runner.list(h.chat.id))[0]?.status).toBe("pending");
  release.resolve(); await ordinary.done;
  await h.runner.kick(h.chat.id);
  expect(h.order).toEqual(["one"]);
  expect((await h.runner.list(h.chat.id))[0]?.status).toBe("done");
  h.runner.deactivate();
});

test("pending cancel and clear do not stop the running job; Stop keeps partial output and advances", async () => {
  const h = await setup();
  const entered = deferred();
  h.setProducer(async function* (model, signal) {
    h.order.push(model);
    if (model === "one") {
      const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      entered.resolve(); await stopped;
      await h.stores.messages.addVariant(h.target.id, "Partial");
      yield { event: "abort", data: '{"partialLength":7}' }; return;
    }
    await h.stores.messages.addVariant(h.target.id, model);
    yield { event: "finish", data: '{"finishReason":"stop"}' };
  });
  await h.runner.activate(h.events);
  const running = await h.runner.enqueue(h.chat.id, h.input);
  await entered.promise;
  const pending = await h.runner.enqueue(h.chat.id, { ...h.input, model: "cancel" });
  await h.runner.cancel(h.chat.id, pending.id);
  await h.runner.enqueue(h.chat.id, { ...h.input, model: "clear" });
  await h.runner.clear(h.chat.id);
  expect(h.registry.active()).toHaveLength(1);
  await h.runner.enqueue(h.chat.id, { ...h.input, model: "next" });
  await h.runner.cancel(h.chat.id, running.id);
  await h.runner.kick(h.chat.id);
  expect(h.order).toEqual(["one", "next"]);
  expect((await h.runner.list(h.chat.id)).map((job) => job.status)).toEqual(["cancelled", "cancelled", "done"]);
  expect((await h.stores.messages.getVariants(h.target.id)).map((variant) => variant.content)).toEqual(["Original", "Partial", "next"]);
  h.runner.deactivate();
});

test("restart marks interrupted work failed, resumes only pending and preserves settled evidence", async () => {
  const h = await setup();
  const interrupted = await h.stores.chatGenerationJobs.enqueue(h.input);
  await h.stores.chatGenerationJobs.setStatus(h.chat.id, interrupted.id, { status: "running" });
  await h.stores.chatGenerationJobs.enqueue({ ...h.input, model: "pending" });
  await h.runner.activate(h.events);
  await h.runner.kick(h.chat.id);
  expect(h.order).toEqual(["pending"]);
  expect((await h.runner.list(h.chat.id))[0]).toMatchObject({ status: "failed", error: "Server restarted during generation. Retry this job to generate another variant." });
  expect((await h.runner.list(h.chat.id))[1]?.status).toBe("done");
  await h.runner.activate(h.events); // Idempotent activation never reclassifies a live run.
  expect(h.order).toEqual(["pending"]);
  h.runner.deactivate();
});

test("queue operations reject foreign targets and missing chats/jobs", async () => {
  const h = await setup();
  const other = await h.stores.chats.createChat({ characterId: "character", title: "Other", promptPresetId: null });
  await expect(h.runner.enqueue(other.id, h.input)).rejects.toThrow("Message");
  await expect(h.runner.list("missing")).rejects.toThrow("Chat");
  await expect(h.runner.cancel(other.id, "missing")).rejects.toThrow("Queue job");
  expect(await h.runner.list(h.chat.id)).toEqual([]);
});
