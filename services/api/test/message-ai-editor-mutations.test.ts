import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventBus, type ChatId } from "@vibe-tavern/domain";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { RuntimeApiAdapter } from "../src/api/adapters/runtime-api-adapter.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { ObjectiveService } from "../src/domain/insights/objective-service.js";
import { SceneTrackerService } from "../src/domain/insights/tracker-service.js";
import { MobileAccessService } from "../src/domain/mobile-access/mobile-access-service.js";
import { PromptPresetService } from "../src/domain/prompt/prompt-preset-service.js";
import { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { SkillLibraryService } from "../src/domain/coauthor/skills/skill-library.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { createApp } from "../src/server/app-factory.js";

// These are full HTTP/runtime/SQLite boundary tests, and every case provisions
// a fresh application. Windows CI can exceed Bun's 5-second per-test default
// under parallel runner load without the guarded mutation itself being stuck.
setDefaultTimeout(30_000);

type TestEnvironment = {
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly chatId: ChatId;
  readonly runtime: SessionRuntime;
  readonly stores: Awaited<ReturnType<typeof createRuntimeStore>>;
  readonly cleanup: () => Promise<void>;
};

type VariantRequest = {
  readonly chatId: ChatId;
  readonly messageId: string;
  readonly content: string;
  readonly sourceVariantIds: readonly string[];
  readonly modelId?: string;
  readonly promptPresetId?: string;
  readonly finishReason?: string;
};

async function createTestEnvironment(): Promise<TestEnvironment> {
  const root = resolve(tmpdir(), `vt-mae32-${crypto.randomUUID().slice(0, 8)}`);
  const dataDir = resolve(root, "data");
  const assetsDir = resolve(root, "assets");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(assetsDir, { recursive: true }),
    mkdir(resolve(root, "user-skills"), { recursive: true }),
    mkdir(resolve(root, "builtin-skills"), { recursive: true }),
  ]);

  const stores = await createRuntimeStore(dataDir);
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);

  const providerProfiles = createProviderProfileService(stores.providers);
  const runtime = new SessionRuntime(stores, {
    getActiveProviderProfile: () => providerProfiles.resolveActiveProviderProfile(),
  });
  const events = new EventBus();
  const liveChat = new LiveChatOrchestrator(
    runtime.chatRuntime,
    runtime.chatApp,
    new ProviderOrchestrator(providerProfiles),
    events,
    (chatId) => runtime.resolveChatModeStrategy(chatId),
  );
  const runtimeApi = new RuntimeApiAdapter(
    stores,
    providerProfiles,
    liveChat,
    new ChatSummaryService(stores, runtime, providerProfiles),
    runtime,
    new PromptPresetService(stores.presets, stores.chats),
    new AssetService(assetsDir, stores.content, (characterId) => stores.characters.resolveFolderName(characterId)),
    new MobileAccessService(dataDir),
    new ObjectiveService(stores, runtime, providerProfiles),
    new SceneTrackerService(stores, runtime, providerProfiles),
    new SkillLibraryService(resolve(root, "user-skills"), resolve(root, "builtin-skills")),
  );
  const created = await runtime.character.createFromScratch({
    name: "Mutation Probe",
    description: "route boundary test character",
    firstMessage: "Hello",
  });

  return {
    app: await createApp({ runtime: runtimeApi }),
    chatId: created.activeChatId,
    runtime,
    stores,
    cleanup: async () => {
      // Windows briefly holds SQLite WAL handles after the runtime drops them,
      // so `rm` can race with EBUSY/EPERM. The temp dir is disposable (the OS
      // reaps it); a locked-dir error here must not fail the assertions above.
      try {
        await rm(root, { recursive: true, force: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!(typeof code === "string" && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(code))) throw err;
      }
    },
  };
}

