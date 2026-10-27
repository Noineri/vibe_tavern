/**
 * RO-6 — review-outcome integration (REVIEW_OUTCOME_FEEDBACK_PLAN).
 *
 * The web suites pin "real mounted review action → exactly these request
 * bodies" against shared contract fixtures
 * (`packages/api-contracts/test/fixtures/review-outcome/*.json`, written by
 * CoauthorCharacterForm.test.tsx and ExperienceCopilotShell.test.tsx). This
 * suite replays the SAME bodies through the real Hono routes, request
 * validation, adapters/orchestrator and prompt + tool assembly. Only the
 * provider boundary is doubled. Every request must reach the provider-bound
 * prompt with its live editor buffers, outcome lines and save flags, and the
 * provider-bound mutation tools must edit the live buffer, never the saved copy.
 *
 * L1: fixture and temp paths derive from import.meta.dir / tmpdir; temp roots
 * are removed in afterAll (an open SQLite handle can hold a Windows file — the
 * test:file wrapper sweeps its private TEMP root); no globals, registries, env
 * or module mocks are touched; every wait is a terminal response or stream end.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentReviewSnapshot, CoauthorEditorState, ExperienceCopilotStreamRequest, ReviewTargetRecord } from "@vibe-tavern/api-contracts";
import type { ExperienceCopilotMessage, ExperienceCopilotStore, ExperienceCopilotThread, ExperienceVisualRow, ProviderProfile, ScriptRow } from "@vibe-tavern/db";
import { EventBus } from "@vibe-tavern/domain";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { streamExperienceCopilot, type ExperienceCopilotStreamDeps } from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { createApp } from "../src/server/app-factory.js";

interface FixtureRequest {
  mode: "nonstream" | "stream";
  body: Record<string, unknown>;
}

interface Fixture {
  name: string;
  surface: "coauthor" | "copilot";
  scenario: string;
  requests: FixtureRequest[];
}

const FIXTURE_DIR = resolve(import.meta.dir, "../../../packages/api-contracts/test/fixtures/review-outcome");

async function loadFixtures(): Promise<Fixture[]> {
  const files = (await readdir(FIXTURE_DIR)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => ({
    name: file.slice(0, -".json".length),
    ...((await Bun.file(resolve(FIXTURE_DIR, file)).json()) as Omit<Fixture, "name">),
  })));
}

const fixtures = await loadFixtures();

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(typeof code === "string" && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(code))) throw error;
    }
  }
});

// ─── Expected prompt text (the model-facing contract, restated) ──────────────

/** The exact line the model must read for one review record. */
function outcomeLine(target: ReviewTargetRecord): string {
  const details: string[] = [];
  if (target.hunks) details.push(`hunks: accepted ${target.hunks.accepted}, rejected ${target.hunks.rejected}, pending ${target.hunks.pending}`);
  if (target.items) details.push(`items: offered ${target.items.offered}, selected ${target.items.selected}, applied ${target.items.applied}`);
  if (target.selected !== undefined) details.push(`selected: ${target.selected ? "yes" : "no"}`);
  if (target.supersededByRound !== undefined) details.push(`superseded by round \`${target.supersededByRound}\``);
  return `- ${target.target} round \`${target.roundId}\`: **${target.outcome}**${details.length > 0 ? ` (${details.join("; ")})` : ""}`;
}

function expectedOutcomeLines(review: AgentReviewSnapshot): string[] {
  return review.targets.length === 0 ? ["no unreviewed proposals and no recorded outcomes"] : review.targets.map(outcomeLine);
}

/** The reading guidance rides only with real records (owner incident: the model insisted rejected edits were live). */
const OUTCOME_GUIDANCE_START = "These records are authoritative: they report what the user actually did with your earlier proposals";
const REJECTED_GUIDANCE = "`rejected`, `cancelled` and `superseded` changes are NOT in the editor — never describe them as applied or insist that they are.";

function expectOutcomeGuidance(prompt: string, review: AgentReviewSnapshot, encode: (text: string) => string): void {
  if (review.targets.length > 0) {
    expect(prompt).toContain(encode(OUTCOME_GUIDANCE_START));
    expect(prompt).toContain(encode(REJECTED_GUIDANCE));
  } else {
    expect(prompt).not.toContain(encode(OUTCOME_GUIDANCE_START));
  }
}

