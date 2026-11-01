/** BR-4a ownership over real SQLite and registry; only turn producers are injected. */
import { expect, test } from "bun:test";
import { createStoreContainer, DiceBindError, ExperienceBindError } from "@vibe-tavern/db";
import type { AgentRunNotification, ChatMode } from "@vibe-tavern/domain";
import { ChatGenerationRunAdapter } from "../src/api/adapters/chat-generation-run-adapter.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { AgentRunActiveError } from "../src/domain/agent/agent-run-registry.js";
import { chatGenerationContextSchema } from "@vibe-tavern/api-contracts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup(mode: ChatMode = "rp") {
  const stores = await createStoreContainer(":memory:");
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({ name: "Run character", firstMessage: "Hello" });
  const rpChat = (await stores.chats.getById(created.activeChatId))!;
  const chat = mode === "rp" ? rpChat
    : (await stores.chats.getById((await runtime.chatLifecycle.createChatForCharacter(rpChat.characterId, mode)).activeChat.id))!;
  const adapter = new ChatGenerationRunAdapter(stores);
  const events: AgentRunNotification[] = [];
  adapter.agentRuns.onLifecycle((event) => { events.push(event); });
  return { stores, chat, adapter, events };
}

for (const mode of ["rp", "coauthor"] as const) {
  test(`${mode}: disconnect only detaches; lifecycle uses mode owner and character name after producer settlement`, async () => {
    const h = await setup(mode);
    const entered = deferred();
    const release = deferred();
    const client = new AbortController();
    let producerSignal: AbortSignal | undefined;
    let persisted = false;
    const sub = await h.adapter.startChatGeneration(h.chat.id, { operation: "generate", messageId: null }, async function* (signal) {
      producerSignal = signal;
      entered.resolve();
      await release.promise;
      persisted = true;
      yield { event: "finish", data: '{"finishReason":"stop"}' };
    }, client.signal);
    try {
      await entered.promise;
      client.abort();
      expect(await sub.next()).toMatchObject({ done: true });
      expect(producerSignal!.aborted).toBe(false);
      expect(h.adapter.agentRuns.active()).toHaveLength(1);
      expect(h.events).toEqual([{ threadId: `chat:${h.chat.id}`, kind: mode, title: "Run character", owner: { kind: "chat", chatId: h.chat.id, mode }, state: "started" }]);
      release.resolve();
      const replay = [];
      for await (const event of h.adapter.subscribeChatGeneration(h.chat.id, 0)!) replay.push(event);
      expect(replay[0]).toMatchObject({ seq: 1, event: "generation-context" });
      expect(JSON.parse(replay[0]!.data)).toMatchObject({ chatId: h.chat.id, branchId: h.chat.activeBranchId, operation: "generate", messageId: null });
      expect(replay.slice(1)).toEqual([{ seq: 2, event: "finish", data: '{"finishReason":"stop"}' }]);
      expect(persisted).toBe(true);
      expect(h.events.map(({ state }) => state)).toEqual(["started", "finished"]);
    } finally { release.resolve(); await sub.return(); }
  });
}

test("reservation rejects a competing turn, but a different chat key remains independent", async () => {
  const h = await setup();
  const release = deferred();
  const sub = await h.adapter.startChatGeneration(h.chat.id, { operation: "generate", messageId: null }, async function* () { await release.promise; });
  try {
    await expect(h.adapter.startChatGeneration(h.chat.id, { operation: "generate", messageId: null }, async function* () {})).rejects.toBeInstanceOf(AgentRunActiveError);
    expect(h.adapter.agentRuns.active()).toHaveLength(1);
    h.adapter.agentRuns.start("agent-thread", { kind: "script", scriptId: "script" }, async function* () { await release.promise; });
    expect(h.adapter.agentRuns.active()).toHaveLength(2);
    release.resolve();
    for await (const _event of sub) { /* Await producer completion. */ }
  } finally { release.resolve(); await sub.return(); }
});

