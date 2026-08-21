import { describe, expect, it, beforeEach } from "bun:test";
import type { LanguageModel } from "ai";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ExperienceCopilotMessage,
  AppendMessageInput,
} from "@vibe-tavern/db";
import type { ProviderProfile, ScriptRow, ExperienceVisualRow } from "@vibe-tavern/db";

import { streamExperienceCopilot } from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import {
  COPILOT_CONTEXT_BUDGET_TOKENS,
  COPILOT_RESPONSE_RESERVE_TOKENS,
  COPILOT_TOOL_LOOP_CEILING,
} from "../src/domain/interactive/copilot/copilot-limits.js";
import type {
  ExperienceCopilotStreamDeps,
  ExperienceCopilotStreamEvent,
} from "../src/domain/interactive/copilot/experience-copilot-stream.js";

// ─── Fake streamText (injected via deps; no mock.module) ─────────────────────
//
// `mock.module("ai", …)` under bun:test is process-global AND permanent:
// neither `mock.restore()` nor re-registering a real-returning factory undoes
// it (verified with a two-file experiment). Its `streamText` override leaked
// into later files and hung `provider-proxy-traversal`'s real AI SDK test.
// `streamText` is now a deps field that defaults to the real one (see
// ExperienceCopilotStreamDeps.streamText); each test sets `streamTextImpl`
// here and makeDeps injects it. `undefined` → production uses the real function.
let streamTextImpl: ((opts: unknown) => unknown) | undefined;

// ─── Fake store ──────────────────────────────────────────────────────────────

