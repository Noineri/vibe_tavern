/** BR-4a ownership over real SQLite and registry; only turn producers are injected. */
import { expect, test } from "bun:test";
import { createStoreContainer, DiceBindError, ExperienceBindError } from "@vibe-tavern/db";
import type { AgentRunNotification, ChatMode } from "@vibe-tavern/domain";
import { ChatGenerationRunAdapter } from "../src/api/adapters/chat-generation-run-adapter.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { AgentRunActiveError } from "../src/domain/agent/agent-run-registry.js";

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
    const sub = await h.adapter.startChatGeneration(h.chat.id, async function* (signal) {
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
      expect(replay).toEqual([{ seq: 1, event: "finish", data: '{"finishReason":"stop"}' }]);
      expect(persisted).toBe(true);
      expect(h.events.map(({ state }) => state)).toEqual(["started", "finished"]);
    } finally { release.resolve(); await sub.return(); }
  });
}

test("reservation rejects a competing turn, but a different chat key remains independent", async () => {
  const h = await setup();
  const release = deferred();
  const sub = await h.adapter.startChatGeneration(h.chat.id, async function* () { await release.promise; });
  try {
    await expect(h.adapter.startChatGeneration(h.chat.id, async function* () {})).rejects.toBeInstanceOf(AgentRunActiveError);
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
  const sub = await h.adapter.startChatGeneration(h.chat.id, async function* (signal) {
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
    const sub = await h.adapter.startChatGeneration(h.chat.id, async function* () { throw failure; });
    const frames = [];
    for await (const event of sub) frames.push(event);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ seq: 1, event: "error" });
    expect(JSON.parse(frames[0]!.data)).toEqual({ message: failure.message, category: "unknown", ...(failure instanceof DiceBindError || failure instanceof ExperienceBindError ? { code: failure.code } : {}) });
    expect(h.events.at(-1)!.state).toBe("failed");
    expect(await h.adapter.subscribeChatGeneration(h.chat.id, 1)!.next()).toMatchObject({ done: true });
  }
});
