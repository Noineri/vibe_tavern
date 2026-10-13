import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CoauthorEditorState } from "@vibe-tavern/api-contracts";
import { EventBus, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
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

const profile: StoredProviderProfileRecord = {
  id: "transport-profile", name: "Transport profile", providerPreset: "openai", coauthorTransport: "chat_completions",
  endpoint: "https://provider.invalid/v1", apiKey: "test", defaultModel: "transport-model", contextBudget: null,
  pinContextBudget: false, bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false, maxTokens: 128,
  temperature: 1, topP: 1, topK: 0, minP: 0, topA: 0, typicalP: 1, tfsZ: 1, repeatLastN: 0,
  mirostat: 0, mirostatTau: 5, mirostatEta: 0.1, dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2,
  drySequenceBreakers: [], xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0,
  repetitionPenalty: 1, stopSequences: [], logitBias: [], seed: null, reasoningEffort: "auto", showReasoning: false,
  streamResponse: true, customSamplers: false, proxyMode: "direct", proxyId: null, isActive: true, visionModel: null,
  createdAt: "", updatedAt: "",
};

const editorState = {
  card: { name: "", body: "", greetings: ["", "hello"], cardClean: false },
  review: { targets: [] },
} satisfies CoauthorEditorState;

async function makeEnvironment() {
  const root = resolve(tmpdir(), `vt-coauthor-transport-${crypto.randomUUID().slice(0, 8)}`);
  roots.push(root);
  const dataDir = resolve(root, "data");
  await mkdir(dataDir, { recursive: true });
  const stores = await createRuntimeStore(dataDir);
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => profile });
  const created = await runtime.character.createFromScratch({ name: "Transport", description: "probe", firstMessage: "Hello" });
  const seen: Array<CoauthorEditorState | undefined> = [];
  const resolveStrategy = runtime.resolveChatModeStrategy.bind(runtime);
  runtime.resolveChatModeStrategy = async (chatId) => {
    const strategy = await resolveStrategy(chatId);
    return {
      mode: strategy.mode,
      resolveProvider: (input) => strategy.resolveProvider(input),
      async assemble(input) {
        seen.push(input.coauthorEditorState);
        return strategy.assemble(input);
      },
      onMessageAppended: (input) => strategy.onMessageAppended(input),
    };
  };
  const orchestrator = new LiveChatOrchestrator(runtime.chatRuntime, runtime.chatApp, null as unknown as import("../src/domain/providers/provider-orchestrator.js").ProviderOrchestrator, new EventBus(), (chatId) => runtime.resolveChatModeStrategy(chatId), undefined, undefined, {
    nonstreaming: (async () => { throw new Error("provider boundary reached"); }) as unknown as typeof import("../src/infrastructure/ai/nonstreaming-provider-executor.js").nonstreamingProviderExecute,
    stream: (async () => { throw new Error("provider boundary reached"); }) as unknown as typeof import("../src/infrastructure/ai/stream-provider-executor.js").streamProviderExecutor,
  });
  const providerProfiles = {
    resolveActiveProviderProfile: async () => profile,
    getProviderModelSettings: async () => null,
  } as ProviderProfileService;
  const chat = new ChatAdapter(stores, runtime, orchestrator, null as unknown as import("../src/domain/chat/chat-summary-service.js").ChatSummaryService, providerProfiles, null as unknown as import("../src/domain/asset/asset-service.js").AssetService, null as unknown as import("../src/api/contract/runtime-api.js").SttRuntimeApi["transcribeSttAudio"]);
  return { app: await createApp({ runtime: { chat } as RuntimeApi }), chatId: created.activeChatId, seen };
}

async function post(app: Awaited<ReturnType<typeof createApp>>, path: string, body: object) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("co-author editor state transport", () => {
  test("non-stream HTTP send preserves exact live empty editor fields to strategy input", async () => {
    const env = await makeEnvironment();
    const response = await post(env.app, `/api/chats/${env.chatId}/messages`, { content: "", coauthorEditorState: editorState });
    expect(response.status).toBe(500);
    expect(env.seen).toEqual([editorState]);
  });

  test("stream HTTP send preserves exact state while legacy omission remains absent", async () => {
    const env = await makeEnvironment();
    const streamed = await post(env.app, `/api/chats/${env.chatId}/messages/stream`, { content: "", coauthorEditorState: editorState });
    await streamed.text();
    const legacy = await post(env.app, `/api/chats/${env.chatId}/messages`, { content: "" });
    expect(legacy.status).toBe(500);
    expect(env.seen).toEqual([editorState, undefined]);
  });
});
