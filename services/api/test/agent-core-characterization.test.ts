/**
 * Agent-core characterization pins (AGENT_SHELL_PLAN, unit AS-1 — TEST-ONLY).
 *
 * These pins exist so the upcoming AS-2 extraction moves code WITHOUT SILENT
 * DRIFT: a pin that passes while real behavior changed is worse than no pin.
 * Therefore every comparison below is byte-exact (no whitespace/timestamp
 * normalization) and every fixture is a committed file, not an inline string.
 *
 * What is REUSED from existing pins (not duplicated here):
 * - experience-copilot-prompt.test.ts — zero-plan/zero-digest/zero-attached
 *   byte-identity (SHA-256 `8fd6032e…`), the SS-4B untrusted skip-note
 *   contains-pins, and the plan-section rendering contains-pins.
 * - experience-copilot-tools.test.ts — "all ten tools are present by default"
 *   (builder-level key list) and the full SS-4B refusal/marker suite.
 * - experience-copilot-stream.test.ts — the fake-provider + fake-store seam
 *   pattern this file mirrors, and the TF-3 persistence-order pin.
 *
 * What is NEWLY pinned here:
 * (a) A fixed experience input (script row, rules, visual, a 3-turn history
 *     with one tool call, an agent plan, the builtin profile) produces a
 *     system message BYTE-IDENTICAL to the committed fixture
 *     `fixtures/agent-core-system-prompt.md` (exact equality).
 * (b) The tool-name list the STREAM passes to the model for the builtin
 *     profile, taken from the real code path (captured `streamText` opts —
 *     never hand-written from docs).
 * (c) The SSE event sequence (TYPES AND ORDER only) for one turn whose fake
 *     provider calls edit_buffer then answers.
 * (d) The UNTRUSTED variant (rulesTrusted=false, SCRIPT_SAFETY SS-4B):
 *     trusted vs untrusted snapshots differ, no contract summary renders,
 *     the tool surface is unchanged, run_test refuses, and the untrusted
 *     stream turn keeps the same event order.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type { LanguageModel } from "ai";
import type { AgentPlan } from "@vibe-tavern/domain";
import type {
  ProviderProfile,
  ScriptRow,
  ExperienceVisualRow,
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ExperienceCopilotMessage,
  AppendMessageInput,
} from "@vibe-tavern/db";
import {
  assembleExperienceCopilotPrompt,
  type ExperienceCopilotHistoryMessage,
} from "../src/domain/interactive/copilot/experience-copilot-prompt.js";
import { resolveBuiltinCopilotProfile } from "../src/domain/interactive/copilot/experience-copilot-module.js";
import { buildExperienceCopilotTools } from "../src/domain/interactive/copilot/experience-copilot-tools.js";
import {
  streamExperienceCopilot,
  type ExperienceCopilotStreamDeps,
  type ExperienceCopilotStreamEvent,
} from "../src/domain/interactive/copilot/experience-copilot-stream.js";

// ─── Determinism ─────────────────────────────────────────────────────────────
// Char-length token counting (mirrors experience-copilot-prompt.test.ts) so
// token accounting is a pure function of the fixed input. Restored to the
// unset-equivalent in afterAll: estimateTokens is process-global under
// bun:test and sibling files expect the unset behavior.
beforeEach(() => {
  setTokenCountFn((text: string) => text.length);
});
afterAll(() => {
  setTokenCountFn(() => 0);
});

// ─── Fixed experience input (fully deterministic: fixed ids, no timestamps,
// no digests, no randomness — the rules body never touches context.random) ───

const COUNTER_RULES = `context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [],
  create() { return { count: 0 }; },
  project(context) { return { count: context.state.count }; },
  actions() { return [{ type: "increment" }]; },
  reduce(context, action) {
    if (action.type === "increment") return { state: { count: context.state.count + 1 }, status: "active", events: [] };
    return { state: context.state, status: "active", events: [] };
  }
});`;

const VISUAL_SOURCE = `// AS-1 fixed visual buffer
canvas.text('count: ' + projection.count);`;

function makeScriptRow(overrides: Partial<ScriptRow> = {}): ScriptRow {
  return {
    id: "script_as1_1",
    name: "AS-1 Counter",
    description: "Fixed script row for the AS-1 characterization pins.",
    code: COUNTER_RULES,
    enabled: true,
    scriptKind: "interactive",
    origin: "in_app",
    firstEnabledAt: null,
    creationIntentId: null,
    scopeType: "global",
    sortOrder: 0,
    characterId: null,
    personaId: null,
    chatId: null,
    defaultVisualId: "vis_as1_1",
    copilotProfileId: null,
    extensions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const VISUAL_ROW: ExperienceVisualRow = {
  id: "vis_as1_1",
  name: "AS-1 Card",
  source: VISUAL_SOURCE,
  sourceHash: "as1-fixed-hash",
  apiVersion: 1,
  compatibleManifestIds: [],
  scopeType: "global",
  characterId: null,
  personaId: null,
  chatId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const BOUND_VISUALS = [{ id: "vis_as1_1", name: "AS-1 Card", kind: "card" }] as const;

// Three turns: user request, assistant + one run_test tool call, tool result,
// then the user's follow-up. Fixed toolCallId; fixed tool-result payload.
const HISTORY_3TURN: ExperienceCopilotHistoryMessage[] = [
  { role: "user", content: "Help me build a counter experience." },
  {
    role: "assistant",
    content: "I'll validate the current rules first.",
    toolCalls: [
      { type: "tool-call", toolCallId: "call_as1_1", toolName: "run_test", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_as1_1",
        toolName: "run_test",
        output: { type: "text", value: '{"ok":true,"status":"active","revision":0}' },
      },
    ],
  },
  { role: "user", content: "Great, now add a reset action." },
];

const PLAN: AgentPlan = {
  goal: "Build the counter experience",
  constraints: ["Keep the reducer deterministic"],
  tasks: [
    { id: "as1-rules", title: "Write the rules buffer", body: "AS-1 ACTIVE BODY", status: "active" },
    { id: "as1-reset", title: "Add the reset action", body: "AS-1 PENDING BODY", status: "pending" },
  ],
};

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "agent-core-system-prompt.md");

// ─── Fake provider + fake store (mirrors experience-copilot-stream.test.ts) ──
// `streamText` is a deps seam (never mock.module("ai")); each test sets
// `streamTextImpl` and makeDeps injects it.

let streamTextImpl: ((opts: unknown) => unknown) | undefined;
let capturedStreamOpts: { tools?: Record<string, unknown>; messages?: Array<{ role: string; content: unknown }> } | null = null;

beforeEach(() => {
  streamTextImpl = undefined;
  capturedStreamOpts = null;
});

function createFakeStore(
  thread: ExperienceCopilotThread,
): ExperienceCopilotStore & { messages: ExperienceCopilotMessage[] } {
  const messages: ExperienceCopilotMessage[] = [];
  let counter = 0;
  const now = () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + counter++ * 1000).toISOString();
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
        id: `msg_as1_${counter++}`,
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
    async updateContextMetrics() {},
    async getAutoCompact() { return true; },
    async setAutoCompact() {},
    async updateTodo() {},
    async setToolResultOutput() { return null; },
  } as unknown as ExperienceCopilotStore & { messages: ExperienceCopilotMessage[] };
}

function makeProfile(): ProviderProfile {
  return {
    id: "prov_as1",
    name: "AS-1 Test",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ProviderProfile;
}

function makeThread(scriptId: string | null = "script_as1_1"): ExperienceCopilotThread {
  return {
    id: "thread_as1_1",
    scriptId,
    draftSessionId: null,
    title: "AS-1 thread",
    archivedAt: null,
    contextMetrics: null,
    contextLinks: [],
    todo: [],
    lastProviderProfileId: null,
    lastModel: null,
    autoCompact: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeDeps(
  store: ExperienceCopilotStore,
  overrides: Partial<ExperienceCopilotStreamDeps> = {},
): ExperienceCopilotStreamDeps {
  const profile = makeProfile();
  return {
    store,
    agentPlans: {
      get: async () => PLAN,
      save: async () => {},
    },
    getScript: async () => null,
    getBoundVisualIds: async () => [],
    getVisual: async () => null,
    getProviderProfile: async () => profile,
    getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    streamText: streamTextImpl as unknown as ExperienceCopilotStreamDeps["streamText"],
    ...overrides,
  };
}

function makeFakeStreamTextResult(parts: unknown[]): Record<string, unknown> {
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    for (const p of parts) yield p;
  }
  return {
    stream: gen(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve(undefined),
  };
}

function capturingFake(parts: unknown[]): (opts: unknown) => unknown {
  return (opts: unknown) => {
    capturedStreamOpts = opts as { tools?: Record<string, unknown>; messages?: Array<{ role: string; content: unknown }> };
    return makeFakeStreamTextResult(parts);
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

// Stable summary: event types in order; tool events carry the tool NAME
// (stable), never ids/args/outputs/deltas (volatile).
function summarizeEvents(events: Array<{ event: string; data: unknown }>): string[] {
  return events.map((e) => {
    if (e.event === "tool-call" || e.event === "tool-result") {
      return `${e.event}:${(e.data as { toolName: string }).toolName}`;
    }
    return e.event;
  });
}

const textDelta = (text: string) => ({ type: "text-delta", text });
const toolCall = (toolCallId: string, toolName: string, args: Record<string, unknown>) =>
  ({ type: "tool-call", toolCallId, toolName, input: args });
const toolResult = (toolCallId: string, toolName: string, output: unknown) =>
  ({ type: "tool-result", toolCallId, toolName, output });

// The AI-SDK tool-call context argument is ignored by every tool here, so a
// stub double-cast to the tool's own execute parameter type suffices (keeps
// the hygiene as-never ratchet untouched; same stub shape as
// experience-copilot-tools.test.ts).
type CopilotToolCallCtx = Parameters<
  NonNullable<(ReturnType<typeof buildExperienceCopilotTools>)["run_test"]["execute"]>
>[1];
const toolCtx = { messages: [], toolCallId: "t", abort: () => {} } as unknown as CopilotToolCallCtx;

// ─── (a) Fixed input → byte-identical system message ─────────────────────────

describe("AS-1 (a) — fixed experience input pins the assembled system message", () => {
  async function assembleTrusted(): Promise<string> {
    const profile = await resolveBuiltinCopilotProfile();
    const result = await assembleExperienceCopilotPrompt({
      history: HISTORY_3TURN,
      rules: makeScriptRow().code,
      visual: VISUAL_SOURCE,
      boundVisuals: [...BOUND_VISUALS],
      step: "visual",
      profile,
      plan: PLAN,
    });
    return result.systemMessage;
  }

  test("assembly is deterministic: two consecutive assemblies are byte-identical", async () => {
    expect(await assembleTrusted()).toBe(await assembleTrusted());
  });

  test("system message is byte-identical to the committed fixture file", async () => {
    const systemMessage = await assembleTrusted();
    const fixture = await Bun.file(FIXTURE_PATH).text();
    expect(systemMessage).toBe(fixture);
  });

  test("the pinned assembly carries every fixed input (smoke over the snapshot)", async () => {
    const systemMessage = await assembleTrusted();
    expect(systemMessage).toContain("MINI-APP ASSISTANT");
    expect(systemMessage).toContain("Authoring step: **visual**");
    expect(systemMessage).toContain("canvas.text");
    expect(systemMessage).toContain("AS-1 Card");
    expect(systemMessage).toContain("choose method: absent");
    expect(systemMessage).toContain("Goal: Build the counter experience");
    expect(systemMessage).toContain("AS-1 ACTIVE BODY");
    expect(systemMessage).not.toContain("AS-1 PENDING BODY");
  });
});

// ─── (b) Tool-name list the stream passes to the model (builtin profile) ─────

describe("AS-1 (b) — stream tool surface for the builtin profile", () => {
  test("the stream passes all ten tools (post plan-mode: plan/read_plan/todo)", async () => {
    const script = makeScriptRow();
    const store = createFakeStore(makeThread(script.id));
    streamTextImpl = capturingFake([textDelta("ok")]);

    await collect(
      streamExperienceCopilot(
        { threadId: "thread_as1_1", content: "tweak the visual", providerProfileId: "prov_as1" },
        makeDeps(store, {
          getScript: async (id) => (id === script.id ? script : null),
          getBoundVisualIds: async () => [VISUAL_ROW.id],
          getVisual: async (id) => (id === VISUAL_ROW.id ? VISUAL_ROW : null),
        }),
      ),
    );

    expect(capturedStreamOpts).not.toBeNull();
    // From the real code path (captured streamText opts) — never hand-written.
    expect(Object.keys(capturedStreamOpts!.tools ?? {}).sort()).toEqual([
      "ask_user",
      "edit_buffer",
      "plan",
      "read_plan",
      "read_skill_file",
      "run_simulate",
      "run_test",
      "suggest_visual_binding",
      "todo",
      "write_buffer",
    ]);
  });
});

// ─── (c) SSE event sequence for an edit_buffer turn ──────────────────────────

describe("AS-1 (c) — SSE event types and order for one edit_buffer turn", () => {
  test("tool-call edit_buffer then answer: exact event-type order", async () => {
    const script = makeScriptRow();
    const store = createFakeStore(makeThread(script.id));
    streamTextImpl = capturingFake([
      textDelta("I'll add the reset action."),
      toolCall("tc_as1_edit", "edit_buffer", {
        target: "rules",
        edits: [{ search: "increment", replace: "increment" }],
        summary: "noop edit pin",
      }),
      toolResult("tc_as1_edit", "edit_buffer", {
        target: "rules",
        proposed: COUNTER_RULES,
        summary: "noop edit pin",
      }),
      textDelta("Done — review the diff."),
    ]);

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_as1_1", content: "add a reset action", providerProfileId: "prov_as1" },
        makeDeps(store, {
          getScript: async (id) => (id === script.id ? script : null),
          getBoundVisualIds: async () => [VISUAL_ROW.id],
          getVisual: async (id) => (id === VISUAL_ROW.id ? VISUAL_ROW : null),
        }),
      ),
    );

    expect(summarizeEvents(events)).toEqual([
      "text-delta",
      "tool-call:edit_buffer",
      "tool-result:edit_buffer",
      "text-delta",
      "finish",
    ]);
  });
});

// ─── (d) UNTRUSTED variant (rulesTrusted=false, SCRIPT_SAFETY SS-4B) ─────────
// The prompt-level skip-note and the run_test/run_simulate refusal shapes are
// pinned in detail by experience-copilot-prompt.test.ts ("SS-4B: contract
// derivation is SKIPPED…") and experience-copilot-tools.test.ts ("SS-4B trust
// gate…"); this file pins only the AS-1 matrix: snapshot inequality, the
// unchanged tool surface, one refusal call, and the untrusted event order.

describe("AS-1 (d) — untrusted variant (imported, never-enabled script)", () => {
  async function assembleUntrusted(): Promise<string> {
    const profile = await resolveBuiltinCopilotProfile();
    const result = await assembleExperienceCopilotPrompt({
      history: HISTORY_3TURN,
      rules: makeScriptRow().code,
      visual: VISUAL_SOURCE,
      boundVisuals: [...BOUND_VISUALS],
      step: "visual",
      profile,
      plan: PLAN,
      rulesTrusted: false,
    });
    return result.systemMessage;
  }

  test("no contract summary renders and the snapshot differs from the trusted one", async () => {
    const fixture = await Bun.file(FIXTURE_PATH).text();
    const untrusted = await assembleUntrusted();
    expect(untrusted).toContain("Discovered experience definition");
    expect(untrusted).toContain("not derived: script is imported and not yet enabled");
    expect(untrusted).not.toContain("choose method:");
    expect(untrusted).not.toBe(fixture);
  });

  test("the tool surface is unchanged by trust; run_test refuses without running code", async () => {
    const tools = buildExperienceCopilotTools({ rules: COUNTER_RULES, rulesTrusted: false });
    expect(Object.keys(tools as unknown as Record<string, unknown>).sort()).toEqual([
      "ask_user",
      "edit_buffer",
      "plan",
      "read_plan",
      "read_skill_file",
      "run_simulate",
      "run_test",
      "suggest_visual_binding",
      "todo",
      "write_buffer",
    ]);
    // COUNTER_RULES would return ok:true on the trusted path — refusal proves
    // the sandbox never ran.
    const digest = (await tools.run_test.execute({}, toolCtx)) as unknown as {
      ok: boolean;
      errorCode?: string;
    };
    expect(digest.ok).toBe(false);
    expect(digest.errorCode).toBe("script_not_trusted");
  });

  test("an untrusted stream turn keeps the same event order; the system skips the contract", async () => {
    const script = makeScriptRow({ origin: "imported", firstEnabledAt: null });
    const store = createFakeStore(makeThread(script.id));
    streamTextImpl = capturingFake([
      textDelta("I cannot run your code until you enable the script."),
      toolCall("tc_as1_ask", "ask_user", { question: "Enable the script first?" }),
      toolResult("tc_as1_ask", "ask_user", { status: "awaiting_answer", question: "Enable the script first?" }),
      textDelta("Let me know once it is enabled."),
    ]);

    const events = await collect(
      streamExperienceCopilot(
        { threadId: "thread_as1_1", content: "test my imported game", providerProfileId: "prov_as1" },
        makeDeps(store, {
          getScript: async (id) => (id === script.id ? script : null),
          getBoundVisualIds: async () => [VISUAL_ROW.id],
          getVisual: async (id) => (id === VISUAL_ROW.id ? VISUAL_ROW : null),
        }),
      ),
    );

    expect(summarizeEvents(events)).toEqual([
      "text-delta",
      "tool-call:ask_user",
      "tool-result:ask_user",
      "text-delta",
      "finish",
    ]);
    const system = (capturedStreamOpts!.messages ?? []).find((m) => m.role === "system");
    expect(system).toBeDefined();
    expect(system!.content as string).toContain("not derived: script is imported and not yet enabled");
    expect(system!.content as string).not.toContain("choose method:");
  });
});
