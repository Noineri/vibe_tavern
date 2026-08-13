import { describe, it, expect, afterAll, mock, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  COAUTHOR_TRANSPORT,
  EventBus,
  PROXY_MODE,
  brandId,
  type AssemblePromptResponse,
  type ChatId,
  type ChatBranchId,
} from "@vibe-tavern/domain";
import { DiceBindError } from "@vibe-tavern/db";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { ChatRuntime } from "../src/runtime/session/session-runtime-chat.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import type { ChatModeAssembleResult, ChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import {
  resetProviderFetchFactory,
  setProviderFetchFactory,
  type ProviderFetch,
} from "../src/domain/providers/provider-fetch-factory.js";

// ════════════════════════════════════════════════════════════════════════════
// DICE-B11 (DICE_SYSTEM_BACKEND_PLAN, Wave B4 unit 2) — stream/non-stream send.
//
// Full-path boundary test mirroring existing send coverage. Exercises BOTH send
// endpoints (non-stream `sendMessage` + stream `sendMessageStream`) through the
// SAME preparation boundary (`ChatRuntime.prepareLiveTurn`), plus the direct
// preparation-boundary cases that don't need the provider.
//
// The provider executors are mocked via the SAFE mock.module pattern: real
// exports and callable references are captured FIRST (`await import`), then all
// exports are spread before overriding one function. Bun's module override is
// process-global, so the captured callable references below are also the only
// reliable way to exercise the genuine executor boundary in this file. The
// orchestrator is dynamic-imported AFTER registration so it resolves the mocks.
// ChatRuntime / ChatApplicationService / createRuntimeStore do not import the
// executors, so they remain safe to import statically.
// ════════════════════════════════════════════════════════════════════════════

// ── Safe mock.module: capture real executor exports BEFORE registering ──────
const realNonstreaming = await import("../src/infrastructure/ai/nonstreaming-provider-executor.js");
const realStream = await import("../src/infrastructure/ai/stream-provider-executor.js");
const realNonstreamingProviderExecute = realNonstreaming.nonstreamingProviderExecute;
const realStreamProviderExecutor = realStream.streamProviderExecutor;

let providerShouldThrow = false;
const PROVIDER_FAILURE = new Error("provider-failure-after-commit");

mock.module("../src/infrastructure/ai/nonstreaming-provider-executor.js", () => ({
  ...realNonstreaming,
  nonstreamingProviderExecute: async () => {
    if (providerShouldThrow) throw PROVIDER_FAILURE;
    return {
      text: "Assistant reply.",
      providerResponse: { mode: "nonstream" as const, steps: [] },
    };
  },
}));

mock.module("../src/infrastructure/ai/stream-provider-executor.js", () => ({
  ...realStream,
  streamProviderExecutor: async () => {
    if (providerShouldThrow) throw PROVIDER_FAILURE;
    return {
      stream: (async function* () {
        yield { type: "text-delta" as const, delta: "Assistant reply." };
      })(),
      finished: Promise.resolve({ finishReason: "stop" as const }),
      text: Promise.resolve("Assistant reply."),
      reasoning: Promise.resolve(undefined),
      hasRedactedReasoning: false,
      providerResponse: { mode: "stream" as const, steps: [] },
    };
  },
}));

// Dynamic import AFTER mock registration so the orchestrator resolves mocks.
const { LiveChatOrchestrator } = await import("../src/domain/chat/live-chat-orchestrator.js");

// ── Test harness ────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

async function setup(): Promise<{
  stores: Awaited<ReturnType<typeof createRuntimeStore>>;
  chatApp: ChatApplicationService;
  chatId: ChatId;
  branchId: string;
}> {
  const tmpDir = resolve(tmpdir(), "vt-dice-b11-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const character = await stores.characters.create({ name: "DiceProbe", firstMessage: "Hi!" });
  const persona = await stores.personas.getDefault();
  const chat = await stores.chats.createChat({
    characterId: character.id,
    personaId: persona?.id,
    title: "Dice B11 test",
    promptPresetId: null,
    mode: "rp",
  });
  return {
    stores,
    chatApp: new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls),
    chatId: brandId<ChatId>(chat.id),
    branchId: chat.activeBranchId,
  };
}

