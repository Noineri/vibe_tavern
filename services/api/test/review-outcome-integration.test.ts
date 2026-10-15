/**
 * RO-6 executable bridge.
 *
 * The child web tests mount the real review controls and persist the exact body
 * sent by the real client transport. This test replays that untouched body into
 * the production in-process assembly seams, where the provider boundary alone
 * is stubbed. No HTTP server is bound.
 *
 * L1: temporary paths derive from tmpdir; every temp root is removed in
 * afterAll; child completion is the synchronization point; no global patches,
 * registry resets, sleeps, mocks, or ordering assumptions are used.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CoauthorEditorState, ExperienceCopilotStreamRequest } from "@vibe-tavern/api-contracts";
import { experienceCopilotStreamRequestSchema, sendMessageSchema } from "@vibe-tavern/api-contracts";
import type { ExperienceCopilotStore, ExperienceCopilotThread, ProviderProfile, ScriptRow } from "@vibe-tavern/db";
import { EventBus } from "@vibe-tavern/domain";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { streamExperienceCopilot } from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import type { ExperienceCopilotStreamDeps, ExperienceCopilotStreamEvent } from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { createApp } from "../src/server/app-factory.js";

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

const repoRoot = resolve(import.meta.dir, "../..");

async function mountedRequest(testFile: string, testName: string): Promise<unknown> {
  const root = resolve(tmpdir(), `vt-ro6-bridge-${crypto.randomUUID().slice(0, 8)}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  const output = resolve(root, "request.json");
  const child = Bun.spawn(
    ["bun", "run", "test:file", "--", testFile, "-t", testName],
    { cwd: repoRoot, env: { ...process.env, VT_REVIEW_OUTCOME_BRIDGE_OUTPUT: output }, stdout: "pipe", stderr: "pipe" },
  );
  if (await child.exited !== 0) {
    throw new Error(`Mounted bridge failed:\n${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`);
  }
  return JSON.parse(await readFile(output, "utf8"));
}

const successNonstreaming: typeof nonstreamingProviderExecute = async () => ({ text: "ok", providerResponse: { mode: "nonstream", steps: [] } });
const successStream: typeof streamProviderExecutor = async () => ({
  stream: (async function* () { yield { type: "text-delta" as const, delta: "ok" }; })(),
  finished: Promise.resolve({ finishReason: "stop" as const }),
  text: Promise.resolve("ok"),
  reasoning: Promise.resolve(undefined),
  hasRedactedReasoning: false,
  providerResponse: { mode: "stream" as const, steps: [] },
});

async function makeCoauthorEnvironment() {
  const root = resolve(tmpdir(), `vt-ro6-coauthor-${crypto.randomUUID().slice(0, 8)}`);
  roots.push(root);
  const dataDir = resolve(root, "data");
  await mkdir(dataDir, { recursive: true });
  const stores = await createRuntimeStore(dataDir);
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const profile = await stores.providers.create({ name: "RO-6", providerPreset: "openai_compat", endpoint: "https://ro6.example/v1", defaultModel: "ro6" });
  await stores.coauthorSettings.upsert(profile.id, { modelName: "ro6", settings: { maxTokens: 128 } });
  await stores.uiSettings.update({ coauthorProviderId: profile.id });
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const character = await runtime.character.createFromScratch({ name: "Saved stale name", description: "Saved stale description", firstMessage: "Saved stale greeting" });
  const coauthor = await runtime.chatLifecycle.createChatForCharacter(character.snapshot.character!.id, "coauthor");
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
      nonstreaming: async (input) => { providerInputs.push(input); return successNonstreaming(input); },
      stream: async (input) => { providerInputs.push(input); return successStream(input); },
    },
  );
  const providerProfiles = {
    resolveActiveProviderProfile: async () => null,
    getProviderModelSettings: async () => null,
    getProviderProfile: async (id: string) => stores.providers.getById(id),
  } as ProviderProfileService;
  const chat = new ChatAdapter(stores, runtime, orchestrator, null as unknown as import("../src/domain/chat/chat-summary-service.js").ChatSummaryService, providerProfiles, null as unknown as import("../src/domain/asset/asset-service.js").AssetService, null as unknown as import("../src/api/contract/runtime-api.js").SttRuntimeApi["transcribeSttAudio"]);
  return { app: await createApp({ runtime: { chat } as RuntimeApi }), chatId: coauthor.activeChat.id, providerInputs };
}

function profile(): ProviderProfile {
  return {
    id: "provider", name: "RO-6", providerPreset: "openai", coauthorTransport: "chatCompletions", endpoint: "http://ro6", apiKey: "key", defaultModel: "ro6", contextBudget: null, pinContextBudget: false, bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false, maxTokens: 2000, temperature: 0.3, topP: 1, topK: 0, minP: 0, topA: 0, typicalP: 1, tfsZ: 0, repeatLastN: 0, mirostat: 0, mirostatTau: 0, mirostatEta: 0, dryMultiplier: 0, dryBase: 0, dryAllowedLength: 0, drySequenceBreakers: null, xtcThreshold: 0, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1, stopSequences: [], logitBias: null, seed: null, reasoningEffort: "auto", showReasoning: false, streamResponse: true, customSamplers: false, proxyMode: "inherit", proxyId: null, isActive: true, visionModel: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
  } as ProviderProfile;
}

function copilotStore(): ExperienceCopilotStore {
  const thread: ExperienceCopilotThread = { id: "thread-new", scriptId: "script-ro6", draftSessionId: null, title: "RO-6", archivedAt: null, contextMetrics: null, contextLinks: [], todo: [], lastProviderProfileId: null, lastModel: null, autoCompact: true, createdAt: "", updatedAt: "" };
  return {
    getActive: async () => null, getById: async () => thread, listSessions: async () => [thread], startNewSession: async () => thread, activate: async () => thread, archive: async () => thread, listMessages: async () => [], appendMessage: async (_id, input) => ({ id: crypto.randomUUID(), threadId: thread.id, role: input.role, content: input.content ?? "", toolCallsJson: input.toolCallsJson ?? null, toolCallId: input.toolCallId ?? null, createdAt: "" }), updateContextMetrics: async () => {}, getAutoCompact: async () => true, setAutoCompact: async () => {}, updateTodo: async () => {}, setToolResultOutput: async () => null,
  } as unknown as ExperienceCopilotStore;
}

async function collect(stream: AsyncGenerator<ExperienceCopilotStreamEvent>): Promise<void> {
  for await (const _event of stream) { /* provider completion is the terminal synchronization point */ }
}

