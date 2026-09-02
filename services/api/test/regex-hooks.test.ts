import { describe, it, expect, afterAll } from "bun:test";
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
import { mock } from "bun:test";

// ════════════════════════════════════════════════════════════════════════════
// RX-8 (REGEX_EXTENSION_PLAN, Wave 2) — USER_INPUT + AI_OUTPUT live hooks.
//
// Full-path boundary test mirroring dice-send-stream-nonstream.test.ts: the
// REAL RegexHookService is wired into the orchestrator exactly as
// server-runtime.ts wires it, and both send paths run to completion. Pins:
//
//   - persist-mode USER_INPUT: stored user message AND the prompt-assembly
//     input (observed at the assemble boundary, which reads the just-inserted
//     message) both carry the transformed text — non-stream + stream paths;
//   - persist-mode AI_OUTPUT: appended reply stored transformed — non-stream +
//     stream paths; in the stream path the raw deltas stream UNTRANSFORMED
//     (ST parity: you watch the raw stream, the stored final is rewritten);
//   - display-only (markdownOnly) presets are NO-OPs at this seam (their
//     seams are Wave 3) — original text stored, both roles, both paths;
//   - disabled / other-character-bound / invalid-pattern presets: no-ops and
//     (for the invalid pattern) the send still succeeds;
//   - the service-built macro source resolves {{char}} in a find pattern
//     (substituteRegex RAW).
//
// The provider executors are mocked via the SAFE mock.module pattern (same as
// dice-send-stream-nonstream.test.ts): real exports are captured FIRST
// (`await import`), then spread before overriding ONLY the two executor
// functions, so every other export stays genuine for the rest of the process.
// mock.module is process-global; the earlier dice file's registration is what
// this file would otherwise inherit, and a LATER re-registration never
// retroactively changes references dice already captured. The orchestrator is
// dynamic-imported AFTER registration so it resolves THESE mocks.
// ChatRuntime / ChatApplicationService / createRuntimeStore / RegexHookService
// do not import the executors, so they remain safe to import statically.
// ════════════════════════════════════════════════════════════════════════════

const AI_REPLY_TEXT = "<think>quiet planning</think>Some **bold** text.";

// ── Safe mock.module: capture real executor exports BEFORE registering ──────
const realNonstreaming = await import("../src/infrastructure/ai/nonstreaming-provider-executor.js");
const realStream = await import("../src/infrastructure/ai/stream-provider-executor.js");
// Capture the FUNCTIONS, not the module objects: bun's mock.module MUTATES the
// real module's export slots at registration, so `realNonstreaming.<fn>` read
// later resolves to our own stub (sync infinite recursion). The dice file
// already uses this pattern.
const realNonstreamingExecute = realNonstreaming.nonstreamingProviderExecute;
const realStreamExecute = realStream.streamProviderExecutor;

// Leak guard: mock.module is PROCESS-GLOBAL and LAST registration wins — without
// this flag, every test file sorted after this one that imports the executors
// would receive this stub instead of the real implementation (observed with
// ST-6's stt-voice-executor tests). Once this file's tests finish, delegate
// calls through to the captured REAL functions so later files exercise real code.
let delegateExecutorsToReal = false;

mock.module("../src/infrastructure/ai/nonstreaming-provider-executor.js", () => ({
  ...realNonstreaming,
  nonstreamingProviderExecute: (input: Parameters<typeof realNonstreamingExecute>[0]) => {
    if (delegateExecutorsToReal) return realNonstreamingExecute(input);
    return Promise.resolve({
      text: AI_REPLY_TEXT,
      providerResponse: { mode: "nonstream" as const, steps: [] },
    });
  },
}));

mock.module("../src/infrastructure/ai/stream-provider-executor.js", () => ({
  ...realStream,
  streamProviderExecutor: (input: Parameters<typeof realStreamExecute>[0]) => {
    if (delegateExecutorsToReal) return realStreamExecute(input);
    return Promise.resolve({
      stream: (async function* () {
        yield { type: "text-delta" as const, delta: AI_REPLY_TEXT };
      })(),
      finished: Promise.resolve({ finishReason: "stop" as const }),
      text: Promise.resolve(AI_REPLY_TEXT),
      reasoning: Promise.resolve(undefined),
      hasRedactedReasoning: false,
      providerResponse: { mode: "stream" as const, steps: [] },
    });
  },
}));

// Dynamic import AFTER mock registration so the orchestrator resolves mocks.
const { LiveChatOrchestrator } = await import("../src/domain/chat/live-chat-orchestrator.js");

// ── Test harness (mirrors dice-send-stream-nonstream.test.ts) ───────────────

const tmpDirs: string[] = [];