function createFakeStore(
  thread: ExperienceCopilotThread,
): ExperienceCopilotStore & { messages: ExperienceCopilotMessage[]; metricsCalls: Array<{ threadId: string; metrics: unknown; providerProfileId: string; model: string }>; todoCalls: Array<{ threadId: string; items: unknown }> } {
  const messages: ExperienceCopilotMessage[] = [];
  const metricsCalls: Array<{ threadId: string; metrics: unknown; providerProfileId: string; model: string }> = [];
  const todoCalls: Array<{ threadId: string; items: unknown }> = [];
  let counter = 0;
  const now = () => new Date(Date.now() + counter++ * 1000).toISOString();
  return {
    messages,
    metricsCalls,
    todoCalls,
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
    async updateContextMetrics(threadId: string, metrics: unknown, providerProfileId: string, model: string) {
      metricsCalls.push({ threadId, metrics, providerProfileId, model });
    },
    async getAutoCompact() { return true; },
    async setAutoCompact() {},
    // TAG-6: the todo tool's full-list rewrite persists onto the thread row.
    // The fake mirrors the real store: records the call AND mutates the in-
    // memory thread's todo so the NEXT turn's `getById` (this same thread
    // object) already carries the plan — the session-scoped lifetime behavior.
    async updateTodo(threadId: string, items: readonly { title: string; status: string }[]) {
      todoCalls.push({ threadId, items });
      thread.todo = items as ExperienceCopilotThread["todo"];
    },
    // TAG-5: the fake mirrors the real store's semantics — rewrite the ONE
    // tool row matching threadId+toolCallId (threadId ignored in the fake; one
    // thread per test), null when no row matches.
    async setToolResultOutput(
      _threadId: string,
      toolCallId: string,
      payload: { toolName: string; output: unknown },
    ) {
      const row = messages.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
      if (!row) return null;
      row.content = JSON.stringify(payload);
      return row;
    },
  } as unknown as ExperienceCopilotStore & { messages: ExperienceCopilotMessage[]; metricsCalls: Array<{ threadId: string; metrics: unknown; providerProfileId: string; model: string }>; todoCalls: Array<{ threadId: string; items: unknown }> };
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
  /** Provider usage resolved by `mapFinish` (undefined → no usage reported). */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

function makeFakeStreamTextResult(opts: FakeStreamOptions): Record<string, unknown> {
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    if (opts.throwDuringStream) throw opts.throwDuringStream;
    for (const p of opts.parts ?? []) yield p;
  }
  return {
    stream: gen(),
    finishReason: Promise.resolve(opts.finishReason ?? "stop"),
    usage: Promise.resolve(opts.usage),
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
    // Inject the per-test fake; undefined falls through to the real streamText
    // (the deps default). Cast at this type-erased seam: the fake returns a
    // partial FullStream shape (see makeFakeStreamTextResult), not the SDK's
    // full StreamTextResult, but production only reads `.stream`.
    streamText: streamTextImpl as unknown as ExperienceCopilotStreamDeps["streamText"],
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
    contextMetrics: null,
    contextLinks: [],
    todo: [],
    lastProviderProfileId: null,
    lastModel: null,
    autoCompact: true,
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
    streamTextImpl = undefined;
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

  it("uses copilot-owned budget/reserve regardless of the RP profile (A-lite, 2026-08-17)", async () => {
    // The profile carries chat-RP numbers (a fresh profile defaults to a 16k
    // budget — smaller than the copilot's own system message). The copilot must
    // assemble and report metrics against ITS fixed limits, not these.
    const rpProfile = { ...makeProfile(), contextBudget: 16000, maxTokens: 2000 };
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({ parts: [textDelta("ok")] });

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, {
          getProviderProfile: async () => rpProfile,
          getEffectiveProviderProfile: async () => rpProfile,
        }),
      ),
    );

    expect(store.metricsCalls).toHaveLength(1);
    const metrics = store.metricsCalls[0].metrics as {
      budgetTokens: number;
      reserveTokens: number;
    };
    expect(metrics.budgetTokens).toBe(COPILOT_CONTEXT_BUDGET_TOKENS);
    expect(metrics.reserveTokens).toBe(COPILOT_RESPONSE_RESERVE_TOKENS);
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

  it("persists a multi-step turn in arrival order: text → tool-call → tool-result → text (TF-3)", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [
          textDelta("Let me read the skill first."),
          toolCall("tc_1", "read_skill_file", { path: "visual.md" }),
          toolResult("tc_1", "read_skill_file", { path: "visual.md", content: "…" }),
          textDelta("Now writing the buffer."),
          toolCall("tc_2", "write_buffer", { target: "visual", source: "<html>" }),
          toolResult("tc_2", "write_buffer", { summary: "wrote", target: "visual", proposed: "<html>" }),
          textDelta("Done."),
        ],
      });

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "build a dice roller", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // The stored rows preserve the model's real sequence — the old
    // accumulator flattened this into one toolCalls row + all tool rows + ONE
    // final text row, losing the interleaving.
    const shape = store.messages.map((m) => ({
      role: m.role,
      content: m.role === "assistant" && m.toolCallsJson ? null : m.content,
      toolCallId: m.toolCallId,
      toolCallIds: m.toolCallsJson
        ? (JSON.parse(m.toolCallsJson) as Array<{ toolCallId: string }>).map((tc) => tc.toolCallId)
        : null,
    }));
    expect(shape).toEqual([
      { role: "user", content: "build a dice roller", toolCallId: null, toolCallIds: null },
      { role: "assistant", content: "Let me read the skill first.", toolCallId: null, toolCallIds: null },
      { role: "assistant", content: null, toolCallId: null, toolCallIds: ["tc_1"] },
      { role: "tool", content: expect.stringContaining("read_skill_file"), toolCallId: "tc_1", toolCallIds: null },
      { role: "assistant", content: "Now writing the buffer.", toolCallId: null, toolCallIds: null },
      { role: "assistant", content: null, toolCallId: null, toolCallIds: ["tc_2"] },
      { role: "tool", content: expect.stringContaining("write_buffer"), toolCallId: "tc_2", toolCallIds: null },
      { role: "assistant", content: "Done.", toolCallId: null, toolCallIds: null },
    ]);
  });

  it("groups a run of consecutive tool calls into ONE assistant toolCalls row (TF-3)", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [
          toolCall("tc_1", "read_skill_file", { path: "a.md" }),
          toolCall("tc_2", "read_skill_file", { path: "b.md" }),
          toolResult("tc_1", "read_skill_file", { path: "a.md", content: "…" }),
          toolResult("tc_2", "read_skill_file", { path: "b.md", content: "…" }),
        ],
      });

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "read two files", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // Parallel calls in one step share a single assistant row (same shape the
    // legacy accumulator produced), then one tool row per result in order.
    const assistantToolRows = store.messages.filter((m) => m.role === "assistant" && m.toolCallsJson);
    expect(assistantToolRows).toHaveLength(1);
    const ids = (JSON.parse(assistantToolRows[0].toolCallsJson!) as Array<{ toolCallId: string }>).map(
      (tc) => tc.toolCallId,
    );
    expect(ids).toEqual(["tc_1", "tc_2"]);
    expect(store.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["tc_1", "tc_2"]);
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

  it("honors a resolved profile's base prompt and toolSet (CP-7)", async () => {
    const store = createFakeStore(makeThread());
    const customProfile: CopilotProfile = {
      id: "custom",
      name: "Custom",
      isBuiltIn: false,
      basePrompt: "CUSTOM STREAM PROMPT MARKER",
      skillIds: [],
      toolSet: { run_test: true },
    };
    let captured: Record<string, unknown> | null = null;
    streamTextImpl = (opts: unknown) => {
      captured = opts as Record<string, unknown>;
      return makeFakeStreamTextResult({ parts: [textDelta("ok")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, { resolveProfile: async () => customProfile }),
      ),
    );

    expect(captured).toBeTruthy();
    // The system message carries the profile's base prompt (not the built-in's).
    const system = (captured!.messages as Array<{ role: string; content: string }>)[0];
    expect(system.content).toContain("CUSTOM STREAM PROMPT MARKER");
    // Only run_test + always-on read_skill_file survive the gated toolSet.
    const toolKeys = Object.keys(captured!.tools as Record<string, unknown>).sort();
    expect(toolKeys).toEqual(["read_skill_file", "run_test"]);
    // TAG-4/TAG-5: the profile no longer supplies maxSteps — the loop is bound
    // by the nominal COPILOT_TOOL_LOOP_CEILING (a small step count no longer
    // stops it). TAG-5 made stopWhen an ARRAY (ceiling + the ask_user
    // split-turn stop); the step-count condition is the FIRST entry.
    const stopWhen = captured!.stopWhen as Array<(r: { steps: unknown[] }) => boolean>;
    expect(Array.isArray(stopWhen)).toBe(true);
    expect(stopWhen[0]({ steps: [1, 2, 3, 4, 5] })).toBe(false);
    expect(stopWhen[0]({ steps: new Array(COPILOT_TOOL_LOOP_CEILING) })).toBe(true);
    expect(stopWhen[0]({ steps: new Array(COPILOT_TOOL_LOOP_CEILING - 1) })).toBe(false);
  });
});