/** Text as it appears inside a JSON-serialized provider payload. */
function jsonText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** A non-empty line that occurs exactly once — a search anchor only the live buffer can satisfy. */
function uniqueLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const line = lines.reverse().find((candidate) => text.split(candidate).length === 2);
  if (!line) throw new Error(`Expected a unique anchor line in ${JSON.stringify(text)}`);
  return line;
}

function sectionBody(body: string, heading: string): string {
  const match = new RegExp(`^# ${heading}\\n([\\s\\S]*?)(?=\\n# |$)`, "m").exec(body);
  return match?.[1]?.trim() ?? "";
}

interface ExecutableTool {
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
}

async function outcomeOf(tool: ExecutableTool, input: unknown): Promise<string> {
  if (typeof tool.execute !== "function") throw new Error("Expected an executable provider-bound tool");
  return tool.execute(input, { messages: [], toolCallId: "ro6-tool", abort: () => {} }).then(
    (output) => `ok:${JSON.stringify(output)}`,
    (error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`,
  );
}

// ─── Co-author: real chat routes → orchestrator → strategy → provider ────────

const STALE_NAME = "Saved stale name";
const STALE_DESCRIPTION = "Saved stale description";
const STALE_GREETING = "Saved stale greeting";

async function makeCoauthorEnvironment() {
  const root = resolve(tmpdir(), `vt-ro6-coauthor-${crypto.randomUUID().slice(0, 8)}`);
  roots.push(root);
  const dataDir = resolve(root, "data");
  await mkdir(dataDir, { recursive: true });
  const stores = await createRuntimeStore(dataDir);
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const profile = await stores.providers.create({ name: "RO-6 co-author", providerPreset: "openai_compat", endpoint: "https://ro6.example/v1", defaultModel: "ro6" });
  await stores.coauthorSettings.upsert(profile.id, { modelName: "ro6-model", settings: { maxTokens: 128 } });
  await stores.uiSettings.update({ coauthorProviderId: profile.id });
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({ name: STALE_NAME, description: STALE_DESCRIPTION, firstMessage: STALE_GREETING });
  const coauthor = await runtime.chatLifecycle.createChatForCharacter(created.snapshot.character!.id, "coauthor");
  const providerInputs: ProviderExecutionInput[] = [];
  const orchestrator = new LiveChatOrchestrator(
    runtime.chatRuntime,
    runtime.chatApp,
    null as unknown as import("../src/domain/providers/provider-orchestrator.js").ProviderOrchestrator,
    new EventBus(),
    (chatId) => runtime.resolveChatModeStrategy(chatId),
    undefined,
    undefined,
    {
      nonstreaming: async (input) => {
        providerInputs.push(input);
        return { text: "ok", providerResponse: { mode: "nonstream", steps: [] } };
      },
      stream: async (input) => {
        providerInputs.push(input);
        return {
          stream: (async function* () {
            yield { type: "text-delta" as const, delta: "ok" };
          })(),
          finished: Promise.resolve({ finishReason: "stop" as const }),
          text: Promise.resolve("ok"),
          reasoning: Promise.resolve(undefined),
          providerResponse: { mode: "stream" as const, steps: [] },
        };
      },
    },
  );
  const providerProfiles = {
    resolveActiveProviderProfile: async () => null,
    getProviderModelSettings: async () => null,
    getProviderProfile: async (id: string) => stores.providers.getById(id),
  } as ProviderProfileService;
  const chat = new ChatAdapter(
    stores,
    runtime,
    orchestrator,
    null as unknown as import("../src/domain/chat/chat-summary-service.js").ChatSummaryService,
    providerProfiles,
    null as unknown as import("../src/domain/asset/asset-service.js").AssetService,
    null as unknown as import("../src/api/contract/runtime-api.js").SttRuntimeApi["transcribeSttAudio"],
  );
  return { app: await createApp({ runtime: { chat } as RuntimeApi }), chatId: coauthor.activeChat.id, providerInputs };
}

async function replayCoauthor(fixture: Fixture): Promise<void> {
  const env = await makeCoauthorEnvironment();
  for (const [index, request] of fixture.requests.entries()) {
    const path = request.mode === "stream" ? "messages/stream" : "messages";
    const response = await env.app.request(`/api/chats/${env.chatId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    if (request.mode === "stream") {
      expect(await response.text()).toContain("event: finish");
    } else {
      expect(response.status).toBe(200);
    }
    expect(env.providerInputs).toHaveLength(index + 1);
    const input = env.providerInputs[index]!;
    const editor = request.body.coauthorEditorState as CoauthorEditorState;
    const payload = JSON.stringify(input.prompt.finalPayload);

    // Prompt: live card, live greetings, save state and every outcome line.
    const personality = sectionBody(editor.card.body, "PERSONALITY");
    const scenario = sectionBody(editor.card.body, "SCENARIO");
    if (personality) expect(payload).toContain(jsonText(personality));
    if (scenario) expect(payload).toContain(jsonText(scenario));
    if (editor.card.name) expect(payload).toContain(jsonText(`name: ${editor.card.name}`));
    const greeting = editor.card.greetings[0];
    if (greeting) expect(payload).toContain(jsonText(greeting));
    expect(payload).not.toContain(STALE_DESCRIPTION);
    expect(payload).not.toContain(STALE_GREETING);
    expect(payload).toContain(jsonText(`- card buffer: ${editor.card.cardClean ? "saved" : "unsaved"}`));
    for (const line of expectedOutcomeLines(editor.review)) expect(payload).toContain(jsonText(line));
    expectOutcomeGuidance(payload, editor.review, jsonText);

    // Tools: the provider-bound mutation tool edits the live card, never the saved one.
    const tool = input.tools?.edit_personality as ExecutableTool | undefined;
    if (!tool) throw new Error("Expected edit_personality from the real co-author tool builder");
    const stale = await outcomeOf(tool, { edits: [{ search: STALE_DESCRIPTION, replace: "stale base" }], summary: "RO-6 stale base" });
    if (personality) {
      expect(stale).toContain("not found");
      const live = await outcomeOf(tool, { edits: [{ search: personality, replace: "RO-6 provider edit." }], summary: "RO-6 live base" });
      expect(live.startsWith("ok:")).toBe(true);
      expect(live).toContain("RO-6 provider edit.");
      if (scenario) expect(live).toContain(jsonText(scenario));
      expect(live).not.toContain(STALE_NAME);
    } else {
      expect(stale).toMatch(/PERSONALITY section is empty/);
    }
  }
}

// ─── Copilot: real copilot route → stream domain → provider ──────────────────

const STALE_RULES = "SAVED STALE RULES";
const STALE_VISUAL = "<main>SAVED STALE VISUAL</main>";
const THREAD_ID = "thread-ro6";

function copilotProfile(): ProviderProfile {
  return {
    id: "provider-ro6", name: "RO-6 copilot", providerPreset: "openai", coauthorTransport: "chatCompletions", endpoint: "http://ro6", apiKey: "key", defaultModel: "ro6",
    contextBudget: null, pinContextBudget: false, bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false, maxTokens: 2000, temperature: 0.3, topP: 1, topK: 0, minP: 0, topA: 0,
    typicalP: 1, tfsZ: 1, repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1, dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, drySequenceBreakers: null,
    xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1, stopSequences: [], logitBias: null, seed: null, reasoningEffort: "auto",
    showReasoning: false, streamResponse: true, customSamplers: false, proxyMode: "inherit", proxyId: null, isActive: true, visionModel: null,
    createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
  } as ProviderProfile;
}

/** Thread store holding the turn's rows; an answer request finds its awaiting ask_user marker. */
function copilotStore(answerToolCallId: string | undefined): ExperienceCopilotStore {
  const thread: ExperienceCopilotThread = {
    id: THREAD_ID, scriptId: "script-ro6", draftSessionId: null, title: "RO-6", archivedAt: null, contextMetrics: null, contextLinks: [], todo: [],
    lastProviderProfileId: null, lastModel: null, autoCompact: true, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
  };
  const messages: ExperienceCopilotMessage[] = [];
  if (answerToolCallId !== undefined) {
    messages.push(
      {
        id: "ro6-ask-carrier", threadId: THREAD_ID, role: "assistant", content: "",
        toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: answerToolCallId, toolName: "ask_user", input: { question: "Which buffer should change?", options: ["Rules", "Visual"] } }]),
        toolCallId: null, createdAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "ro6-ask-marker", threadId: THREAD_ID, role: "tool",
        content: JSON.stringify({ toolName: "ask_user", output: { status: "awaiting_answer", question: "Which buffer should change?", options: ["Rules", "Visual"], recommended: "Rules" } }),
        toolCallsJson: null, toolCallId: answerToolCallId, createdAt: "2025-01-01T00:00:01.000Z",
      },
    );
  }
  let counter = 0;
  return {
    getActive: async () => thread,
    getById: async () => thread,
    listSessions: async () => [thread],
    startNewSession: async () => thread,
    activate: async () => thread,
    archive: async () => thread,
    listMessages: async () => [...messages],
    appendMessage: async (_threadId: string, input: { role: ExperienceCopilotMessage["role"]; content?: string; toolCallsJson?: string | null; toolCallId?: string | null }) => {
      const message: ExperienceCopilotMessage = {
        id: `ro6-${counter++}`, threadId: THREAD_ID, role: input.role, content: input.content ?? "",
        toolCallsJson: input.toolCallsJson ?? null, toolCallId: input.toolCallId ?? null, createdAt: "2025-01-01T00:00:02.000Z",
      };
      messages.push(message);
      return message;
    },
    updateContextMetrics: async () => {},
    getAutoCompact: async () => true,
    setAutoCompact: async () => {},
    updateTodo: async () => {},
    setToolResultOutput: async (_threadId: string, toolCallId: string, payload: { toolName: string; output: unknown }) => {
      const row = messages.find((message) => message.role === "tool" && message.toolCallId === toolCallId);
      if (!row) return null;
      row.content = JSON.stringify(payload);
      return row;
    },
  } as unknown as ExperienceCopilotStore;
}

