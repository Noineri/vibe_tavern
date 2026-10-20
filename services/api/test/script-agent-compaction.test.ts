/**
 * Script-agent compaction (AGENT_SHELL_PLAN, AS-8b-fix-A).
 *
 * Pins that the `script` kind summarizes with its OWN script-authoring prompt:
 * - service level: `ScriptAgentCompactionService` through the injected
 *   executor seam (no `mock.module("ai")`) — the summarizer call carries the
 *   script prompt, never the experience one, plus the shared digest samplers;
 * - adapter level: a script thread's MANUAL compaction through
 *   `ExperienceCopilotAdapter` reaches the script service (before AS-8b-fix-A
 *   it ran the experience summarizer prompt), an interactive thread still
 *   reaches the experience one. The adapter does not expose its executor, so
 *   the true external boundary (the provider's HTTP endpoint) is a local
 *   server that records the summarizer request.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { createDb, ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type {
  ExperienceCopilotMessage,
  ExperienceCopilotStore,
  ExperienceCopilotThread,
  ScriptRow,
  StoreContainer,
} from "@vibe-tavern/db";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { ScriptAgentCompactionService } from "../src/domain/agent/script-agent/script-agent-compaction.js";
import { ExperienceCopilotCompactionService } from "../src/domain/interactive/copilot/experience-copilot-compaction.js";
import { getServicePromptAssetFile } from "../src/domain/service-prompts/service-prompt-registry.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";
import {
  COPILOT_COMPACT_MAX_OUTPUT_TOKENS,
  COPILOT_COMPACT_TEMPERATURE,
} from "../src/domain/interactive/copilot/copilot-limits.js";
// Side-effect imports: register the built-in agent kinds so the adapter's
// thread-kind resolution holds regardless of which test file the shared
// process loaded first.
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";

/** Distinctive phrases of the two summarizer prompts. */
const SCRIPT_PROMPT_MARKER = "run_script_test";
const EXPERIENCE_PROMPT_MARKER = "interactive experiences";

