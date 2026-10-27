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

const editorState = {
  card: { name: "Unsaved editor name", body: "Unsaved editor body", greetings: [], cardClean: false },
  review: {
    targets: [
      { target: "card", roundId: "abcdef123456", outcome: "applied-partial", hunks: { accepted: 1, rejected: 1, pending: 2 } },
      { target: "lore", roundId: "123456abcdef", outcome: "awaiting", items: { offered: 3, selected: 2, applied: 0 } },
    ],
  },
} satisfies CoauthorEditorState;

const emptyEditorState = {
  card: { name: "", body: "", greetings: ["", "hello"], cardClean: false },
  review: { targets: [] },
} satisfies CoauthorEditorState;

const semanticEditorState = {
  card: {
    name: "Live provider name",
    body: "# PERSONALITY\nLive provider personality.\n\n# SCENARIO\nLive provider scenario.\n\n# EXAMPLES\nLive provider example.\n\n# GREETINGS\nSynthetic view only.",
    greetings: ["Live provider greeting", "Live provider alternate"],
    cardClean: false,
  },
  review: {
    targets: [
      { target: "card", roundId: "abcdef123456", outcome: "applied", hunks: { accepted: 2, rejected: 0, pending: 1 } },
      { target: "lore", roundId: "123456abcdef", outcome: "rejected", items: { offered: 3, selected: 1, applied: 0 } },
      { target: "tracker_template", roundId: "fedcba654321", outcome: "awaiting", selected: true },
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
  const providerInputs: ProviderExecutionInput[] = [];
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
    {
      nonstreaming: async (input) => {
        providerInputs.push(input);
        return successNonstreaming(input);
      },
      stream: async (input) => {
        providerInputs.push(input);
        return successStream(input);
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
  return { app: await createApp({ runtime: { chat } as RuntimeApi }), chatId: coauthor.activeChat.id, seen, providerInputs, runtime };
}

async function post(app: Awaited<ReturnType<typeof createApp>>, path: string, body: object) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("co-author editor state transport", () => {
  test("both HTTP sends bind the semantic editor snapshot to the provider prompt and mutation tool base", async () => {
    for (const path of ["messages", "messages/stream"]) {
      const env = await makeEnvironment();
      const saved = await env.runtime.getSnapshot(env.chatId);
      const response = await post(env.app, `/api/chats/${env.chatId}/${path}`, { content: "use live editor", coauthorEditorState: semanticEditorState });
      if (path.endsWith("stream")) {
        expect(await response.text()).toContain("event: finish");
      } else {
        expect(response.status).toBe(200);
      }
      expect(env.providerInputs).toHaveLength(1);
      const input = env.providerInputs[0]!;
      const payload = JSON.stringify(input.prompt.finalPayload);
      expect(payload).toContain("Live provider name");
      expect(payload).toContain("Live provider personality.");
      expect(payload).toContain("Live provider scenario.");
      expect(payload).toContain("Live provider greeting");
      expect(payload).toContain("- card buffer: unsaved");
      expect(payload).toContain("- card round `abcdef123456`: **applied** (hunks: accepted 2, rejected 0, pending 1)");
      expect(payload).toContain("- lore round `123456abcdef`: **rejected** (items: offered 3, selected 1, applied 0)");
      expect(payload).toContain("- tracker_template round `fedcba654321`: **awaiting** (selected: yes)");

      const tool = input.tools?.edit_personality;
      if (!tool || typeof tool.execute !== "function") throw new Error("Expected provider-bound edit_personality tool");
      const output = await tool.execute(
        { edits: [{ search: "Live provider personality.", replace: "Provider-mutated live personality." }], summary: "mutate live base" },
        { messages: [], toolCallId: "provider-tool", abort: () => {} },
      );
      const proposed = JSON.stringify(output);
      expect(proposed).toContain("Provider-mutated live personality.");
      expect(proposed).toContain("Live provider scenario.");
      expect(proposed).toContain("name: Live provider name");
      const after = await env.runtime.getSnapshot(env.chatId);
      expect(after.character?.name).toBe(saved.character?.name);
      expect(after.character?.description).toBe(saved.character?.description);
      expect(after.character?.firstMessage).toBe(saved.character?.firstMessage);
      expect(after.character?.alternateGreetings).toEqual(saved.character?.alternateGreetings);
    }
  });

  test("both HTTP sends keep explicit empty editor state live, then return to the saved source when omitted", async () => {
    const emptyLiveState = {
      card: { name: "", body: "", greetings: [], cardClean: false },
      review: { targets: [] },
    } satisfies CoauthorEditorState;
    for (const path of ["messages", "messages/stream"]) {
      const env = await makeEnvironment();
      const saved = await env.runtime.getSnapshot(env.chatId);
      const emptyResponse = await post(env.app, `/api/chats/${env.chatId}/${path}`, { content: "", coauthorEditorState: emptyLiveState });
      if (path.endsWith("stream")) {
        await emptyResponse.text();
      } else {
        expect(emptyResponse.status).toBe(200);
      }
      expect(env.providerInputs).toHaveLength(1);
      const liveInput = env.providerInputs[0]!;
      const livePayload = JSON.stringify(liveInput.prompt.finalPayload);
      expect(livePayload).toContain("name: \\\"\\\"");
      expect(livePayload).not.toContain("probe");
      expect(livePayload).not.toContain("Hello");
      const tool = liveInput.tools?.edit_personality;
      if (!tool || typeof tool.execute !== "function") throw new Error("Expected provider-bound edit_personality tool");
      await expect(tool.execute(
        { edits: [{ search: "probe", replace: "x" }], summary: "must remain empty" },
        { messages: [], toolCallId: "empty-provider-tool", abort: () => {} },
      )).rejects.toThrow(/PERSONALITY section is empty.*write_personality/);

      const legacyResponse = await post(env.app, `/api/chats/${env.chatId}/${path}`, { content: "" });
      if (path.endsWith("stream")) {
        await legacyResponse.text();
      } else {
        expect(legacyResponse.status).toBe(200);
      }
      expect(env.providerInputs).toHaveLength(2);
      const legacyPayload = JSON.stringify(env.providerInputs[1]!.prompt.finalPayload);
      expect(legacyPayload).toContain("probe");
      expect(legacyPayload).toContain("Hello");
      expect(legacyPayload).not.toContain("# Editor review and save state");
      const after = await env.runtime.getSnapshot(env.chatId);
      expect(after.character?.name).toBe(saved.character?.name);
      expect(after.character?.description).toBe(saved.character?.description);
      expect(after.character?.firstMessage).toBe(saved.character?.firstMessage);
      expect(after.character?.alternateGreetings).toEqual(saved.character?.alternateGreetings);
    }
  });

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
    expect((await post(env.app, `/api/chats/${env.chatId}/messages`, { content: "", coauthorEditorState: emptyEditorState })).status).toBe(200);
    expect((await post(env.app, `/api/chats/${env.chatId}/messages`, { content: "" })).status).toBe(200);
    expect(env.seen).toEqual([emptyEditorState, undefined]);
  });

  test("stream empty-content co-author assembly preserves state and does not retain it for a legacy request", async () => {
    const env = await makeEnvironment();
    await (await post(env.app, `/api/chats/${env.chatId}/messages/stream`, { content: "", coauthorEditorState: emptyEditorState })).text();
    await (await post(env.app, `/api/chats/${env.chatId}/messages/stream`, { content: "" })).text();
    expect(env.seen).toEqual([emptyEditorState, undefined]);
  });
});