describe("experience-copilot stream — context metrics (CM-4)", () => {
  it("finish carries estimate-sourced metrics and persists them with the provider/model", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({ parts: [textDelta("hi")] }); // no usage → estimate source

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const finish = events.find((e) => e.event === "finish");
    expect(finish).toBeDefined();
    const data = finish!.data as { metrics: Record<string, unknown> };
    expect(data.metrics).toBeDefined();
    expect(data.metrics.source).toBe("estimate");
    expect(typeof data.metrics.totalTokens).toBe("number");

    // Persisted exactly once, with the request's provider/model.
    expect(store.metricsCalls).toHaveLength(1);
    expect(store.metricsCalls[0].threadId).toBe("thread_1");
    expect(store.metricsCalls[0].providerProfileId).toBe("prov_1");
    expect(store.metricsCalls[0].model).toBe("test-model");
    expect(store.metricsCalls[0].metrics).toEqual(data.metrics);
  });

  it("prefers the provider's usage.inputTokens as totalTokens with source: provider", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [textDelta("hi")],
        usage: { inputTokens: 1234, outputTokens: 50, totalTokens: 1284 },
      });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const finish = events.find((e) => e.event === "finish");
    const data = finish!.data as { metrics: { source: string; totalTokens: number; budgetTokens: number; reserveTokens: number } };
    expect(data.metrics.source).toBe("provider");
    expect(data.metrics.totalTokens).toBe(1234);
    // Per-segment values remain the assembler's estimate; budget/reserve are
    // the copilot's FIXED limits (A-lite, 2026-08-17) — the RP profile's
    // contextBudget/maxTokens no longer flow into copilot metrics.
    expect(data.metrics.budgetTokens).toBe(COPILOT_CONTEXT_BUDGET_TOKENS);
    expect(data.metrics.reserveTokens).toBe(COPILOT_RESPONSE_RESERVE_TOKENS);
  });

  it("multi-step tool turn: totalTokens = the LAST step's input, not the summed aggregate usage", async () => {
    // Regression: a 3-step tool turn re-sends the whole context per step; the
    // SDK's aggregate usage.inputTokens SUMS steps (3 × ~63k ≈ 190k against a
    // 100k budget → false 190% urgency). The true final context is the LAST
    // step's input.
    const store = createFakeStore(makeThread());
    // Feed finish-step parts through the REAL createMappedStream so the trace
    // state collects per-step usage exactly as production does.
    streamTextImpl = () => makeFakeStreamTextResult({
      parts: [
        textDelta("hi"),
        { type: "start-step" },
        { type: "finish-step", response: {}, usage: { inputTokens: 63000, outputTokens: 500, totalTokens: 63500 }, finishReason: "tool-calls" },
        { type: "start-step" },
        { type: "finish-step", response: {}, usage: { inputTokens: 64100, outputTokens: 400, totalTokens: 64500 }, finishReason: "tool-calls" },
        { type: "start-step" },
        { type: "finish-step", response: {}, usage: { inputTokens: 64500, outputTokens: 300, totalTokens: 64800 }, finishReason: "stop" },
      ],
      // The aggregate the SDK resolves — the SUM across steps.
      usage: { inputTokens: 191600, outputTokens: 1200, totalTokens: 192800 },
    });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const finish = events.find((e) => e.event === "finish");
    const data = finish!.data as { metrics: { source: string; totalTokens: number } };
    expect(data.metrics.source).toBe("provider");
    expect(data.metrics.totalTokens).toBe(64500);
  });

  it("profile maxTokens -1 (\"model decides\") no longer affects the copilot's reserve — fixed, never negative", async () => {
    // Before A-lite the reserve was read from the profile and a -1 ("model
    // decides") had to be clamped to 0 so a negative reserve never leaked into
    // metrics. The copilot now owns its reserve outright; the -1 profile must
    // be irrelevant — the fixed reserve is always positive.
    const store = createFakeStore(makeThread());
    const profile = makeProfile();
    profile.maxTokens = -1;
    streamTextImpl = () => makeFakeStreamTextResult({ parts: [textDelta("hi")] });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, { getProviderProfile: async () => profile, getEffectiveProviderProfile: async () => profile }),
      ),
    );

    const finish = events.find((e) => e.event === "finish");
    const data = finish!.data as { metrics: { reserveTokens: number } };
    expect(data.metrics.reserveTokens).toBe(COPILOT_RESPONSE_RESERVE_TOKENS);
  });
});