type Executor = typeof nonstreamingProviderExecute;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeThread(scriptId: string | null): ExperienceCopilotThread {
  return {
    id: "thread_1",
    scriptId,
    draftSessionId: null,
    // SC-0a chat-owner triple: null on script-owned/draft threads (this
    // suite's threads are all script-owned or drafts).
    chatId: null,
    branchId: null,
    agentKind: null,
    title: "Compaction",
    archivedAt: null,
    contextMetrics: null,
    contextLinks: [],
    todo: [],
    lastProviderProfileId: "prov_1",
    lastModel: "model_1",
    autoCompact: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

function makeMessage(id: string, role: string): ExperienceCopilotMessage {
  return {
    id,
    threadId: "thread_1",
    role,
    content: `${role} ${id}`,
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
  };
}

/** A plain user/assistant alternation of `count` messages (ids m1..mN). */
function makeTurnSequence(count: number): ExperienceCopilotMessage[] {
  const out: ExperienceCopilotMessage[] = [];
  for (let i = 1; i <= count; i++) out.push(makeMessage(`m${i}`, i % 2 === 1 ? "user" : "assistant"));
  return out;
}

function makeStore(thread: ExperienceCopilotThread, initial: ExperienceCopilotMessage[]) {
  const messages = [...initial];
  const appended: ExperienceCopilotMessage[] = [];
  const store = {
    async getById() { return thread; },
    async listMessages() { return [...messages]; },
    async appendMessage(_threadId: string, input: { role: string; content?: string; toolCallId?: string | null }) {
      const m: ExperienceCopilotMessage = {
        ...makeMessage(`digest_${appended.length + 1}`, input.role),
        content: input.content ?? "",
        toolCallId: input.toolCallId ?? null,
      };
      appended.push(m);
      messages.push(m);
      return m;
    },
    async updateContextMetrics() {},
    async getAutoCompact() { return thread.autoCompact; },
    async setAutoCompact() {},
  } as unknown as ExperienceCopilotStore;
  return { store, appended };
}

/** Full provider profile (the real executor reads sampler fields) with
 *  `bindPerModel:false` so the summary-profile resolution stays on the
 *  identity path. */
function makeProviderProfile(endpoint: string) {
  return {
    id: "prov_1",
    name: "Test",
    providerPreset: "openai",
    coauthorTransport: "chatCompletions",
    endpoint,
    apiKey: "sk-test",
    defaultModel: "model_1",
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
  };
}

function makeProviderProfiles(endpoint = "http://127.0.0.1:1/v1") {
  const profile = makeProviderProfile(endpoint);
  return {
    getProviderProfile: async () => profile,
    getProviderModelSettings: async () => null,
  };
}

function makeScriptRow(scriptKind: string): ScriptRow {
  return {
    id: "script_1",
    name: "Compaction script",
    description: "",
    code: "",
    enabled: true,
    scriptKind,
    origin: "in_app",
    firstEnabledAt: null,
    creationIntentId: null,
    scopeType: "global",
    sortOrder: 0,
    characterId: null,
    personaId: null,
    chatId: null,
    defaultVisualId: null,
    copilotProfileId: null,
    extensions: {},
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  } as ScriptRow;
}

/** Every message of the summarizer payload as one string. */
function transcriptOf(prompt: Record<string, unknown>): string {
  const payload = prompt.finalPayload as { messages: Array<{ content: string }> };
  return payload.messages.map((m) => m.content).join("\n");
}

/** The system message of a captured summarizer call (the resolved prompt). */
function systemMessageOf(prompt: Record<string, unknown>): string {
  const payload = prompt.finalPayload as { messages: Array<{ content: string }> };
  return payload.messages[0].content;
}

beforeEach(() => {
  setTokenCountFn((text: string) => text.length);
});

// ─── Service level ───────────────────────────────────────────────────────────

describe("ScriptAgentCompactionService - summarizer call", () => {
  it("carries the script-authoring prompt (not the experience one) and the shared samplers", async () => {
    const { store, appended } = makeStore(makeThread("script_1"), makeTurnSequence(20));
    const calls: Array<Record<string, unknown>> = [];
    const execute = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { text: "script summary", providerResponse: {} };
    };
    const service = new ScriptAgentCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, execute as unknown as Executor);

    await service.compact({ threadId: "thread_1" });

    expect(calls).toHaveLength(1);
    const transcript = transcriptOf(calls[0].prompt as Record<string, unknown>);
    expect(transcript).toContain(SCRIPT_PROMPT_MARKER);
    expect(transcript).not.toContain(EXPERIENCE_PROMPT_MARKER);
    expect(calls[0].overrideTemperature).toBe(COPILOT_COMPACT_TEMPERATURE);
    expect(calls[0].overrideMaxTokens).toBe(COPILOT_COMPACT_MAX_OUTPUT_TOKENS);
    // The generic mechanism is shared: the digest lands at the keep-window anchor.
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe("digest");
    expect(appended[0].content).toBe("script summary");
    expect(appended[0].toolCallId).toBe("m13");
  });

  it("the experience service keeps its own prompt (the two services are distinct)", async () => {
    const { store } = makeStore(makeThread("script_1"), makeTurnSequence(20));
    const calls: Array<Record<string, unknown>> = [];
    const execute = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { text: "experience summary", providerResponse: {} };
    };
    const service = new ExperienceCopilotCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, execute as unknown as Executor);

    await service.compact({ threadId: "thread_1" });

    const transcript = transcriptOf(calls[0].prompt as Record<string, unknown>);
    expect(transcript).toContain(EXPERIENCE_PROMPT_MARKER);
    expect(transcript).not.toContain(SCRIPT_PROMPT_MARKER);
  });

  it("a missing thread is reported with the script thread label", async () => {
    const store = {
      async getById() { return null; },
    } as unknown as ExperienceCopilotStore;
    const service = new ScriptAgentCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, (async () => {
      throw new Error("executor must not run");
    }) as unknown as Executor);

    const error = await service.compact({ threadId: "thread_gone" }).then(
      () => null,
      (e) => e,
    ) as { kind?: string; message?: string } | null;

    expect(error).not.toBeNull();
    expect(error!.kind).toBe("NotFound");
  });

  // ── SC-8a: the summarizer prompt is the `script_agent_compaction` service prompt ──

  /** In-memory db with the Default profile, optionally an active profile
   *  carrying service-prompt overrides (the sp5-service-prompts fixture
   *  pattern). */
  async function setupDb(overrides?: Record<string, string>) {
    const db = await createDb(":memory:");
    const profileStore = new ServicePromptProfileStore(db);
    const uiSettings = new UiSettingsStore(db);
    await profileStore.ensureDefaultServicePromptProfile();
    if (overrides) {
      const profile = await profileStore.createServicePromptProfile({ name: "SC-8a", overrides });
      await uiSettings.update({ activeServicePromptProfileId: profile.id });
    }
    return db;
  }

  it("without a db handle the summarizer prompt is the bundled asset, byte-identical (SC-8a)", async () => {
    // The no-db path is the pre-SC-8a behavior: the asset's text IS the former
    // `SCRIPT_AGENT_COMPACTION_SYSTEM_PROMPT` constant, so the system message
    // must equal the loaded asset exactly (no trim, no trailing delta).
    const { store } = makeStore(makeThread("script_1"), makeTurnSequence(20));
    const calls: Array<Record<string, unknown>> = [];
    const execute = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { text: "script summary", providerResponse: {} };
    };
    const service = new ScriptAgentCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, execute as unknown as Executor);

    await service.compact({ threadId: "thread_1" });

    expect(getServicePromptAssetFile("script_agent_compaction")).toBe("agent-script/compaction.md");
    const asset = await loadPromptAsset(getServicePromptAssetFile("script_agent_compaction"));
    expect(asset.length).toBeGreaterThan(0);
    expect(systemMessageOf(calls[0].prompt as Record<string, unknown>)).toBe(asset);
    expect(systemMessageOf(calls[0].prompt as Record<string, unknown>)).toContain(SCRIPT_PROMPT_MARKER);
  });

  it("with a db and no override the resolver serves the same asset (SC-8a)", async () => {
    const db = await setupDb();
    const { store } = makeStore(makeThread("script_1"), makeTurnSequence(20));
    const calls: Array<Record<string, unknown>> = [];
    const execute = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { text: "script summary", providerResponse: {} };
    };
    const service = new ScriptAgentCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, execute as unknown as Executor, db);

    await service.compact({ threadId: "thread_1" });

    expect(systemMessageOf(calls[0].prompt as Record<string, unknown>)).toBe(
      await loadPromptAsset(getServicePromptAssetFile("script_agent_compaction")),
    );
  });

  it("an active-profile `script_agent_compaction` override replaces the summarizer prompt (SC-8a)", async () => {
    const db = await setupDb({ script_agent_compaction: "CUSTOM SCRIPT COMPACTION PROMPT" });
    const { store } = makeStore(makeThread("script_1"), makeTurnSequence(20));
    const calls: Array<Record<string, unknown>> = [];
    const execute = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { text: "script summary", providerResponse: {} };
    };
    const service = new ScriptAgentCompactionService(store, makeProviderProfiles() as unknown as ProviderProfileService, execute as unknown as Executor, db);

    await service.compact({ threadId: "thread_1" });

    expect(systemMessageOf(calls[0].prompt as Record<string, unknown>)).toBe("CUSTOM SCRIPT COMPACTION PROMPT");
  });
});