interface TestChat {
  stores: Awaited<ReturnType<typeof createRuntimeStore>>;
  chatApp: ChatApplicationService;
  chatId: ChatId;
  branchId: string;
  characterId: string;
}

async function setup(characterName = "RegexProbe"): Promise<TestChat> {
  const tmpDir = resolve(tmpdir(), "vt-rx8-" + crypto.randomUUID().slice(0, 8));
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
    title: "RX-8 test",
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

afterAll(async () => {
  // Arm the leak guard for every test file that runs after this one in the
  // same process (see comment at delegateExecutorsToReal).
  delegateExecutorsToReal = true;
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Minimal valid `ChatModeAssembleResult` for the fake `assemblePrompt`. The
 *  promptTraceDraft is consumed by appendAssistantReply on the successful-send
 *  paths this file exercises. */
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

/** Harness bundle: real ChatRuntime over real stores, with the fake assemble
 *  boundary CAPTURING the last user message content as the prompt-assembly
 *  layer would see it (prepareLiveTurn inserts the user message before the
 *  assembler runs — pinned by dice-send-stream-nonstream case (d)). */
interface Harness {
  orch: InstanceType<typeof LiveChatOrchestrator>;
  assembledUserContent: () => string | null;
}

function makeHarness(chat: TestChat): Harness {
  let lastAssembledUserContent: string | null = null;
  const rt = new ChatRuntime({
    chats: chat.stores.chats,
    messages: chat.stores.messages,
    traces: chat.stores.traces,
    chatApp: chat.chatApp,
    diceRolls: chat.stores.diceRolls,
    uiSettings: chat.stores.uiSettings,
    experiences: chat.stores.experiences,
    assemblePrompt: async () => {
      const msgs = await chat.stores.messages.getMessages(chat.branchId);
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      lastAssembledUserContent = lastUser?.content ?? null;
      return fakeAssembleResult(chat.chatId as string, chat.branchId);
    },
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

  // `null as never` for the unused ProviderOrchestrator mirrors the
  // dice-send-stream-nonstream.ts harness this file copies.
  const orch = new LiveChatOrchestrator(
    rt,
    chat.chatApp,
    null as never,
    new EventBus(),
    async () => fakeStrategy,
    undefined,
    new RegexHookService(chat.stores).createHooks(),
  );

  return { orch, assembledUserContent: () => lastAssembledUserContent };
}

/** Minimal passthrough profile (same shape as the dice harness TEST_PROFILE). */
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
    placement: [REGEX_PLACEMENT.UserInput],
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

async function drain(gen: AsyncGenerator<{ event: string; data: string }>): Promise<Array<{ event: string; data: string }>> {
  const events: Array<{ event: string; data: string }> = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ════════════════════════════════════════════════════════════════════════════

describe("RX-8 regex hooks — persist-mode USER_INPUT", () => {
  it("non-stream: character-bound persist preset transforms stored user message AND assembly input", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "ok→OK",
      findRegex: "/\\bok\\b/g",
      replaceString: "OK",
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const { orch, assembledUserContent } = makeHarness(chat);

    const result = await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "is ok fine?",
      profile: TEST_PROFILE,
      model: "test-model",
    });

    const stored = await lastMessage(chat, "user");
    expect(stored.content).toBe("is OK fine?");
    // The prompt-assembly boundary saw the SAME transformed text (it reads the
    // just-inserted user message — the single prepareLiveTurn input).
    expect(assembledUserContent()).toBe("is OK fine?");
    // USER_INPUT-only placement: the reply passes through untouched.
    expect(result.reply).toBe("Some **bold** text.");
  });

  it("stream: same transform on the stream send path", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "ok→OK",
      findRegex: "/\\bok\\b/g",
      replaceString: "OK",
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const { orch } = makeHarness(chat);

    await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "is ok fine?",
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    const stored = await lastMessage(chat, "user");
    expect(stored.content).toBe("is OK fine?");
  });
});

describe("RX-8 regex hooks — persist-mode AI_OUTPUT", () => {
  it("non-stream: appended reply stored transformed (markdown ** stripped; <think> already split by extractThinkingTags)", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "strip bold",
      findRegex: "/\\*\\*(.+?)\\*\\*/g",
      replaceString: "$1",
      placement: [REGEX_PLACEMENT.AiOutput],
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const { orch } = makeHarness(chat);

    const result = await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    });

    const stored = await lastMessage(chat, "assistant");
    expect(stored.content).toBe("Some bold text.");
    expect(result.reply).toBe("Some bold text.");
  });

  it("stream: raw deltas stream UNTRANSFORMED, final stored message transformed (ST parity)", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "strip bold",
      findRegex: "/\\*\\*(.+?)\\*\\*/g",
      replaceString: "$1",
      placement: [REGEX_PLACEMENT.AiOutput],
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const { orch } = makeHarness(chat);

    const events = await drain(orch.sendMessageStream({
      chatId: chat.chatId as string,
      content: "hello",
      profile: TEST_PROFILE,
      model: "test-model",
    }));

    // The deltas carry the RAW provider text — the transform lands only on the
    // finalized message (how ST behaves: watch the raw stream, get the rewrite).
    const deltas = events
      .filter((ev) => ev.event === "text-delta")
      .map((ev) => (JSON.parse(ev.data) as { delta: string }).delta)
      .join("");
    expect(deltas).toContain("**bold**");

    const stored = await lastMessage(chat, "assistant");
    expect(stored.content).toBe("Some bold text.");
    const finish = events.find((ev) => ev.event === "finish");
    expect(finish).toBeDefined();
  });
});

