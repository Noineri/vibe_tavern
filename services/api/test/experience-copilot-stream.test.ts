import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import type { LanguageModel } from "ai";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ExperienceCopilotMessage,
  AppendMessageInput,
} from "@vibe-tavern/db";
import type { ProviderProfile, ScriptRow, ExperienceVisualRow } from "@vibe-tavern/db";

// ─── Mock streamText before importing the module under test ──────────────────
//
// The safe mock.module pattern (see AGENTS.md gotcha): capture the REAL module
// first via `await import`, then spread `...real` in the factory so every other
// export stays intact for any other test file in the same `bun test` process.
// `streamText` delegates to a mutable `streamTextImpl` that defaults to the real
// implementation and is overridden per-test then restored in afterEach.
const real = await import("ai");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let streamTextImpl: any = real.streamText;
mock.module("ai", () => ({
  ...real,
  streamText: (opts: unknown) => streamTextImpl(opts),
}));

const { streamExperienceCopilot } = await import(
  "../src/domain/interactive/copilot/experience-copilot-stream.js"
);
import type {
  ExperienceCopilotStreamDeps,
  ExperienceCopilotStreamEvent,
} from "../src/domain/interactive/copilot/experience-copilot-stream.js";

// ─── Fake store ──────────────────────────────────────────────────────────────

function createFakeStore(
  thread: ExperienceCopilotThread,
): ExperienceCopilotStore & { messages: ExperienceCopilotMessage[] } {
  const messages: ExperienceCopilotMessage[] = [];
  let counter = 0;
  const now = () => new Date(Date.now() + counter++ * 1000).toISOString();
  return {
    messages,
    async getActive() { return null; },
    async getById() { return thread; },
    async listSessions() { return [thread]; },
    async startNewSession() { return thread; },
    async activate() { return thread; },
    async archive() { return thread; },
    async listMessages() { return [...messages]; },
    async appendMessage(_threadId: string, input: AppendMessageInput) {
      const msg: ExperienceCopilotMessage = {
        id: `msg_${counter++}`,
        threadId: thread.id,
        role: input.role,
        content: input.content ?? "",
        toolCallsJson: input.toolCallsJson ?? null,
        toolCallId: input.toolCallId ?? null,
        createdAt: now(),
      };
      messages.push(msg);
      return msg;
    },
  } as unknown as ExperienceCopilotStore & { messages: ExperienceCopilotMessage[] };
}

// ─── Fake streamText result ──────────────────────────────────────────────────
//
// Feeds fullStream parts directly (the format `createMappedStream` consumes),
// bypassing the V3-model conversion layer. This is the same part shape the
// stream-helpers test uses.

interface FakeStreamOptions {
  /** FullStream parts to emit. */
  parts?: unknown[];
  /** When set, the stream throws this error during iteration. */
  throwDuringStream?: Error;
  /** Finish reason resolved by `mapFinish`. */
  finishReason?: string;
}

function makeFakeStreamTextResult(opts: FakeStreamOptions): Record<string, unknown> {
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    if (opts.throwDuringStream) throw opts.throwDuringStream;
    for (const p of opts.parts ?? []) yield p;
  }
  return {
    stream: gen(),
    finishReason: Promise.resolve(opts.finishReason ?? "stop"),
    usage: Promise.resolve(undefined),
  };
}

// ─── Fake deps ───────────────────────────────────────────────────────────────

function makeProfile(id = "prov_1"): ProviderProfile {
  return {
    id,
    name: "Test",
    providerPreset: "openai",
    coauthorTransport: "chatCompletions",
    endpoint: "http://test",
    apiKey: "key",
    defaultModel: "test-model",
    contextBudget: null,
    pinContextBudget: false,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 2000,
    temperature: 0.3,
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
    drySequenceBreakers: null,
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    stopSequences: [],
    logitBias: null,
    seed: null,
    reasoningEffort: "auto",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    proxyMode: "inherit",
    proxyId: null,
    isActive: true,
    visionModel: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  } as ProviderProfile;
}

function makeDeps(
  store: ExperienceCopilotStore,
  overrides: Partial<ExperienceCopilotStreamDeps> = {},
): ExperienceCopilotStreamDeps {
  const profile = makeProfile();
  return {
    store,
    getScript: async () => null,
    getBoundVisualIds: async () => [],
    getVisual: async () => null,
    getProviderProfile: async () => profile,
    getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    ...overrides,
  };
}