interface CapturedCopilotCall {
  messages?: Array<{ role: string; content: unknown }>;
  tools?: Record<string, ExecutableTool>;
}

async function replayCopilotRequest(request: FixtureRequest): Promise<CapturedCopilotCall> {
  const body = request.body as Omit<ExperienceCopilotStreamRequest, "threadId">;
  const script: ScriptRow = {
    id: "script-ro6", name: "Saved script", description: "", code: STALE_RULES, enabled: true, scriptKind: "interactive", origin: "in_app", firstEnabledAt: null,
    creationIntentId: null, scopeType: "global", sortOrder: 0, characterId: null, personaId: null, chatId: null, defaultVisualId: "visual-ro6", copilotProfileId: null,
    extensions: {}, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
  };
  const visual: ExperienceVisualRow = {
    id: "visual-ro6", name: "Saved visual", source: STALE_VISUAL, sourceHash: "hash", apiVersion: 1, compatibleManifestIds: [], scopeType: "global",
    characterId: null, personaId: null, chatId: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
  };
  let captured: CapturedCopilotCall | undefined;
  const deps: ExperienceCopilotStreamDeps = {
    store: copilotStore(body.answer?.toolCallId),
    agentPlans: { get: async () => null, save: async () => {} } as unknown as ExperienceCopilotStreamDeps["agentPlans"],
    getScript: async (id) => (id === script.id ? script : null),
    getBoundVisualIds: async () => [visual.id],
    getVisual: async (id) => (id === visual.id ? visual : null),
    getProviderProfile: async () => copilotProfile(),
    getEffectiveProviderProfile: async () => copilotProfile(),
    resolveModel: () => ({}) as import("ai").LanguageModel,
    streamText: ((options: unknown) => {
      captured = options as CapturedCopilotCall;
      return {
        stream: (async function* () {
          yield { type: "text-delta", text: "ok" };
        })(),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve(undefined),
      };
    }) as unknown as ExperienceCopilotStreamDeps["streamText"],
  };
  const experienceCopilot = {
    experienceCopilotAssertStreamKind: async () => {},
    experienceCopilotStream: (threadId: string, streamBody: Omit<ExperienceCopilotStreamRequest, "threadId">, signal?: AbortSignal) =>
      streamExperienceCopilot({ ...streamBody, threadId }, deps, signal),
  } as unknown as RuntimeApi["experienceCopilot"];
  const app = await createApp({ runtime: { experienceCopilot } as RuntimeApi });
  const response = await app.request(`/api/experience-copilot/${THREAD_ID}/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("event: finish");
  if (!captured) throw new Error("Expected the copilot route to reach the provider boundary");
  return captured;
}

async function replayCopilot(fixture: Fixture): Promise<void> {
  for (const request of fixture.requests) {
    const body = request.body as Omit<ExperienceCopilotStreamRequest, "threadId">;
    const captured = await replayCopilotRequest(request);
    const system = captured.messages?.find((message) => message.role === "system")?.content;
    if (typeof system !== "string") throw new Error("Expected a provider-bound system message");

    // Prompt: live buffers, never the saved copies; save flags; every outcome line.
    expect(typeof body.rules).toBe("string");
    expect(typeof body.visual).toBe("string");
    expect(system).toContain(body.rules!);
    expect(system).not.toContain(STALE_RULES);
    if (body.visual) expect(system).toContain(body.visual);
    expect(system).not.toContain(STALE_VISUAL);
    if (body.rulesSaved !== undefined) expect(system).toContain(`- rules buffer: ${body.rulesSaved ? "saved" : "unsaved"}`);
    if (body.visualSaved !== undefined) expect(system).toContain(`- visual buffer: ${body.visualSaved ? "saved" : "unsaved"}`);
    expect(body.reviewSnapshot).toBeDefined();
    for (const line of expectedOutcomeLines(body.reviewSnapshot!)) expect(system).toContain(line);
    expectOutcomeGuidance(system, body.reviewSnapshot!, (text) => text);

    // ask_user answer path: the model reads the answer as the awaited tool result.
    if (body.answer !== undefined) {
      const toolMessage = [...(captured.messages ?? [])].reverse().find((message) => message.role === "tool");
      expect(JSON.stringify(toolMessage?.content)).toContain(jsonText(JSON.stringify({ answer: body.answer.text })));
    }

    // Tools: edit_buffer anchors on the live buffer, never the saved one.
    const editBuffer = captured.tools?.edit_buffer;
    if (!editBuffer) throw new Error("Expected edit_buffer from the real copilot tool builder");
    const staleRules = await outcomeOf(editBuffer, { target: "rules", edits: [{ search: STALE_RULES, replace: "stale base" }], summary: "RO-6 stale rules" });
    expect(staleRules).toContain("edit.search not found");
    // The fixture rules are not a runnable experience: a live anchor passes the
    // search and reaches rules validation, which a stale anchor never does.
    const liveRules = await outcomeOf(editBuffer, { target: "rules", edits: [{ search: uniqueLine(body.rules!), replace: "// RO-6 provider edit" }], summary: "RO-6 live rules" });
    expect(liveRules).not.toContain("edit.search not found");
    expect(liveRules).toMatch(/^ok:|proposed rules failed validation/);
    const staleVisual = await outcomeOf(editBuffer, { target: "visual", edits: [{ search: "SAVED STALE VISUAL", replace: "stale base" }], summary: "RO-6 stale visual" });
    expect(staleVisual).toContain("edit.search not found");
    if (body.visual) {
      const liveVisual = await outcomeOf(editBuffer, { target: "visual", edits: [{ search: uniqueLine(body.visual), replace: "RO-6 provider visual" }], summary: "RO-6 live visual" });
      expect(liveVisual.startsWith("ok:")).toBe(true);
      expect(liveVisual).toContain("RO-6 provider visual");
    }
  }
}

// ─── Replay every client-pinned fixture ───────────────────────────────────────

describe("review outcome: mounted client bodies → real routes → provider prompt and tools (RO-6)", () => {
  test("the shared fixture set covers both surfaces", () => {
    expect(fixtures.filter((fixture) => fixture.surface === "coauthor").length).toBeGreaterThan(0);
    expect(fixtures.filter((fixture) => fixture.surface === "copilot").length).toBeGreaterThan(0);
    expect(fixtures.every((fixture) => fixture.requests.length > 0)).toBe(true);
    const coauthorModes = new Set(fixtures.filter((fixture) => fixture.surface === "coauthor").flatMap((fixture) => fixture.requests.map((request) => request.mode)));
    expect([...coauthorModes].sort()).toEqual(["nonstream", "stream"]);
    expect(fixtures.some((fixture) => fixture.requests.some((request) => "answer" in request.body))).toBe(true);
  });

  for (const fixture of fixtures) {
    // Explicit timeout (the store-cleanup.ts afterAll precedent): the replay
    // runs every fixture request SEQUENTIALLY through the real Hono app +
    // orchestrator — the 6-request fixtures legitimately take 5-7s under
    // full-suite load (2-3-request siblings already sit at 2-3.5s), crossing
    // bun's generic 5s test default. A budget fires only when exceeded; it
    // never adds delay. Wall-clock budget, not a race — per-file runs are
    // green without it.
    test(`${fixture.surface}: ${fixture.name} — ${fixture.scenario}`, async () => {
      if (fixture.surface === "coauthor") await replayCoauthor(fixture);
      else await replayCopilot(fixture);
    }, { timeout: 30_000 });
  }
});