test("explicit stop is cooperative and lifecycle waits for the saved partial", async () => {
  const h = await setup();
  const entered = deferred();
  const persist = deferred();
  let saved = false;
  const sub = await h.adapter.startChatGeneration(h.chat.id, { operation: "generate", messageId: null }, async function* (signal) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      entered.resolve();
    });
    await persist.promise;
    saved = true;
    yield { event: "abort", data: '{"partialLength":7}' };
  });
  try {
    await entered.promise;
    expect(h.adapter.stopChatGeneration(h.chat.id)).toEqual({ stopped: true });
    expect(h.adapter.stopChatGeneration(h.chat.id)).toEqual({ stopped: false });
    expect(h.events.map(({ state }) => state)).toEqual(["started"]);
    expect(saved).toBe(false);
    persist.resolve();
    for await (const _event of sub) { /* Wait for persistence, not only the abort frame. */ }
    expect(saved).toBe(true);
    expect(h.events.map(({ state }) => state)).toEqual(["started", "stopped"]);
  } finally { persist.resolve(); h.adapter.stopChatGeneration(h.chat.id); await sub.return(); }
});

test("unwatched provider and typed bind failures are numbered, replayable and classified failed", async () => {
  const h = await setup();
  for (const failure of [new Error("Provider cut"), new DiceBindError("stale_revision", "Dice stale"), new ExperienceBindError("stale_queue", "Queue stale")]) {
    const sub = await h.adapter.startChatGeneration(h.chat.id, { operation: "send", messageId: null }, async function* () { throw failure; });
    const frames = [];
    for await (const event of sub) frames.push(event);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ seq: 2, event: "error" });
    expect(JSON.parse(frames[1]!.data)).toEqual({ message: failure.message, category: "unknown", ...(failure instanceof DiceBindError || failure instanceof ExperienceBindError ? { code: failure.code } : {}) });
    expect(h.events.at(-1)!.state).toBe("failed");
    expect(await h.adapter.subscribeChatGeneration(h.chat.id, 2)!.next()).toMatchObject({ done: true });
  }
});

test("context is the first retained frame even before a silent producer starts", async () => {
  const h = await setup();
  const entered = deferred();
  const release = deferred();
  const sub = await h.adapter.startChatGeneration(h.chat.id, { operation: "regenerate", messageId: "original-assistant" }, async function* () {
    entered.resolve(); await release.promise;
    yield { event: "text-delta", data: '{"delta":"Reply"}' };
  });
  try {
    const context = (await sub.next()).value!;
    expect(context).toMatchObject({ seq: 1, event: "generation-context" });
    expect(chatGenerationContextSchema.parse(JSON.parse(context.data))).toMatchObject({ operation: "regenerate", messageId: "original-assistant", branchId: h.chat.activeBranchId });
    await entered.promise;
    const replay = h.adapter.subscribeChatGeneration(h.chat.id, 0)!;
    expect((await replay.next()).value).toEqual(context);
    await replay.return();
    release.resolve();
    expect((await sub.next()).value).toMatchObject({ seq: 2, event: "text-delta" });
    expect((await sub.next()).done).toBe(true);
  } finally { release.resolve(); await sub.return(); }
});

test("a bound replay retains its run identity when the next run replaces the key", async () => {
  const h = await setup();
  const first = await h.adapter.startChatGeneration(h.chat.id, { operation: "generate", messageId: null }, async function* () {});
  const frames = [];
  for await (const frame of first) frames.push(frame);
  const old = h.adapter.subscribeChatGeneration(h.chat.id, 0)!;
  const second = await h.adapter.startChatGeneration(h.chat.id, { operation: "continue", messageId: "assistant" }, async function* () {});
  const next = [];
  for await (const frame of second) next.push(frame);
  expect((await old.next()).value).toEqual(frames[0]);
  expect((await old.next()).done).toBe(true);
  const previousContext = chatGenerationContextSchema.parse(JSON.parse(frames[0]!.data));
  const nextContext = chatGenerationContextSchema.parse(JSON.parse(next[0]!.data));
  expect(nextContext.runId).not.toBe(previousContext.runId);
  expect(nextContext).toMatchObject({ operation: "continue", messageId: "assistant" });
});
