import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  EventBus,
  brandId,
  type ChatBranchId,
  type ChatId,
  type StoredProviderProfileRecord,
} from "@vibe-tavern/domain";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { ChatRuntime } from "../src/runtime/session/session-runtime-chat.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import type { ChatModeAssembleResult, ChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { userMessageSavedFlag } from "../src/domain/chat/user-message-saved.js";
import type { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import type { SessionSnapshot } from "../src/api/contract/session-types.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";

// ════════════════════════════════════════════════════════════════════════════
// A provider that cuts the stream mid-reply (owner 2026-10-02: «у нас бывает,
// не сохраняется если провайдер обрывает сообщение»).
//
// Before: drainStream's provider-error branch discarded everything streamed
// so far — the user watched the reply appear, then it vanished on the error.
// A user Stop already kept the partial text (onAbort). Now a provider cut
// keeps it the same way, and the error event says so (`partialSaved`) so the
// client reloads the chat instead of restoring the draft.
//
// Harness forked from regex-reasoning.test.ts (real ChatRuntime + real
// stores; provider executors through the orchestrator's `executors`
// constructor seam — no mock.module).
// ════════════════════════════════════════════════════════════════════════════

// Per-test stub state (reset in beforeEach): what streams before the cut.
let deltasBeforeCut: Array<{ type: "text-delta"; delta: string } | { type: "reasoning-delta"; textDelta: string }> = [];

// The non-streaming twin: the provider fails outright (no partial text in
// this mode) after the user message was stored.
const STUB_NONSTREAMING: typeof nonstreamingProviderExecute = async () => {
  throw new Error("upstream connection reset");
};
const STUB_STREAM: typeof streamProviderExecutor = async () => {
  const cut = new Error("upstream connection reset");
  // The executor's derived promises reject with the same cause the stream
  // throws — attach no-op handlers so an unawaited one never surfaces as an
  // unhandled rejection (runner fact 3).
  const finished = Promise.reject(cut);
  const text = Promise.reject(cut);
  finished.catch(() => {});
  text.catch(() => {});
  return {
    stream: (async function* () {
      for (const delta of deltasBeforeCut) yield delta;
      throw cut;
    })(),
    finished,
    text,
    reasoning: Promise.resolve(undefined),
    hasRedactedReasoning: false,
    providerResponse: { mode: "stream" as const, steps: [] },
  };
};
const STUB_EXECUTORS = { nonstreaming: STUB_NONSTREAMING, stream: STUB_STREAM };

const tmpDirs: string[] = [];

interface TestChat {
  stores: Awaited<ReturnType<typeof createRuntimeStore>>;
  chatApp: ChatApplicationService;
  chatId: ChatId;
  branchId: string;
}

async function setup(): Promise<TestChat> {
  const tmpDir = resolve(tmpdir(), "vt-stream-cut-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const character = await stores.characters.create({ name: "StreamCutProbe", firstMessage: "Hi!" });
  const persona = await stores.personas.getDefault();
  const chat = await stores.chats.createChat({
    characterId: character.id,
    personaId: persona?.id,
    title: "stream cut test",
    promptPresetId: null,
    mode: "rp",
  });
  return {
    stores,
    chatApp: new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls, stores.experiences, stores),
    chatId: brandId<ChatId>(chat.id),
    branchId: chat.activeBranchId,
  };
}

beforeEach(() => {
  deltasBeforeCut = [];
});

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Minimal valid `ChatModeAssembleResult` for the fake `assemblePrompt`. */
function fakeAssembleResult(chatId: string, branchId: string): ChatModeAssembleResult {
  return {
    branchId: brandId<ChatBranchId>(branchId),
    prompt: {
      layers: [],
      tokenAccounting: {},
      activatedLoreEntries: [],
      scriptInjections: [],
      retrievedMemories: [],
      finalPayload: { messages: [] },
    },
    promptTraceDraft: {
      chatId,
      branchId,
      model: "test-model",
      presetName: "test",
      assembledLayers: [],
      tokenAccounting: {},
      finalPayload: { messages: [] },
      activatedLoreEntries: [],
      activatedLoreDetail: [],
      retrievedMemories: [],
      scriptInjections: [],
      latencyMs: 0,
      presetId: null,
    },
  };
}

/** A dependency these paths must never call. */
async function unusedDep(): Promise<never> {
  throw new Error("dependency not used by the stream paths under test");
}

function makeHarness(chat: TestChat): InstanceType<typeof LiveChatOrchestrator> {
  const rt = new ChatRuntime({
    chats: chat.stores.chats,
    messages: chat.stores.messages,
    traces: chat.stores.traces,
    chatApp: chat.chatApp,
    diceRolls: chat.stores.diceRolls,
    uiSettings: chat.stores.uiSettings,
    experiences: chat.stores.experiences,
    assemblePrompt: async () => fakeAssembleResult(chat.chatId as string, chat.branchId),
    // Typed stubs (the hygiene budget forbids new never-casts): the response
    // builders the append paths call return minimal valid shapes; the rest
    // must never run here. prepareLiveTurn's snapshot is read only for
    // `messages.length` — a full SessionSnapshot fixture would be noise.
    getSnapshot: async () => ({ messages: [] }) as unknown as SessionSnapshot,
    buildMessageResponse: async () => ({ messages: [], promptTrace: null }),
    buildVariantResponse: async () => ({ messages: [] }),
    buildBranchResponse: unusedDep,
    buildBranchMetaResponse: unusedDep,
    buildChatListResponse: unusedDep,
    chatOrder: { add() {}, remove() {}, items: [] },
  });

  const fakeStrategy: ChatModeStrategy = {
    mode: "rp",
    async resolveProvider(input) {
      return { profile: input.profile, model: input.model };
    },
    async onMessageAppended() { /* no-op */ },
    async assemble() {
      throw new Error("strategy.assemble is not used — prepareLiveTurn uses the deps.assemblePrompt");
    },
  };

  return new LiveChatOrchestrator(
    rt,
    chat.chatApp,
    // Provider resolution goes through the injected executors below; the
    // orchestrator's ProviderOrchestrator is never touched on these paths.
    {} as ProviderOrchestrator,
    new EventBus(),
    async () => fakeStrategy,
    undefined,
    undefined,
    STUB_EXECUTORS,
  );
}

const TEST_PROFILE = { id: "test-profile", maxTokens: 4096 } as StoredProviderProfileRecord;

async function drain(gen: AsyncGenerator<{ event: string; data: string }>): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

async function assistantMessages(chat: TestChat) {
  const msgs = await chat.stores.messages.getMessages(chat.branchId);
  return msgs.filter((m) => m.role === "assistant");
}

function errorEvent(events: Array<{ event: string; data: string }>): Record<string, unknown> {
  const ev = events.find((e) => e.event === "error");
  if (!ev) throw new Error(`no error event in ${events.map((e) => e.event).join(", ")}`);
  return JSON.parse(ev.data) as Record<string, unknown>;
}

describe("provider cuts the stream mid-reply", () => {
  it("send: the text streamed before the cut is stored as the assistant reply; the error event reports partialSaved", async () => {
    const chat = await setup();
    const orch = makeHarness(chat);
    const before = (await assistantMessages(chat)).length;
    deltasBeforeCut = [
      { type: "reasoning-delta", textDelta: "thinking it over" },
      { type: "text-delta", delta: "The dragon lowered " },
      { type: "text-delta", delta: "its head and" },
    ];

    const events = await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    // The deltas reached the client before the cut.
    expect(events.filter((e) => e.event === "text-delta")).toHaveLength(2);
    const error = errorEvent(events);
    expect(error.message).toBe("upstream connection reset");
    expect(error.partialSaved).toBe(true);
    expect(events.find((e) => e.event === "finish")).toBeUndefined();

    const assistants = await assistantMessages(chat);
    expect(assistants).toHaveLength(before + 1);
    const reply = assistants[assistants.length - 1]!;
    expect(reply.content).toBe("The dragon lowered its head and");
    const variants = await chat.stores.messages.getVariants(reply.id);
    expect(variants.find((v) => v.isSelected)?.reasoning).toBe("thinking it over");
  });

  it("regenerate: the partial text becomes a new variant of the regenerated message", async () => {
    const chat = await setup();
    const orch = makeHarness(chat);
    // The test chat starts empty — seed the reply to regenerate with a first
    // cut send (the case above).
    deltasBeforeCut = [{ type: "text-delta", delta: "First reply, cut" }];
    await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }));
    const greeting = (await assistantMessages(chat))[0]!;
    const variantsBefore = (await chat.stores.messages.getVariants(greeting.id)).length;
    deltasBeforeCut = [{ type: "text-delta", delta: "A different hello, cut" }];

    const events = await drain(orch.regenerateMessageStream({
      chatId: chat.chatId as string,
      messageId: greeting.id,
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    expect(errorEvent(events).partialSaved).toBe(true);
    const variants = await chat.stores.messages.getVariants(greeting.id);
    expect(variants).toHaveLength(variantsBefore + 1);
    expect(variants.some((v) => v.content === "A different hello, cut")).toBe(true);
  });

  it("a cut before any text arrives stores nothing and the error event carries no partialSaved (unchanged)", async () => {
    const chat = await setup();
    const orch = makeHarness(chat);
    const before = (await assistantMessages(chat)).length;

    const events = await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    const error = errorEvent(events);
    expect(error.message).toBe("upstream connection reset");
    expect(error.partialSaved).toBeUndefined();
    expect(await assistantMessages(chat)).toHaveLength(before);
  });

  it("send announces the stored user message before streaming, so a client seeing an error after it knows the message is on the server", async () => {
    const chat = await setup();
    const orch = makeHarness(chat);

    const events = await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    const names = events.map((e) => e.event);
    const savedAt = names.indexOf("user-message-saved");
    expect(savedAt).toBeGreaterThanOrEqual(0);
    expect(savedAt).toBeLessThan(names.indexOf("error"));
    const msgs = await chat.stores.messages.getMessages(chat.branchId);
    const user = msgs.find((m) => m.role === "user");
    expect(JSON.parse(events[savedAt]!.data)).toEqual({ messageId: user!.id });
  });

  it("non-stream send: a provider failure after the store keeps the user message and marks the error userMessageSaved", async () => {
    const chat = await setup();
    const orch = makeHarness(chat);

    const failure = await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }).then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(userMessageSavedFlag(failure)).toEqual({ userMessageSaved: true });
    const msgs = await chat.stores.messages.getMessages(chat.branchId);
    expect(msgs.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["hello"]);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("reasoning only, no reply text: nothing is stored (the same empty-text rule as a user Stop)", async () => {
    const chat = await setup();
    const orch = makeHarness(chat);
    const before = (await assistantMessages(chat)).length;
    deltasBeforeCut = [{ type: "reasoning-delta", textDelta: "still thinking" }];

    const events = await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    expect(errorEvent(events).partialSaved).toBeUndefined();
    expect(await assistantMessages(chat)).toHaveLength(before);
  });
});