function makeThread(scriptId: string | null = null): ExperienceCopilotThread {
  return {
    id: "thread_1",
    scriptId,
    draftSessionId: null,
    title: "Test thread",
    archivedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

async function collect(
  stream: AsyncGenerator<ExperienceCopilotStreamEvent>,
): Promise<Array<{ event: string; data: unknown }>> {
  const events: Array<{ event: string; data: unknown }> = [];
  for await (const chunk of stream) {
    events.push({ event: chunk.event, data: JSON.parse(chunk.data) });
  }
  return events;
}

// ─── FullStream part builders (the shape createMappedStream consumes) ────────

const textDelta = (text: string) => ({ type: "text-delta", text });
const toolCall = (toolCallId: string, toolName: string, args: Record<string, unknown>) =>
  ({ type: "tool-call", toolCallId, toolName, input: args });
const toolResult = (toolCallId: string, toolName: string, output: unknown) =>
  ({ type: "tool-result", toolCallId, toolName, output });

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("experience-copilot stream (ER-6)", () => {
  beforeEach(() => {
    streamTextImpl = real.streamText;
  });
  afterEach(() => {
    streamTextImpl = real.streamText;
  });

  it("emits text-delta + finish for a plain text turn", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [textDelta("Hello "), textDelta("copilot!")],
      });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const textDeltas = events.filter((e) => e.event === "text-delta");
    expect(textDeltas.map((e) => (e.data as { delta: string }).delta).join("")).toBe("Hello copilot!");

    const finish = events.find((e) => e.event === "finish");
    expect(finish).toBeDefined();
    expect((finish!.data as { finishReason: string }).finishReason).toBe("stop");
    expect((finish!.data as { modelId: string }).modelId).toBe("test-model");

    // The turn is persisted: 1 user message + 1 assistant text message.
    expect(store.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(store.messages[1].content).toBe("Hello copilot!");
  });

  it("emits tool-call + tool-result when the model calls a tool", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [
          textDelta("I recommend a visual."),
          toolCall("tc_1", "suggest_visual_binding", { reason: "add a dice roller" }),
          toolResult("tc_1", "suggest_visual_binding", { reason: "add a dice roller" }),
        ],
      });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "help me", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const toolCallEvt = events.find((e) => e.event === "tool-call");
    expect(toolCallEvt).toBeDefined();
    expect((toolCallEvt!.data as { toolName: string }).toolName).toBe("suggest_visual_binding");
    expect((toolCallEvt!.data as { toolCallId: string }).toolCallId).toBe("tc_1");
    expect((toolCallEvt!.data as { args: { reason: string } }).args.reason).toBe("add a dice roller");

    const toolResultEvt = events.find((e) => e.event === "tool-result");
    expect(toolResultEvt).toBeDefined();
    expect((toolResultEvt!.data as { toolCallId: string }).toolCallId).toBe("tc_1");

    const finish = events.find((e) => e.event === "finish");
    expect(finish).toBeDefined();

    // Persisted: user + assistant(toolCalls) + tool(result) + assistant(text).
    const roles = store.messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("tool");
    expect(roles.filter((r) => r === "assistant").length).toBeGreaterThanOrEqual(1);
  });

  it("emits an error event when the provider fails mid-stream", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        throwDuringStream: new Error("provider down"),
      });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const error = events.find((e) => e.event === "error");
    expect(error).toBeDefined();
    expect((error!.data as { message: string }).message).toContain("provider down");

    // The user message was persisted before the stream started (survives the crash).
    expect(store.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("loads rules/visual context from thread.scriptId and completes", async () => {
    const script: ScriptRow = {
      id: "script_1",
      name: "Dice",
      description: "",
      code: "context.experience.register({ manifest: { id: 'dice', name: 'Dice' } });",
      enabled: true,
      scriptKind: "interactive",
      creationIntentId: null,
      scopeType: "global",
      sortOrder: 0,
      characterId: null,
      personaId: null,
      chatId: null,
      defaultVisualId: "vis_1",
      extensions: {},
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const visual: ExperienceVisualRow = {
      id: "vis_1",
      name: "Dice Visual",
      source: "<html>visual</html>",
      sourceHash: "hash",
      apiVersion: 1,
      compatibleManifestIds: [],
      scopeType: "global",
      characterId: null,
      personaId: null,
      chatId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const store = createFakeStore(makeThread("script_1"));
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [textDelta("Got it.")],
      });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "show me rules", providerProfileId: "prov_1" },
        makeDeps(store, {
          getScript: async (id) => (id === "script_1" ? script : null),
          getBoundVisualIds: async () => ["vis_1"],
          getVisual: async (id) => (id === "vis_1" ? visual : null),
        }),
      ),
    );

    const finish = events.find((e) => e.event === "finish");
    expect(finish).toBeDefined();
    expect((finish!.data as { finishReason: string }).finishReason).toBe("stop");
  });

  it("prefers the live request draft (rules/visual) over the persisted DB context", async () => {
    // The DB holds stale buffers; the editor sends the current unsaved draft.
    // The copilot must see the DRAFT (what the user sees), not the DB copy —
    // otherwise it is blind to in-progress edits and the buffer the user
    // switched to (root cause of 'the model doesn't see my visual').
    const script: ScriptRow = {
      id: "script_1", name: "Dice", description: "",
      code: "DB RULES BODY", enabled: true, scriptKind: "interactive",
      creationIntentId: null, scopeType: "global", sortOrder: 0,
      characterId: null, personaId: null, chatId: null, defaultVisualId: "vis_1",
      extensions: {}, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const visual: ExperienceVisualRow = {
      id: "vis_1", name: "Dice Visual", source: "DB VISUAL BODY", sourceHash: "hash",
      apiVersion: 1, compatibleManifestIds: [], scopeType: "global",
      characterId: null, personaId: null, chatId: null,
      createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const store = createFakeStore(makeThread("script_1"));
    // Capture the full streamText opts; the system context + tool seeds both
    // derive from the chosen buffers, so the draft must appear and the DB body
    // must not, anywhere in the payload sent to the model.
    let captured: unknown = null;
    streamTextImpl = (opts: unknown) => {
      captured = opts;
      return makeFakeStreamTextResult({ parts: [textDelta("ok")] });
    };

    await collect(
      streamExperienceCopilot(
        {
          threadId: "thread_1", content: "tweak the visual", providerProfileId: "prov_1",
          step: "visual", rules: "DRAFT RULES BODY", visual: "DRAFT VISUAL BODY",
        },
        makeDeps(store, {
          getScript: async (id) => (id === "script_1" ? script : null),
          getBoundVisualIds: async () => ["vis_1"],
          getVisual: async (id) => (id === "vis_1" ? visual : null),
        }),
      ),
    );

    const blob = JSON.stringify(captured);
    expect(blob).toContain("DRAFT RULES BODY");
    expect(blob).toContain("DRAFT VISUAL BODY");
    expect(blob).not.toContain("DB RULES BODY");
    expect(blob).not.toContain("DB VISUAL BODY");
  });

  it("round-trips tool-call/tool-result history across turns", async () => {
    const store = createFakeStore(makeThread());

    // Turn 1: model calls a tool + produces text.
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [
          toolCall("tc_a", "suggest_visual_binding", { reason: "first turn" }),
          toolResult("tc_a", "suggest_visual_binding", { reason: "first turn" }),
          textDelta("Done."),
        ],
      });
    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "turn 1", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // Turn 2: history reloads (storeMessagesToHistory round-trips tool calls/results).
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [textDelta("Second turn.")],
      });
    const events2 = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "turn 2", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );
    const finish2 = events2.find((e) => e.event === "finish");
    expect(finish2).toBeDefined();

    // Both turns persisted: each has a user message.
    const userMessages = store.messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.content)).toEqual(["turn 1", "turn 2"]);
    // The tool result from turn 1 is in history (role "tool").
    expect(store.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("emits reasoning-delta when the model reasons", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [
          ({ type: "reasoning-delta", delta: "thinking..." }),
          textDelta("answer"),
        ],
      });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const reasoning = events.filter((e) => e.event === "reasoning-delta");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0].data as { delta: string }).delta).toBe("thinking...");

    const finish = events.find((e) => e.event === "finish");
    expect(finish).toBeDefined();
  });
});