// ─── Adapter level: manual compaction dispatches by thread kind ──────────────

/** Local stand-in for the provider's chat-completions endpoint: records each
 *  request body and answers with a fixed non-streaming completion. */
const requestBodies: string[] = [];
const providerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    requestBodies.push(await req.text());
    return Response.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "model_1",
      choices: [{ index: 0, message: { role: "assistant", content: "summary from provider" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

afterAll(async () => {
  await providerServer.stop(true);
});

function makeAdapter(thread: ExperienceCopilotThread, script: ScriptRow | null) {
  const { store } = makeStore(thread, makeTurnSequence(20));
  const stores = {
    experienceCopilot: store,
    scripts: {
      async getById(scriptId: string) {
        return script && script.id === scriptId ? script : null;
      },
    },
  } as unknown as StoreContainer;
  const providerProfiles = makeProviderProfiles(`http://127.0.0.1:${providerServer.port}/v1`);
  return new ExperienceCopilotAdapter(stores, providerProfiles as unknown as ProviderProfileService);
}

describe("ExperienceCopilotAdapter.experienceCopilotCompact - dispatch by thread kind", () => {
  beforeEach(() => {
    requestBodies.length = 0;
  });

  it("a prompt/dice script thread compacts through the SCRIPT service", async () => {
    for (const scriptKind of ["prompt", "dice"]) {
      requestBodies.length = 0;
      const adapter = makeAdapter(makeThread("script_1"), makeScriptRow(scriptKind));

      const result = await adapter.experienceCopilotCompact("thread_1", {});

      expect(result.digest.content).toBe("summary from provider");
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).toContain(SCRIPT_PROMPT_MARKER);
      expect(requestBodies[0]).not.toContain(EXPERIENCE_PROMPT_MARKER);
    }
  });

  it("an interactive thread and a draft thread compact through the EXPERIENCE service", async () => {
    const interactive = makeAdapter(makeThread("script_1"), makeScriptRow("interactive"));
    await interactive.experienceCopilotCompact("thread_1", {});
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain(EXPERIENCE_PROMPT_MARKER);
    expect(requestBodies[0]).not.toContain(SCRIPT_PROMPT_MARKER);

    requestBodies.length = 0;
    const draft = makeAdapter(makeThread(null), null);
    await draft.experienceCopilotCompact("thread_1", {});
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain(EXPERIENCE_PROMPT_MARKER);
  });
});