async function postVariant(app: TestEnvironment["app"], request: VariantRequest): Promise<Response> {
  const { chatId, messageId, ...body } = request;
  return app.request(`/api/chats/${chatId}/messages/${messageId}/variants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedTwoVariants(env: TestEnvironment) {
  const message = (await env.runtime.getSnapshot(env.chatId)).messages[0];
  if (!message) throw new Error("expected seeded greeting message");
  const [first] = await env.stores.messages.getVariants(message.id);
  if (!first) throw new Error("expected seeded greeting variant");
  const second = await env.stores.messages.addVariant(message.id, "alternate source");
  return { message, first, second };
}

describe("Message AI editor guarded mutations (MAE-32)", () => {
  let env: TestEnvironment;

  beforeAll(() => setTokenCountFn((text: string) => text.length));
  beforeEach(async () => {
    env = await createTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  test("returns 409 and leaves every variant unchanged when the guarded edit is stale", async () => {
    // Given
    const { message, first, second } = await seedTwoVariants(env);
    const before = await env.stores.messages.getVariants(message.id);

    // When
    const response = await env.app.request(`/api/chats/${env.chatId}/messages/${message.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "must not overwrite", expectedVariantId: first.id }),
    });

    // Then
    expect(response.status).toBe(409);
    expect(second.isSelected).toBeTrue();
    expect(await env.stores.messages.getVariants(message.id)).toEqual(before);
  });

  test("rejects a message routed under another chat without appending", async () => {
    // Given
    const { message, first, second } = await seedTwoVariants(env);
    const foreign = await env.runtime.character.createFromScratch({
      name: "Foreign Probe",
      description: "separate chat",
      firstMessage: "Elsewhere",
    });
    const before = await env.stores.messages.getVariants(message.id);

    // When
    const response = await postVariant(env.app, {
      chatId: foreign.activeChatId,
      messageId: message.id,
      content: "invalid cross-chat merge",
      sourceVariantIds: [first.id, second.id],
    });

    // Then
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { kind: "NotFound" } });
    expect(await env.stores.messages.getVariants(message.id)).toEqual(before);
  });

  test("rejects source variants owned by another message or deleted before acceptance", async () => {
    // Given
    const { message, first, second } = await seedTwoVariants(env);
    const otherMessage = await env.runtime.chatApp.appendUserMessage(env.chatId, { content: "second message" });
    const [otherVariant] = await env.stores.messages.getVariants(otherMessage.id);
    if (!otherVariant) throw new Error("expected another message variant");
    await env.stores.messages.deleteVariant(message.id, second.variantIndex);
    const before = await env.stores.messages.getVariants(message.id);

    // When
    const responses = await Promise.all([
      postVariant(env.app, {
        chatId: env.chatId,
        messageId: message.id,
        content: "invalid other-message merge",
        sourceVariantIds: [first.id, otherVariant.id],
      }),
      postVariant(env.app, {
        chatId: env.chatId,
        messageId: message.id,
        content: "invalid deleted-source merge",
        sourceVariantIds: [first.id, second.id],
      }),
    ]);

    // Then
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({ error: { kind: "NotFound" } });
    }
    expect(await env.stores.messages.getVariants(message.id)).toEqual(before);
  });

  test("appends and selects the candidate, preserves every prior swipe, and returns only the message patch", async () => {
    // Given
    const { message, first, second } = await seedTwoVariants(env);
    const promptPresetId = (await env.runtime.getSnapshot(env.chatId)).activeChat.promptPresetId;
    if (!promptPresetId) throw new Error("expected seeded prompt preset");
    const expectedPresetName = (await env.stores.presets.getById(promptPresetId as string))?.name;
    // The editor commit is always preceded by an assemble (it builds the
    // editor prompt); that sets the pending draft whose baked preset name the
    // editor variant records.
    await env.runtime.chatRuntime.assemblePromptPreview(env.chatId, { excludeMessageId: message.id, model: "editor-model" });

    // When
    const response = await postVariant(env.app, {
      chatId: env.chatId,
      messageId: message.id,
      content: "accepted merge candidate",
      sourceVariantIds: [first.id, second.id],
      modelId: "editor-model",
      promptPresetId,
      finishReason: "stop",
    });

    // Then
    expect(response.status).toBe(200);
    const patch = await response.json();
    expect(Object.keys(patch).sort()).toEqual(["messages", "promptTrace"]);
    expect(patch.messages).toHaveLength((await env.runtime.getSnapshot(env.chatId)).messages.length);
    const variants = await env.stores.messages.getVariants(message.id);
    expect(variants.map((variant) => variant.content)).toEqual(["Hello", "alternate source", "accepted merge candidate"]);
    expect(variants.map((variant) => variant.isSelected)).toEqual([false, false, true]);
    expect(variants[2]).toMatchObject({ modelId: "editor-model", presetName: expectedPresetName, finishReason: "stop" });
  });

  test("leaves a pending generation trace available for the subsequent generated variant", async () => {
    // Given
    const { message, first, second } = await seedTwoVariants(env);
    const promptPresetId = (await env.runtime.getSnapshot(env.chatId)).activeChat.promptPresetId;
    if (!promptPresetId) throw new Error("expected seeded prompt preset");
    const expectedPresetName = (await env.stores.presets.getById(promptPresetId as string))?.name;
    await env.runtime.chatRuntime.assemblePromptPreview(env.chatId, {
      excludeMessageId: message.id,
      model: "pending-generation-model",
    });

    // When
    await env.runtime.chatRuntime.addEditorVariant(env.chatId, message.id, {
      content: "accepted without trace consumption",
      sourceVariantIds: [first.id, second.id],
      modelId: "editor-model",
      promptPresetId,
      finishReason: "stop",
    });
    await env.runtime.chatRuntime.appendMessageVariant(env.chatId, message.id, {
      content: "next generated variant",
      finishReason: "length",
      latencyMs: 1,
    });

    // Then
    const variants = await env.stores.messages.getVariants(message.id);
    expect(variants[2]).toMatchObject({ modelId: "editor-model", presetName: expectedPresetName, finishReason: "stop" });
    expect(variants[3]).toMatchObject({ modelId: "pending-generation-model", finishReason: "length" });
  });
});