describe("RX-8 regex hooks — non-persist modes are no-ops at this seam", () => {
  it("display-only (markdownOnly) preset: stored user message AND stored reply stay original (both paths)", async () => {
    // Non-stream
    const ns = await setup();
    const nsPreset = await ns.stores.regex.create(presetInput({
      name: "display-only both roles",
      findRegex: "/\\bok\\b|\\*\\*/g",
      replaceString: "X",
      markdownOnly: true,
      placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.AiOutput],
    }));
    await ns.stores.regex.addLink(nsPreset.id, REGEX_TARGET_TYPE.Character, ns.characterId);
    const nsH = makeHarness(ns);
    await nsH.orch.sendMessage({
      chatId: ns.chatId as string,
      content: "is ok fine?",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect((await lastMessage(ns, "user")).content).toBe("is ok fine?");
    expect((await lastMessage(ns, "assistant")).content).toBe("Some **bold** text.");

    // Stream — fresh chat for isolation.
    const s = await setup();
    const sPreset = await s.stores.regex.create(presetInput({
      name: "display-only both roles",
      findRegex: "/\\bok\\b|\\*\\*/g",
      replaceString: "X",
      markdownOnly: true,
      placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.AiOutput],
    }));
    await s.stores.regex.addLink(sPreset.id, REGEX_TARGET_TYPE.Character, s.characterId);
    const sH = makeHarness(s);
    await drain(sH.orch.sendMessageStream({
      chatId: s.chatId as string,
      content: "is ok fine?",
      profile: TEST_PROFILE,
      model: "test-model",
    }));
    expect((await lastMessage(s, "user")).content).toBe("is ok fine?");
    expect((await lastMessage(s, "assistant")).content).toBe("Some **bold** text.");
  });
});

describe("RX-8 regex hooks — degradation cases", () => {
  it("disabled preset: no-op", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "disabled ok→OK",
      findRegex: "/\\bok\\b/g",
      replaceString: "OK",
      disabled: true,
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const { orch } = makeHarness(chat);

    await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "is ok fine?",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect((await lastMessage(chat, "user")).content).toBe("is ok fine?");
  });

  it("preset bound to a DIFFERENT character: no-op", async () => {
    const chat = await setup();
    const other = await chat.stores.characters.create({ name: "OtherChar", firstMessage: "Hi!" });
    const preset = await chat.stores.regex.create(presetInput({
      name: "ok→OK for someone else",
      findRegex: "/\\bok\\b/g",
      replaceString: "OK",
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, other.id);
    const { orch } = makeHarness(chat);

    await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "is ok fine?",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect((await lastMessage(chat, "user")).content).toBe("is ok fine?");
  });

  it("invalid find pattern: preset skipped, send still succeeds", async () => {
    const chat = await setup();
    const preset = await chat.stores.regex.create(presetInput({
      name: "broken pattern",
      findRegex: "/([/g",
      replaceString: "OK",
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const { orch } = makeHarness(chat);

    const result = await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "is ok fine?",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect((await lastMessage(chat, "user")).content).toBe("is ok fine?");
    expect(result.reply).toBe("Some **bold** text.");
  });
});

describe("RX-8 regex hooks — macro source wiring", () => {
  it("substituteRegex RAW resolves {{char}} in the find pattern from the chat's character", async () => {
    const chat = await setup("MacroHero");
    const preset = await chat.stores.regex.create(presetInput({
      name: "{{char}} → HERO",
      findRegex: "/{{char}}/g",
      replaceString: "HERO",
      substituteRegex: REGEX_SUBSTITUTE.Raw,
    }));
    await chat.stores.regex.addLink(preset.id, REGEX_TARGET_TYPE.Character, chat.characterId);
    const { orch } = makeHarness(chat);

    await orch.sendMessage({
      chatId: chat.chatId as string,
      content: "MacroHero enters the tavern",
      profile: TEST_PROFILE,
      model: "test-model",
    });
    expect((await lastMessage(chat, "user")).content).toBe("HERO enters the tavern");
  });
});