describe("experience-copilot stream — digest pre-split + auto-compact (CM-5/CM-6)", () => {
  it("pre-splits history at the digest boundary: assembly sees digest + kept, never the covered prefix", async () => {
    const thread = makeThread();
    const store = createFakeStore(thread);

    // Seed prior messages: covered prefix (m1,m2) + digest (anchor=m3) + kept (m3,m4).
    store.messages.push(
      { id: "m1", threadId: thread.id, role: "user", content: "covered-1", toolCallsJson: null, toolCallId: null, createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "m2", threadId: thread.id, role: "assistant", content: "covered-2", toolCallsJson: null, toolCallId: null, createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "d1", threadId: thread.id, role: "digest", content: "the-summary", toolCallsJson: null, toolCallId: "m3", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "m3", threadId: thread.id, role: "user", content: "kept-1", toolCallsJson: null, toolCallId: null, createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "m4", threadId: thread.id, role: "assistant", content: "kept-2", toolCallsJson: null, toolCallId: null, createdAt: "2025-01-01T00:00:00.000Z" },
    );

    let capturedMessages: Array<{ role: string; content: string }> = [];
    streamTextImpl = (opts: { messages: Array<{ role: string; content: string }> }) => {
      capturedMessages = opts.messages;
      return makeFakeStreamTextResult({ parts: [textDelta("ok")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "new user msg", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // The system message carries the digest section.
    expect(capturedMessages[0].role).toBe("system");
    expect(capturedMessages[0].content).toContain("the-summary");

    // Non-system = kept window + the new user message, in order.
    expect(capturedMessages.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(capturedMessages.slice(1).map((m) => m.content)).toEqual(["kept-1", "kept-2", "new user msg"]);

    // The covered prefix never reaches the model window.
    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).not.toContain("covered-1");
    expect(serialized).not.toContain("covered-2");
  });

  it("fires the auto-compact trigger (fire-and-forget) after metrics are persisted", async () => {
    const store = createFakeStore(makeThread());
    const autoCompactCalls: string[] = [];
    streamTextImpl = () =>
      makeFakeStreamTextResult({ parts: [textDelta("hi")], usage: { inputTokens: 1234 } });

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, { autoCompact: async (threadId: string) => { autoCompactCalls.push(threadId); } }),
      ),
    );

    // Triggered exactly once with the thread id, AFTER metrics were persisted
    // (so the service reads fresh lastProviderProfileId/lastModel/contextMetrics).
    expect(autoCompactCalls).toEqual(["thread_1"]);
    expect(store.metricsCalls).toHaveLength(1);
  });
});

// ─── CX-3: attached-context resolution + metrics ─────────────────────────────

describe("experience-copilot stream — attached context (CX-3)", () => {
  it("pinned links resolve → attachedTokens > 0 in finish metrics; synth messages never persist", async () => {
    // This test needs NON-zero estimates (it asserts attachedTokens > 0), so it
    // installs a char-length counter for its duration. Restored in finally to
    // the unset-equivalent (fn returning 0): estimateTokens is process-global
    // under bun:test, and the rest of this file (and later files in the same
    // process) expects the unset behavior (0 estimates, as warned).
    const { setTokenCountFn } = await import("@vibe-tavern/prompt-pipeline");
    setTokenCountFn((text: string) => text.length);
    try {
    const thread = makeThread();
    thread.contextLinks = [
      { targetType: "character", targetId: "char_1" },
      { targetType: "skill", targetId: "my-skill" },
    ];
    const store = createFakeStore(thread);
    const resolvedLinks: unknown[] = [];
    streamTextImpl = () => makeFakeStreamTextResult({ parts: [textDelta("ok")] });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, {
          resolveContextItems: async (links) => {
            resolvedLinks.push(links);
            return [
              { type: "character", id: "char_1", title: "Alice", content: "alice profile" },
              { type: "skill", id: "my-skill", title: "My Skill", content: "# skill body" },
            ];
          },
        }),
      ),
    );

    // The resolver saw exactly the thread's links.
    expect(resolvedLinks).toHaveLength(1);
    expect(resolvedLinks[0]).toEqual(thread.contextLinks);

    const finish = events.find((e) => e.event === "finish");
    const metrics = (finish!.data as { metrics: Record<string, unknown> }).metrics;
    expect(metrics.attachedTokens).toBeGreaterThan(0);
    // Persisted metrics carry the same segment.
    expect(store.metricsCalls[0].metrics).toEqual(metrics);

    // ONLY the real trigger + assistant reply were stored — the attached block
    // and the recency anchor are transient model-window content, never rows.
    expect(store.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(store.messages[0].content).toBe("hi");
    } finally {
      setTokenCountFn(() => 0);
    }
  });

  it("zero links or absent resolver → attachedTokens 0 and the resolver is never called", async () => {
    const store = createFakeStore(makeThread()); // contextLinks: []
    let resolverCalls = 0;
    streamTextImpl = () => makeFakeStreamTextResult({ parts: [textDelta("ok")] });

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store, {
          resolveContextItems: async () => {
            resolverCalls++;
            return [];
          },
        }),
      ),
    );

    expect(resolverCalls).toBe(0); // short-circuited by the zero-link guard
    const events2 = store.metricsCalls[0].metrics as Record<string, unknown>;
    expect(events2.attachedTokens).toBe(0);
  });

  it("a resolver rejection fails the turn (bad store) — no silent context-free answer", async () => {
    const thread = makeThread();
    thread.contextLinks = [{ targetType: "character", targetId: "char_1" }];
    const store = createFakeStore(thread);
    streamTextImpl = () => makeFakeStreamTextResult({ parts: [textDelta("ok")] });

    let caught: unknown = null;
    try {
      await collect(
        streamExperienceCopilot(
          { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
          makeDeps(store, {
            resolveContextItems: async () => {
              throw new Error("store down");
            },
          }),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(store.metricsCalls).toHaveLength(0); // no metrics persisted for the failed turn
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TAG-5: ask split-turn (style B)
// ═══════════════════════════════════════════════════════════════════════════

describe("experience-copilot stream — ask split-turn (TAG-5)", () => {
  beforeEach(() => {
    streamTextImpl = undefined;
  });

  /** Seed an awaiting ask_user tool-result row (what a question turn's
   *  persistTurn leaves behind) + the assistant row that carried the call. */
  function seedAwaitingAsk(store: ReturnType<typeof createFakeStore>, toolCallId = "tc_ask_1") {
    store.messages.push(
      {
        id: "msg_seed_q",
        threadId: "thread_1",
        role: "assistant",
        content: "One question first:",
        toolCallsJson: JSON.stringify([
          { type: "tool-call", toolCallId, toolName: "ask_user", input: { question: "Blue or green?" } },
        ]),
        toolCallId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "msg_seed_r",
        threadId: "thread_1",
        role: "tool",
        content: JSON.stringify({
          toolName: "ask_user",
          output: { status: "awaiting_answer", question: "Blue or green?", options: ["blue", "green"], recommended: "blue" },
        }),
        toolCallsJson: null,
        toolCallId,
        createdAt: "2025-01-01T00:00:01.000Z",
      },
    );
    return toolCallId;
  }

  /** Pull the LAST tool-role message's first tool-result part value (the
   *  model-visible text of the seeded ask row) from the captured modelMessages. */
  function lastAskResultText(modelMessages: Array<{ role: string; content: unknown }>): string {
    const toolMsg = [...modelMessages].reverse().find((m) => m.role === "tool");
    const part = (toolMsg!.content as Array<{ type: string; output?: { value?: string } }>)[0];
    return part.output!.value!;
  }

  it("stopWhen wires the ceiling AND the ask_user stop condition (verified ai@7.0.66 API)", async () => {
    const store = createFakeStore(makeThread());
    let captured: { stopWhen?: unknown } | undefined;
    streamTextImpl = (opts: unknown) => {
      captured = opts as { stopWhen?: unknown };
      return makeFakeStreamTextResult({ parts: [textDelta("ok")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // Array of conditions: [isStepCount(CEILING), hasToolCall("ask_user")].
    const stopWhen = captured!.stopWhen as Array<(o: { steps: Array<{ toolCalls?: Array<{ toolName: string }> }> }) => boolean>;
    expect(Array.isArray(stopWhen)).toBe(true);
    expect(stopWhen).toHaveLength(2);
    // The second condition behaves as the SDK's hasToolCall: true iff the LAST
    // step's tool calls include ask_user.
    expect(stopWhen[1]({ steps: [{ toolCalls: [{ toolName: "write_buffer" }, { toolName: "ask_user" }] }] })).toBe(true);
    expect(stopWhen[1]({ steps: [{ toolCalls: [{ toolName: "write_buffer" }] }] })).toBe(false);
    expect(stopWhen[1]({ steps: [{}] })).toBe(false);
    expect(stopWhen[1]({ steps: [] })).toBe(false);
  });

  it("a question turn streams the ask tool-call + awaiting marker and persists them; finish, not error", async () => {
    const store = createFakeStore(makeThread());
    streamTextImpl = () =>
      makeFakeStreamTextResult({
        parts: [
          textDelta("I need one thing decided."),
          toolCall("tc_q", "ask_user", { question: "Blue or green?", options: ["blue", "green"], recommended: "blue" }),
          toolResult("tc_q", "ask_user", { status: "awaiting_answer", question: "Blue or green?", options: ["blue", "green"], recommended: "blue" }),
        ],
      });

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "make a theme", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const toolCallEvt = events.find((e) => e.event === "tool-call");
    expect((toolCallEvt!.data as { toolName: string }).toolName).toBe("ask_user");
    const toolResultEvt = events.find((e) => e.event === "tool-result");
    expect((toolResultEvt!.data as { output: { status: string } }).output.status).toBe("awaiting_answer");
    // The turn ends NORMALLY — a finish event, never an error.
    expect(events.find((e) => e.event === "finish")).toBeDefined();
    expect(events.find((e) => e.event === "error")).toBeUndefined();

    // Persisted: user + assistant(text) + assistant(toolCalls) + tool(awaiting marker).
    const toolRow = store.messages.find((m) => m.role === "tool");
    expect(toolRow!.toolCallId).toBe("tc_q");
    expect(JSON.parse(toolRow!.content)).toEqual({
      toolName: "ask_user",
      output: { status: "awaiting_answer", question: "Blue or green?", options: ["blue", "green"], recommended: "blue" },
    });
  });

  it("answer mode: NO user row; the marker row is rewritten; the model sees the answer text as the tool-result", async () => {
    const store = createFakeStore(makeThread());
    seedAwaitingAsk(store);
    let captured: { messages?: Array<{ role: string; content: unknown }> } | undefined;
    streamTextImpl = (opts: unknown) => {
      captured = opts as { messages?: Array<{ role: string; content: unknown }> };
      return makeFakeStreamTextResult({ parts: [textDelta("Blue it is.")] });
    };

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", answer: { toolCallId: "tc_ask_1", text: "blue" }, providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // No user row for an answer turn — the answer IS the tool-result.
    expect(store.messages.filter((m) => m.role === "user")).toHaveLength(0);
    // The marker row was rewritten to the answered payload.
    const toolRow = store.messages.find((m) => m.toolCallId === "tc_ask_1")!;
    expect(JSON.parse(toolRow.content)).toEqual({
      toolName: "ask_user",
      output: { status: "answered", answer: "blue" },
    });
    // The model window ends on the answered tool-result with the ANSWER TEXT
    // (not the marker JSON), and the continuation persists normally.
    expect(lastAskResultText(captured!.messages!)).toBe("blue");
    const finish = events.find((e) => e.event === "finish");
    expect(finish).toBeDefined();
    expect(store.messages.at(-1)!.role).toBe("assistant");
    expect(store.messages.at(-1)!.content).toBe("Blue it is.");
  });

  it("answer mode with skipped: the model sees (skipped)", async () => {
    const store = createFakeStore(makeThread());
    seedAwaitingAsk(store, "tc_skip_1");
    let captured: { messages?: Array<{ role: string; content: unknown }> } | undefined;
    streamTextImpl = (opts: unknown) => {
      captured = opts as { messages?: Array<{ role: string; content: unknown }> };
      return makeFakeStreamTextResult({ parts: [textDelta("Fine — I'll pick.")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", answer: { toolCallId: "tc_skip_1", skipped: true }, providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const toolRow = store.messages.find((m) => m.toolCallId === "tc_skip_1")!;
    expect(JSON.parse(toolRow.content)).toEqual({
      toolName: "ask_user",
      output: { status: "skipped" },
    });
    expect(lastAskResultText(captured!.messages!)).toBe("(skipped)");
  });

  it("a dangling ask self-heals at the next assembly: the model reads the heal literal; the stored row is NOT mutated", async () => {
    const store = createFakeStore(makeThread());
    seedAwaitingAsk(store);
    let captured: { messages?: Array<{ role: string; content: unknown }> } | undefined;
    streamTextImpl = (opts: unknown) => {
      captured = opts as { messages?: Array<{ role: string; content: unknown }> };
      return makeFakeStreamTextResult({ parts: [textDelta("Alright, different topic.")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "never mind, do something else", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // The model sees the heal literal for the never-answered ask...
    expect(lastAskResultText(captured!.messages!)).toBe("(the user did not answer this question; they moved on)");
    // ...while the STORED row keeps its awaiting marker (prompt-side only —
    // the UI still renders the unanswered state, and a LATE answer can still
    // rewrite it).
    const toolRow = store.messages.find((m) => m.toolCallId === "tc_ask_1")!;
    expect((JSON.parse(toolRow.content) as { output: { status: string } }).output.status).toBe("awaiting_answer");
    // The normal message still persisted as a user row.
    expect(store.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("an answer for a toolCallId that is not an awaiting ask in this thread is rejected", async () => {
    const store = createFakeStore(makeThread());
    seedAwaitingAsk(store);

    // Unknown toolCallId.
    let caught: unknown = null;
    try {
      await collect(
        streamExperienceCopilot(
          { threadId: "thread_1", answer: { toolCallId: "tc_bogus", text: "x" }, providerProfileId: "prov_1" },
          makeDeps(store),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("not found");

    // A REAL tool row, but not an ask (the rewrite guard must not fire on it).
    store.messages.push({
      id: "msg_seed_other",
      threadId: "thread_1",
      role: "tool",
      content: JSON.stringify({ toolName: "write_buffer", output: { summary: "wrote" } }),
      toolCallsJson: null,
      toolCallId: "tc_wb_1",
      createdAt: "2025-01-01T00:00:02.000Z",
    });
    caught = null;
    try {
      await collect(
        streamExperienceCopilot(
          { threadId: "thread_1", answer: { toolCallId: "tc_wb_1", text: "x" }, providerProfileId: "prov_1" },
          makeDeps(store),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // The write_buffer row was NOT rewritten.
    const wbRow = store.messages.find((m) => m.toolCallId === "tc_wb_1")!;
    expect((JSON.parse(wbRow.content) as { toolName: string }).toolName).toBe("write_buffer");
  });

  it("neither content nor answer (direct domain call) is rejected", async () => {
    const store = createFakeStore(makeThread());
    let caught: unknown = null;
    try {
      await collect(
        streamExperienceCopilot(
          { threadId: "thread_1", providerProfileId: "prov_1" } as never,
          makeDeps(store),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("either `content` or `answer`");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TAG-6: todo wiring (saveTodo → updateTodo + prompt section)
// ═══════════════════════════════════════════════════════════════════════════

describe("experience-copilot stream — todo wiring (TAG-6)", () => {
  beforeEach(() => {
    streamTextImpl = undefined;
  });

  it("wires the todo tool's saveTodo to the store: a todo call persists via updateTodo", async () => {
    const store = createFakeStore(makeThread());
    let captured: { tools?: Record<string, { execute?: (input: unknown) => Promise<unknown> }> } | undefined;
    streamTextImpl = (opts: unknown) => {
      captured = opts as typeof captured;
      return makeFakeStreamTextResult({ parts: [textDelta("ok")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "plan this out", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    // The built tool set carries the todo tool (builtin seed has todo: true).
    const todoTool = captured!.tools!["todo"];
    expect(todoTool).toBeDefined();

    // Invoking the tool's execute — the same path the real SDK loop drives —
    // must flow through the wired saveTodo → store.updateTodo(threadId, items).
    const items = [
      { title: "Write rules", status: "active" },
      { title: "Bind visual", status: "pending" },
    ];
    const result = await todoTool.execute!({ items });
    expect(result).toMatchObject({ ok: true, remaining: 2, activeTitle: "Write rules" });

    expect(store.todoCalls).toHaveLength(1);
    expect(store.todoCalls[0].threadId).toBe("thread_1");
    expect(store.todoCalls[0].items).toEqual(items);
  });

  it("the NEXT turn's assembly carries the persisted todo section (session-scoped lifetime)", async () => {
    // A prior turn already persisted a plan onto the thread (the fake's
    // updateTodo mutates thread.todo; here we seed it directly to isolate the
    // turn-over read path).
    const thread = makeThread();
    thread.todo = [
      { title: "Write the rules buffer", status: "active" },
      { title: "Bind a visual", status: "pending" },
    ];
    const store = createFakeStore(thread);
    let captured: { messages?: Array<{ role: string; content: string }> } | undefined;
    streamTextImpl = (opts: unknown) => {
      captured = opts as typeof captured;
      return makeFakeStreamTextResult({ parts: [textDelta("continuing")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "continue", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    const system = captured!.messages![0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("# Current step plan");
    expect(system.content).toContain("[active] Write the rules buffer");
    expect(system.content).toContain("[pending] Bind a visual");
  });

  it("an empty todo → no todo section in the assembled prompt (byte-identical pre-TAG-6)", async () => {
    const store = createFakeStore(makeThread()); // todo: []
    let captured: { messages?: Array<{ role: string; content: string }> } | undefined;
    streamTextImpl = (opts: unknown) => {
      captured = opts as typeof captured;
      return makeFakeStreamTextResult({ parts: [textDelta("ok")] });
    };

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
        makeDeps(store),
      ),
    );

    expect(captured!.messages![0].content).not.toContain("Current step plan");
  });
});