afterAll(async () => {
  providerShouldThrow = false;
  resetProviderFetchFactory();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

beforeEach(() => {
  providerShouldThrow = false;
  resetProviderFetchFactory();
});

/** Minimal valid `ChatModeAssembleResult` for the mock `assemblePrompt`. The
 *  promptTraceDraft is stored by prepareLiveTurn but only consumed by
 *  appendAssistantReply (not exercised in the failure-path tests). */
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

/** Build a ChatRuntime backed by real stores with a controllable assemblePrompt
 *  and stub response builders (unused by prepareLiveTurn). */
function makeChatRuntime(
  stores: Awaited<ReturnType<typeof createRuntimeStore>>,
  chatApp: ChatApplicationService,
  assemblePrompt: (chatId: ChatId) => Promise<ChatModeAssembleResult>,
): ChatRuntime {
  return new ChatRuntime({
    chats: stores.chats,
    messages: stores.messages,
    traces: stores.traces,
    chatApp,
    diceRolls: stores.diceRolls,
    uiSettings: stores.uiSettings,
    // A 1-arg function is assignable to the deps' wider (chatId, branchId?, opts?) signature.
    assemblePrompt,
    getSnapshot: async () => ({ messages: [] }) as never,
    buildMessageResponse: async () => ({ messages: [] }) as never,
    buildVariantResponse: async () => ({ messages: [] }) as never,
    buildBranchResponse: async () => ({ branches: [] }) as never,
    buildBranchMetaResponse: async () => ({ branches: [] }) as never,
    buildChatListResponse: async () => ({ chats: [] }) as never,
    chatOrder: { remove() {} } as never,
  });
}

/** Seed a normal-mode pending roll and return the resulting lane revision. */
async function seedRoll(
  diceRolls: Awaited<ReturnType<typeof createRuntimeStore>>["diceRolls"],
  chatId: ChatId,
  branchId: string,
  requestId: string,
): Promise<number> {
  await diceRolls.createRoll({
    chatId: chatId as string,
    branchId,
    mode: "normal",
    requestId,
    actorType: "persona",
    actorId: "persona_1",
    actorLabel: "Player",
    scriptId: "script_1",
    scriptLabel: "Fate Die",
    scriptRevision: 1,
    checkId: "fate_check",
    checkLabel: "Fate Roll",
    notation: "4dF",
    faceShape: "dF",
    resolution: "narrative",
    attemptsJson: JSON.stringify([{ attemptId: "a1", faces: [1, 0, -1, 1], modifier: 0, subtotal: 1, total: 1 }]),
    finalJson: null,
  });
  const pending = await diceRolls.listPending(chatId as string, branchId);
  return pending.normal.revision;
}

// ════════════════════════════════════════════════════════════════════════════
// Part 1 — prepareLiveTurn: the shared preparation boundary (cases a–g)
// ════════════════════════════════════════════════════════════════════════════

describe("DICE-B11 prepareLiveTurn — diceCommit threading + rollback", () => {
  it("(a) no-Dice send unchanged: no bind, lane untouched", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    const prepared = await rt.prepareLiveTurn(chatId, "plain send", "test-model");
    expect(prepared.userMessage).toBeDefined();
    expect(prepared.userMessage!.content).toBe("plain send");
    // No dice lane touched.
    const pending = await stores.diceRolls.listPending(chatId as string, branchId);
    expect(pending.normal.revision).toBe(0);
    expect(pending.normal.rolls.length).toBe(0);
  });

  it("(b) valid diceCommit binds via the atomic path, one consume", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const revision = await seedRoll(stores.diceRolls, chatId, branchId, "req_b");
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    const prepared = await rt.prepareLiveTurn(
      chatId, "roll please", "test-model", undefined, undefined,
      { mode: "normal", pendingRevision: revision },
    );
    // Roll is bound to the just-created user message.
    const bound = await stores.diceRolls.getRollsForMessage(prepared.userMessage!.id);
    expect(bound.length).toBe(1);
    expect(bound[0]!.boundMessageId).toBe(prepared.userMessage!.id);
    // Lane consumed: pending normal lane is now empty (rolls bound, lane reset).
    const pending = await stores.diceRolls.listPending(chatId as string, branchId);
    expect(pending.normal.rolls.length).toBe(0);
  });

  it("(c) stale pendingRevision inserts nothing and releases nothing", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    await seedRoll(stores.diceRolls, chatId, branchId, "req_c"); // revision 1
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    // Stale revision 0 (actual is 1) → DiceBindError, no message committed.
    await expect(
      rt.prepareLiveTurn(chatId, "stale send", "test-model", undefined, undefined, { mode: "normal", pendingRevision: 0 }),
    ).rejects.toBeInstanceOf(DiceBindError);
    // No user message was added (only the seeded greeting exists).
    const msgs = await stores.messages.getMessages(branchId);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(0);
    // The pending roll is still there, unbound.
    const pending = await stores.diceRolls.listPending(chatId as string, branchId);
    expect(pending.normal.rolls.length).toBe(1);
    expect(pending.normal.rolls[0]!.boundMessageId).toBeNull();
  });

  it("(d) assembly failure calls rollbackRelease (rolls released, no leak)", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const revision = await seedRoll(stores.diceRolls, chatId, branchId, "req_d");
    // assemblePrompt throws on the FIRST call (the one after appendUserMessage).
    let firstCall = true;
    const rt = makeChatRuntime(stores, chatApp, async () => {
      if (firstCall) {
        firstCall = false;
        throw new Error("assembly-failure");
      }
      return fakeAssembleResult(chatId as string, branchId);
    });
    await expect(
      rt.prepareLiveTurn(chatId, "will fail assembly", "test-model", undefined, undefined, { mode: "normal", pendingRevision: revision }),
    ).rejects.toThrow("assembly-failure");
    // The user message was deleted (no ghost).
    const msgs = await stores.messages.getMessages(branchId);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(0);
    // The roll was released back to pending (boundMessageId null) — no leak.
    const pending = await stores.diceRolls.listPending(chatId as string, branchId);
    expect(pending.normal.rolls.length).toBe(1);
    expect(pending.normal.rolls[0]!.boundMessageId).toBeNull();
  });

  it("(f) attachment-only send with diceCommit binds like prose", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const revision = await seedRoll(stores.diceRolls, chatId, branchId, "req_f");
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    const attachment = {
      id: "att_1", assetId: "asset_1", type: "image" as const,
      name: "img.png", mimeType: "image/png", sizeBytes: 1024,
    };
    const prepared = await rt.prepareLiveTurn(
      chatId, "", "test-model", undefined, [attachment],
      { mode: "normal", pendingRevision: revision },
    );
    // A user message WAS inserted (attachment-only, no prose) and dice bound.
    expect(prepared.userMessage).toBeDefined();
    const bound = await stores.diceRolls.getRollsForMessage(prepared.userMessage!.id);
    expect(bound.length).toBe(1);
    expect(bound[0]!.boundMessageId).toBe(prepared.userMessage!.id);
  });

  it("(g) empty-draft + no-attachment + diceCommit does NOT send", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const revision = await seedRoll(stores.diceRolls, chatId, branchId, "req_g");
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    // Empty content, no attachments → early return, no user message, no bind.
    const prepared = await rt.prepareLiveTurn(
      chatId, "   ", "test-model", undefined, undefined,
      { mode: "normal", pendingRevision: revision },
    );
    expect(prepared.userMessage).toBeUndefined();
    const msgs = await stores.messages.getMessages(branchId);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(0);
    // Pending roll untouched (still pending, unbound).
    const pending = await stores.diceRolls.listPending(chatId as string, branchId);
    expect(pending.normal.rolls.length).toBe(1);
    expect(pending.normal.rolls[0]!.boundMessageId).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Part 2 — Orchestrator: both endpoints thread diceCommit + provider-failure
//          retention (case e). Uses the mocked executors.
// ════════════════════════════════════════════════════════════════════════════

/** Minimal fake strategy: pass-through provider resolution, no-op post-append. */
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

function makeOrchestrator(rt: ChatRuntime, chatApp: ChatApplicationService): InstanceType<typeof LiveChatOrchestrator> {
  return new LiveChatOrchestrator(
    rt,
    chatApp,
    null as never,
    new EventBus(),
    async () => fakeStrategy,
  );
}

const TEST_PROFILE = { id: "test-profile", maxTokens: 4096 } as StoredProviderProfileRecord;

function realExecutorProfile(): StoredProviderProfileRecord {
  return {
    id: "provider-proxy-test",
    name: "Proxy test",
    providerPreset: "openai",
    coauthorTransport: COAUTHOR_TRANSPORT.chatCompletions,
    endpoint: "https://provider.example/v1",
    apiKey: "key",
    defaultModel: "test-model",
    contextBudget: null,
    pinContextBudget: false,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 16,
    temperature: 1,
    topP: 1,
    topK: 0,
    minP: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "auto",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    proxyMode: PROXY_MODE.proxy,
    proxyId: "proxy",
    isActive: true,
    visionModel: null,
    createdAt: "",
    updatedAt: "",
  };
}

const realExecutorPrompt = {
  layers: [],
  tokenAccounting: {},
  activatedLoreEntries: [],
  scriptInjections: [],
  retrievedMemories: [],
  finalPayload: { messages: [{ role: "user", content: "Hi" }] },
} satisfies AssemblePromptResponse;

describe("provider executor proxy boundary", () => {
  it("streaming and non-streaming executors resolve and use the profile proxy fetch", async () => {
    const requestedUrls: string[] = [];
    const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(input instanceof Request ? input.url : String(input));
      const body = typeof init?.body === "string" ? init.body : "";
      if (/\"stream\"\s*:\s*true/.test(body)) {
        const chunks = [
          `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "streamed reply" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
        return new Response(new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({
        id: "chat_1",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "chat reply" }, finish_reason: "stop" }],
      });
    }) as ProviderFetch;
    providerFetch.preconnect = () => {};

    const resolvedPolicies: Array<{ proxyMode: string; proxyId: string | null }> = [];
    setProviderFetchFactory({
      resolveFetch: async (policy) => {
        resolvedPolicies.push(policy);
        return providerFetch;
      },
    });

    const input = { profile: realExecutorProfile(), model: "test-model", prompt: realExecutorPrompt };
    const nonstreaming = await realNonstreamingProviderExecute(input);
    expect(nonstreaming.text).toBe("chat reply");

    const streaming = await realStreamProviderExecutor(input);
    let streamedText = "";
    for await (const chunk of streaming.stream) {
      if (chunk.type === "text-delta") streamedText += chunk.delta;
    }
    expect(streamedText).toContain("streamed reply");
    expect((await streaming.finished).finishReason).toBe("stop");
    expect(resolvedPolicies).toEqual([
      { proxyMode: PROXY_MODE.proxy, proxyId: "proxy" },
      { proxyMode: PROXY_MODE.proxy, proxyId: "proxy" },
    ]);
    expect(requestedUrls).toEqual([
      "https://provider.example/v1/chat/completions",
      "https://provider.example/v1/chat/completions",
    ]);
  });
});

describe("DICE-B11 orchestrator — both endpoints + provider-failure retention", () => {
  it("(e) non-stream: provider failure after user-message commit retains bound rolls", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const revision = await seedRoll(stores.diceRolls, chatId, branchId, "req_e_ns");
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    const orch = makeOrchestrator(rt, chatApp);
    providerShouldThrow = true;

    // sendMessage: prepareLiveTurn binds rolls → provider throws → rethrow.
    await expect(
      orch.sendMessage({
        chatId: chatId as string,
        content: "roll please",
        profile: TEST_PROFILE,
        model: "test-model",
        diceCommit: { mode: "normal", pendingRevision: revision },
      }),
    ).rejects.toBe(PROVIDER_FAILURE);

    // The user message WAS committed (provider failure is AFTER commit).
    const msgs = await stores.messages.getMessages(branchId);
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    // The bound rolls are RETAINED on the committed message (immutable history).
    const bound = await stores.diceRolls.getRollsForMessage(userMsgs[0]!.id);
    expect(bound.length).toBe(1);
    expect(bound[0]!.boundMessageId).toBe(userMsgs[0]!.id);
  });

  it("(e) stream: provider failure after user-message commit retains bound rolls", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const revision = await seedRoll(stores.diceRolls, chatId, branchId, "req_e_s");
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    const orch = makeOrchestrator(rt, chatApp);
    providerShouldThrow = true;

    // sendMessageStream: prepareLiveTurn binds → startStream throws → generator throws.
    const gen = orch.sendMessageStream({
      chatId: chatId as string,
      content: "roll please",
      profile: TEST_PROFILE,
      model: "test-model",
      diceCommit: { mode: "normal", pendingRevision: revision },
    });
    await expect((async () => {
      for await (const _ of gen) { void _; }
    })()).rejects.toBe(PROVIDER_FAILURE);

    // Same retention guarantee as non-stream.
    const msgs = await stores.messages.getMessages(branchId);
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const bound = await stores.diceRolls.getRollsForMessage(userMsgs[0]!.id);
    expect(bound.length).toBe(1);
    expect(bound[0]!.boundMessageId).toBe(userMsgs[0]!.id);
  });

  it("both endpoints thread diceCommit into prepareLiveTurn (bind verified)", async () => {
    const { stores, chatApp, chatId, branchId } = await setup();
    const revision = await seedRoll(stores.diceRolls, chatId, branchId, "req_thread");
    const rt = makeChatRuntime(stores, chatApp, async () => fakeAssembleResult(chatId as string, branchId));
    const orch = makeOrchestrator(rt, chatApp);
    // Provider throws so the turn doesn't complete, but the BIND happens in
    // prepareLiveTurn BEFORE the provider call — proving both endpoints thread
    // diceCommit through the same preparation boundary.
    providerShouldThrow = true;

    // Non-stream
    await expect(
      orch.sendMessage({
        chatId: chatId as string,
        content: "threading test ns",
        profile: TEST_PROFILE,
        model: "test-model",
        diceCommit: { mode: "normal", pendingRevision: revision },
      }),
    ).rejects.toBe(PROVIDER_FAILURE);
    let msgs = await stores.messages.getMessages(branchId);
    let userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect((await stores.diceRolls.getRollsForMessage(userMsgs[0]!.id)).length).toBe(1);

    // Stream — fresh chat to isolate.
    const s = await setup();
    const sRevision = await seedRoll(s.stores.diceRolls, s.chatId, s.branchId, "req_thread_s");
    const sRt = makeChatRuntime(s.stores, s.chatApp, async () => fakeAssembleResult(s.chatId as string, s.branchId));
    const sOrch = makeOrchestrator(sRt, s.chatApp);
    providerShouldThrow = true;
    const gen = sOrch.sendMessageStream({
      chatId: s.chatId as string,
      content: "threading test s",
      profile: TEST_PROFILE,
      model: "test-model",
      diceCommit: { mode: "normal", pendingRevision: sRevision },
    });
    await expect((async () => {
      for await (const _ of gen) { void _; }
    })()).rejects.toBe(PROVIDER_FAILURE);
    msgs = await s.stores.messages.getMessages(s.branchId);
    userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect((await s.stores.diceRolls.getRollsForMessage(userMsgs[0]!.id)).length).toBe(1);
  });
});
