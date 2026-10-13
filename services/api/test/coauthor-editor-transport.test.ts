import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CoauthorEditorState } from "@vibe-tavern/api-contracts";
import { EventBus } from "@vibe-tavern/domain";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";
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

const editorState = {
  card: { name: "Unsaved editor name", body: "Unsaved editor body", greetings: [], cardClean: false },
  review: {
    targets: [
      { target: "card", roundId: "abcdef123456", outcome: "applied-partial", hunks: { accepted: 1, rejected: 1, pending: 2 } },
      { target: "lore", roundId: "123456abcdef", outcome: "awaiting", items: { offered: 3, selected: 2, applied: 0 } },
    ],
  },
} satisfies CoauthorEditorState;

const successNonstreaming: typeof nonstreamingProviderExecute = async () => ({
  text: "transport reply",
  providerResponse: { mode: "nonstream", steps: [] },
});

const successStream: typeof streamProviderExecutor = async () => ({
  stream: (async function* () {
    yield { type: "text-delta" as const, delta: "transport reply" };
  })(),
  finished: Promise.resolve({ finishReason: "stop" as const }),
  text: Promise.resolve("transport reply"),
  reasoning: Promise.resolve(undefined),
  hasRedactedReasoning: false,
  providerResponse: { mode: "stream" as const, steps: [] },
});

async function makeEnvironment() {
  const root = resolve(tmpdir(), `vt-coauthor-transport-${crypto.randomUUID().slice(0, 8)}`);
  roots.push(root);
  const dataDir = resolve(root, "data");
  await mkdir(dataDir, { recursive: true });
  const stores = await createRuntimeStore(dataDir);
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const coauthorProfile = await stores.providers.create({
    name: "Co-Author transport connection",
    providerPreset: "openai_compat",
    endpoint: "https://coauthor.example/v1",
    defaultModel: "coauthor-profile-default",
  });
  await stores.coauthorSettings.upsert(coauthorProfile.id, {
    modelName: "coauthor-transport-model",
    settings: { maxTokens: 128 },
  });
  await stores.uiSettings.update({ coauthorProviderId: coauthorProfile.id });
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({ name: "Transport", description: "probe", firstMessage: "Hello" });
  const coauthor = await runtime.chatLifecycle.createChatForCharacter(created.snapshot.character!.id, "coauthor");
  expect((await stores.chats.getById(coauthor.activeChat.id))?.mode).toBe("coauthor");

  const seen: Array<CoauthorEditorState | undefined> = [];
  const resolveStrategy = runtime.resolveChatModeStrategy.bind(runtime);
  runtime.resolveChatModeStrategy = async (chatId) => {
    const strategy = await resolveStrategy(chatId);
    return {
      mode: strategy.mode,
      resolveProvider: (input) => strategy.resolveProvider(input),
      async assemble(input) {
        expect(strategy.mode).toBe("coauthor");
        seen.push(input.coauthorEditorState);
        return strategy.assemble(input);
      },
      onMessageAppended: (input) => strategy.onMessageAppended(input),
    };
  };
  const orchestrator = new LiveChatOrchestrator(
    runtime.chatRuntime,
    runtime.chatApp,
    null as unknown as import("../src/domain/providers/provider-orchestrator.js").ProviderOrchestrator,
    new EventBus(),
    (chatId) => runtime.resolveChatModeStrategy(chatId),
    undefined,
    undefined,
    { nonstreaming: successNonstreaming, stream: successStream },
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
  return { app: await createApp({ runtime: { chat } as RuntimeApi }), chatId: coauthor.activeChat.id, seen, runtime };
}

async function post(app: Awaited<ReturnType<typeof createApp>>, path: string, body: object) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("co-author editor state transport", () => {
  test("non-stream co-author send preserves editor state through the user-insert assembly branch", async () => {
    const env = await makeEnvironment();
    const response = await post(env.app, `/api/chats/${env.chatId}/messages`, { content: "draft this", coauthorEditorState: editorState });
    expect(response.status).toBe(200);
    expect(env.seen).toEqual([editorState]);
    expect((await env.runtime.getSnapshot(env.chatId)).character?.name).toBe("Transport");
  });

  test("stream co-author send preserves editor state through the user-insert assembly branch", async () => {
    const env = await makeEnvironment();
    const response = await post(env.app, `/api/chats/${env.chatId}/messages/stream`, { content: "draft this", coauthorEditorState: editorState });
    expect(await response.text()).toContain("event: finish");
    expect(env.seen).toEqual([editorState]);
  });

  test("non-stream empty-content co-author assembly preserves state and does not retain it for a legacy request", async () => {
    const env = await makeEnvironment();
    expect((await post(env.app, `/api/chats/${env.chatId}/messages`, { content: "", coauthorEditorState: editorState })).status).toBe(200);
    expect((await post(env.app, `/api/chats/${env.chatId}/messages`, { content: "" })).status).toBe(200);
    expect(env.seen).toEqual([editorState, undefined]);
  });

  test("stream empty-content co-author assembly preserves state and does not retain it for a legacy request", async () => {
    const env = await makeEnvironment();
    await (await post(env.app, `/api/chats/${env.chatId}/messages/stream`, { content: "", coauthorEditorState: editorState })).text();
    await (await post(env.app, `/api/chats/${env.chatId}/messages/stream`, { content: "" })).text();
    expect(env.seen).toEqual([editorState, undefined]);
  });
});
