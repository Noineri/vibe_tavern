import { describe, it, expect, afterAll, beforeEach, mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  EventBus,
  REGEX_PLACEMENT,
  REGEX_SUBSTITUTE,
  REGEX_TARGET_TYPE,
  brandId,
  type ChatBranchId,
  type ChatId,
  type StoredProviderProfileRecord,
} from "@vibe-tavern/domain";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { ChatRuntime } from "../src/runtime/session/session-runtime-chat.js";
import { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import type { ChatModeAssembleResult, ChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";

// ════════════════════════════════════════════════════════════════════════════
// RX-10 (REGEX_EXTENSION_PLAN, Wave 2b) — REASONING live hook.
//
// Full-path boundary test mirroring regex-hooks.test.ts (RX-8): the REAL
// RegexHookService is wired into the orchestrator exactly as
// server-runtime.ts wires it, and both send paths run to completion. Pins:
//
//   - persist-mode REASONING: the stored variant's reasoning is the
//     TRANSFORMED text while the main content is untouched — non-stream +
//     stream paths; in the stream path the reasoning deltas stream RAW
//     (ST parity: only the finalized stored reasoning is transformed);
//   - placement isolation BOTH ways with the preset demonstrably active:
//     an AiOutput-placement preset never fires on reasoning, and a
//     Reasoning-placement preset never fires on main content;
//   - prompt-only REASONING presets are NO-OPs at this seam (the
//     assembled-prompt seam is Wave 3) — original reasoning stored;
//   - disabled / invalid-pattern presets: no-ops, send still succeeds;
//   - the orchestrator's guard: with undefined reasoning the REASONING hook
//     is never even invoked (spy), and it IS invoked once when reasoning
//     exists.
//
// Provider executors are mocked via the SAFE mock.module pattern (identical
// to regex-hooks.test.ts / dice-send-stream-nonstream.test.ts): real exports
// captured FIRST (`await import`), spread, then ONLY the executor functions
// overridden. The mocked replies are configurable per test via module-level
// mutable state (reset in beforeEach). The orchestrator is dynamic-imported
// AFTER registration so it resolves THESE mocks.
// ════════════════════════════════════════════════════════════════════════════

const RAW_REASONING = "line one\n\n\n\nline two";
const THINKING_REPLY = `<think>${RAW_REASONING}</think>Plain reply body.`;
const PLAIN_REPLY = "Plain reply body.";

// Per-test mock state (reset in beforeEach).
let nonstreamReplyText = THINKING_REPLY;
let streamReasoningDelta: string | null = RAW_REASONING;
let streamBodyText = PLAIN_REPLY;

// ── Safe mock.module: capture real executor exports BEFORE registering ──────
const realNonstreaming = await import("../src/infrastructure/ai/nonstreaming-provider-executor.js");
const realStream = await import("../src/infrastructure/ai/stream-provider-executor.js");

mock.module("../src/infrastructure/ai/nonstreaming-provider-executor.js", () => ({
  ...realNonstreaming,
  nonstreamingProviderExecute: async () => ({
    text: nonstreamReplyText,
    providerResponse: { mode: "nonstream" as const, steps: [] },
  }),
}));

mock.module("../src/infrastructure/ai/stream-provider-executor.js", () => ({
  ...realStream,
  streamProviderExecutor: async () => ({
    stream: (async function* () {
      // Raw reasoning first (as a reasoning model streams), then the body.
      // Deltas must stream UNTRANSFORMED — the transform lands only on the
      // finalized stored reasoning.
      if (streamReasoningDelta !== null) {
        yield { type: "reasoning-delta" as const, textDelta: streamReasoningDelta };
      }
      yield { type: "text-delta" as const, delta: streamBodyText };
    })(),
    finished: Promise.resolve({ finishReason: "stop" as const }),
    text: Promise.resolve(streamBodyText),
    reasoning: Promise.resolve(undefined),
    hasRedactedReasoning: false,
    providerResponse: { mode: "stream" as const, steps: [] },
  }),
}));

// Dynamic import AFTER mock registration so the orchestrator resolves mocks.
const { LiveChatOrchestrator } = await import("../src/domain/chat/live-chat-orchestrator.js");

// ── Test harness (mirrors regex-hooks.test.ts) ───────────────────────────────

const tmpDirs: string[] = [];

interface TestChat {
  stores: Awaited<ReturnType<typeof createRuntimeStore>>;
  chatApp: ChatApplicationService;
  chatId: ChatId;
  branchId: string;
  characterId: string;
}

async function setup(characterName = "RegexReasoningProbe"): Promise<TestChat> {
  const tmpDir = resolve(tmpdir(), "vt-rx10-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const character = await stores.characters.create({ name: characterName, firstMessage: "Hi!" });
  const persona = await stores.personas.getDefault();
  const chat = await stores.chats.createChat({
    characterId: character.id,
    personaId: persona?.id,
    title: "RX-10 test",
    promptPresetId: null,
    mode: "rp",
  });
  return {
    stores,
    chatApp: new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls),
    chatId: brandId<ChatId>(chat.id),
    branchId: chat.activeBranchId,
    characterId: character.id,
  };
}

beforeEach(() => {
  nonstreamReplyText = THINKING_REPLY;
  streamReasoningDelta = RAW_REASONING;
  streamBodyText = PLAIN_REPLY;
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

/** Orchestrator over a real ChatRuntime + real stores. `hooksOverride` swaps
 *  in a manual hook triple (for spy tests); default = the REAL RegexHookService
 *  wired exactly as server-runtime.ts wires it. */
function makeHarness(
  chat: TestChat,
  hooksOverride?: { onUserInput: (t: string, c: never) => string; onAiOutput: (t: string, c: never) => string; onReasoning: (t: string, c: never) => string },
): InstanceType<typeof LiveChatOrchestrator> {
  const rt = new ChatRuntime({
    chats: chat.stores.chats,
    messages: chat.stores.messages,
    traces: chat.stores.traces,
    chatApp: chat.chatApp,
    diceRolls: chat.stores.diceRolls,
    uiSettings: chat.stores.uiSettings,
    experiences: chat.stores.experiences,
    assemblePrompt: async () => fakeAssembleResult(chat.chatId as string, chat.branchId),
    getSnapshot: async () => ({ messages: [] }) as never,
    buildMessageResponse: async () => ({ messages: [] }) as never,
    buildVariantResponse: async () => ({ messages: [] }) as never,
    buildBranchResponse: async () => ({ branches: [] }) as never,
    buildBranchMetaResponse: async () => ({ branches: [] }) as never,
    buildChatListResponse: async () => ({ chats: [] }) as never,
    chatOrder: { remove() {} } as never,
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
    null as never,
    new EventBus(),
    async () => fakeStrategy,
    undefined,
    hooksOverride ?? new RegexHookService(chat.stores).createHooks(),
  );
}

/** Minimal passthrough profile (same shape as the RX-8 harness). */
const TEST_PROFILE = { id: "test-profile", maxTokens: 4096 } as StoredProviderProfileRecord;

/** Full field set minus store-generated columns (CreateRegexPresetData). */
function presetInput(overrides: Record<string, unknown>) {
  return {
    name: "preset",
    findRegex: "/nope/g",
    replaceString: "",
    trimStrings: [] as string[],
    substituteRegex: REGEX_SUBSTITUTE.None,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [REGEX_PLACEMENT.Reasoning],
    isGlobal: false,
    sortOrder: 0,
    ...overrides,
  };
}

async function lastMessage(chat: TestChat, role: "user" | "assistant"): Promise<{ id: string; content: string }> {
  const msgs = await chat.stores.messages.getMessages(chat.branchId);
  const found = [...msgs].reverse().find((m) => m.role === role);
  if (!found) throw new Error(`no ${role} message in branch ${chat.branchId}`);
  return { id: found.id, content: found.content };
}

/** The selected variant's stored reasoning for the last message of `role`. */
async function selectedReasoning(chat: TestChat, role: "user" | "assistant"): Promise<string | undefined> {
  const msg = await lastMessage(chat, role);
  const variants = await chat.stores.messages.getVariants(msg.id);
  return variants.find((v) => v.isSelected)?.reasoning;
}

async function drain(gen: AsyncGenerator<{ event: string; data: string }>): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ════════════════════════════════════════════════════════════════════════════

describe("RX-10 REASONING hook — persist-mode transform", () => {
  it("non-stream: stored reasoning collapsed (\\n{3,}→\\n\\n), main content untouched", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "collapse reasoning blank lines",
      findRegex: "/\\n{3,}/g",
      replaceString: "\n\n",
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const orch = makeHarness(chat);

    const result = await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    });

    expect(await selectedReasoning(chat, "assistant")).toBe("line one\n\nline two");
    // Main content is untouched by the Reasoning placement.
    expect((await lastMessage(chat, "assistant")).content).toBe("Plain reply body.");
    expect(result.reply).toBe("Plain reply body.");
  });

  it("stream: reasoning deltas stream RAW, stored reasoning transformed after the stream finishes", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "collapse reasoning blank lines",
      findRegex: "/\\n{3,}/g",
      replaceString: "\n\n",
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const orch = makeHarness(chat);

    const events = await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    // Raw reasoning delta (ST parity — watch the raw stream, the stored final is rewritten).
    const reasoningDeltas = events
      .filter((ev) => ev.event === "reasoning-delta")
      .map((ev) => (JSON.parse(ev.data) as { delta: string }).delta)
      .join("");
    expect(reasoningDeltas).toBe(RAW_REASONING);

    expect(await selectedReasoning(chat, "assistant")).toBe("line one\n\nline two");
    expect((await lastMessage(chat, "assistant")).content).toBe("Plain reply body.");
    expect(events.find((ev) => ev.event === "finish")).toBeDefined();
  });
});

describe("RX-10 REASONING hook — placement isolation (preset demonstrably active)", () => {
  it("AiOutput-placement preset transforms MAIN only — reasoning never touched", async () => {
    const chat = await setup();
    // One pattern matching text in BOTH parts: /line|Plain/ → "X".
    const preset = await chat.stores.regex.create(presetInput({
      name: "X main only",
      findRegex: "/line|Plain/g",
      replaceString: "X",
      placement: [REGEX_PLACEMENT.AiOutput],
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const orch = makeHarness(chat);

    await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    });

    // The preset IS active: main content transformed…
    expect((await lastMessage(chat, "assistant")).content).toBe("X reply body.");
    // …but the reasoning (which the same pattern matches) is untouched.
    expect(await selectedReasoning(chat, "assistant")).toBe(RAW_REASONING);
  });

  it("Reasoning-placement preset transforms REASONING only — main never touched", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "X reasoning only",
      findRegex: "/line|Plain/g",
      replaceString: "X",
      placement: [REGEX_PLACEMENT.Reasoning],
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const orch = makeHarness(chat);

    await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    });

    expect(await selectedReasoning(chat, "assistant")).toBe("X one\n\n\n\nX two");
    expect((await lastMessage(chat, "assistant")).content).toBe("Plain reply body.");
  });
});