describe("review outcome mounted-client to provider integration (RO-6)", () => {
  test("replays a mounted partial co-author Apply through Hono into the real prompt and live tool base", async () => {
    const request = sendMessageSchema.parse(await mountedRequest("apps/web/src/components/coauthor/CoauthorCharacterForm.test.tsx", "RO-6 bridge"));
    const editor = request.coauthorEditorState as CoauthorEditorState;
    expect(editor.review.targets).toEqual([
      expect.objectContaining({ target: "card", outcome: "applied-partial", hunks: { accepted: 1, rejected: 1, pending: 0 } }),
      expect.objectContaining({ target: "lore", outcome: "applied-partial", items: { offered: 4, selected: 2, applied: 2 } }),
      expect.objectContaining({ target: "tracker_template", outcome: "rejected", selected: false }),
    ]);
    const env = await makeCoauthorEnvironment();
    const response = await env.app.request(`/api/chats/${env.chatId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    const input = env.providerInputs[0];
    if (!input) throw new Error("Expected the real provider boundary to receive the mounted request");
    const payload = JSON.stringify(input.prompt.finalPayload);
    expect(payload).toContain("Bold and direct.");
    expect(payload).not.toContain("Saved stale description");
    expect(payload).toContain("**applied-partial**");
    expect(payload).toContain("**rejected**");
    const tool = input.tools?.edit_personality;
    if (!tool || typeof tool.execute !== "function") throw new Error("Expected edit_personality from the real co-author tool builder");
    const result = await tool.execute({ edits: [{ search: "Bold and direct.", replace: "Provider mutation from mounted body." }], summary: "RO-6" }, { messages: [], toolCallId: "ro6", abort: () => {} });
    expect(JSON.stringify(result)).toContain("Provider mutation from mounted body.");
    await expect(tool.execute({ edits: [{ search: "Saved stale description", replace: "wrong base" }], summary: "RO-6 stale" }, { messages: [], toolCallId: "ro6-stale", abort: () => {} })).rejects.toThrow();
  });

  test("replays a mounted accepted unsaved copilot buffer into provider messages and tool seeds", async () => {
    const request = experienceCopilotStreamRequestSchema.parse(await mountedRequest("apps/web/src/components/build/editors/copilot/ExperienceCopilotShell.test.tsx", "RO-6 bridge"));
    expect(request.rulesSaved).toBe(false);
    expect(request.visualSaved).toBe(true);
    expect(request.reviewSnapshot?.targets).toEqual([expect.objectContaining({ target: "rules", outcome: "applied", hunks: { accepted: 2, rejected: 0, pending: 0 } })]);
    let captured: { messages?: Array<{ role: string; content: unknown }>; tools?: Record<string, { execute?: (input: unknown, context: unknown) => Promise<unknown> }> } | undefined;
    const script: ScriptRow = { id: "script-ro6", name: "Saved script", description: "", code: "SAVED STALE RULES", enabled: true, scriptKind: "interactive", origin: "in_app", firstEnabledAt: null, creationIntentId: null, scopeType: "global", sortOrder: 0, characterId: null, personaId: null, chatId: null, defaultVisualId: null, copilotProfileId: null, extensions: {}, createdAt: "", updatedAt: "" };
    const deps: ExperienceCopilotStreamDeps = {
      store: copilotStore(), agentPlans: { get: async () => null, save: async () => {} }, getScript: async () => script, getBoundVisualIds: async () => [], getVisual: async () => null, getProviderProfile: async () => profile(), getEffectiveProviderProfile: async () => profile(), resolveModel: () => ({} as import("ai").LanguageModel), streamText: ((options: unknown) => { captured = options as typeof captured; return { stream: (async function* () { yield { type: "text-delta", text: "ok" }; })(), finishReason: Promise.resolve("stop"), usage: Promise.resolve(undefined) }; }) as ExperienceCopilotStreamDeps["streamText"],
    };
    await collect(streamExperienceCopilot(request as ExperienceCopilotStreamRequest, deps));
    const providerMessages = JSON.stringify(captured?.messages);
    expect(providerMessages).toContain("// RULES v2");
    expect(providerMessages).not.toContain("SAVED STALE RULES");
    expect(providerMessages).toContain("rules buffer: unsaved");
    expect(providerMessages).toContain("rules round `388fa0fd5119`: **applied**");
    const write = captured?.tools?.write_buffer;
    if (!write?.execute) throw new Error("Expected write_buffer from the real copilot tool builder");
    await expect(write.execute({ target: "rules", content: `${request.rules}\n// provider mutation`, summary: "RO-6" }, null)).rejects.toThrow(/proposed rules failed validation/);
    const visualProposal = await write.execute({ target: "visual", content: "<main>provider mutation</main>", summary: "RO-6 visual" }, null);
    expect(visualProposal).toMatchObject({ target: "visual", proposed: "<main>provider mutation</main>" });
  });
});