describe("RX-10 REASONING hook — non-persist modes and degradation", () => {
  it("prompt-only REASONING preset: no-op at this seam (original reasoning stored)", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "prompt-only collapse",
      findRegex: "/\\n{3,}/g",
      replaceString: "\n\n",
      promptOnly: true,
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const orch = makeHarness(chat);

    await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect(await selectedReasoning(chat, "assistant")).toBe(RAW_REASONING);
  });

  it("disabled preset: no-op", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "disabled collapse",
      findRegex: "/\\n{3,}/g",
      replaceString: "\n\n",
      disabled: true,
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const orch = makeHarness(chat);

    await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect(await selectedReasoning(chat, "assistant")).toBe(RAW_REASONING);
  });

  it("invalid find pattern: preset skipped, send still succeeds", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "broken pattern",
      findRegex: "/([/g",
      replaceString: "\n\n",
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const orch = makeHarness(chat);

    const result = await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect(await selectedReasoning(chat, "assistant")).toBe(RAW_REASONING);
    expect(result.reply).toBe("Plain reply body.");
  });
});

describe("RX-10 REASONING hook — orchestrator guard", () => {
  it("undefined reasoning: hook never invoked; reasoning present: invoked exactly once with the raw text", async () => {
    const chat = await setup();
    const onReasoning = mock((text: string) => text);
    const identity = (text: string) => text;
    const orch = makeHarness(chat, {
      onUserInput: identity,
      onAiOutput: identity,
      onReasoning,
    });

    // No <think> block ⇒ reasoning is undefined ⇒ the hook must never fire.
    nonstreamReplyText = PLAIN_REPLY;
    await orch.sendMessage({ chatId: chat.chatId as string, content: "one", profile: TEST_PROFILE, model: "test-model" });
    expect(onReasoning.mock.calls.length).toBe(0);

    // With reasoning present the hook fires exactly once, with the raw text.
    nonstreamReplyText = THINKING_REPLY;
    await orch.sendMessage({ chatId: chat.chatId as string, content: "two", profile: TEST_PROFILE, model: "test-model" });
    expect(onReasoning.mock.calls.length).toBe(1);
    expect(onReasoning.mock.calls[0][0]).toBe(RAW_REASONING);
  });
});
