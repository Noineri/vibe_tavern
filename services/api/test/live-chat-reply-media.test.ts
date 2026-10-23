import { describe, expect, test } from "bun:test";
import { EventBus, type Attachment, type AssemblePromptResponse, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { RpModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import type { ChatRuntime } from "../src/runtime/session/session-runtime-chat.js";
import type { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { createStoreContainer } from "@vibe-tavern/db";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { prepareSdkMessages, toSdkMessages } from "../src/infrastructure/ai/provider-executor-utils.js";
import { VisionNotSupportedError } from "../src/infrastructure/ai/vision-gate.js";
import { VoiceTranscribeUnavailableError } from "../src/infrastructure/ai/stt-gate.js";
import { ProviderExecutionError } from "../src/infrastructure/ai/provider-execution-types.js";

// T1 characterization: only the runtime and executor constructor seams are
// doubled. No global state, module mocks, sleeps or machine-specific paths.
const profile = {
  id: "profile_1", name: "Probe", providerPreset: "multiai", defaultModel: "vision-model",
  endpoint: "https://provider.invalid/v1", contextBudget: null, maxTokens: 128, tokenPadding: 0,
} as StoredProviderProfileRecord;
const image: Attachment = {
  id: "image_1", assetId: "image_asset", type: "image", name: "scene.png", mimeType: "image/png", sizeBytes: 4, description: "A red tower",
};

describe("regenerate executor options characterization (CA-1b2)", () => {
  for (const attachments of [undefined, [image]]) {
    test(`pins the complete regenerate call with attachments=${Boolean(attachments)}`, async () => {
      const prompt: AssemblePromptResponse = {
        layers: [{ id: "recent_history", text: "USER: Look" }],
        finalPayload: { messages: [{ role: "user", content: "Look", messageId: "user_1", ...(attachments ? { attachments } : {}) }] },
      };
      const inputs: ProviderExecutionInput[] = [];
      const runtime = {
        assemblePromptPreview: async () => prompt,
        patchPendingTrace: () => {},
        discardPendingPromptTrace: () => {},
        appendMessageVariant: async () => ({ messages: [] }),
      } as unknown as ChatRuntime;
      const orchestrator = new LiveChatOrchestrator(
        runtime, {} as ChatApplicationService, {} as ProviderOrchestrator, new EventBus(), async () => new RpModeStrategy(),
        undefined, undefined, {
          nonstreaming: async (input) => {
            inputs.push(input);
            return { text: "Reply", providerResponse: { mode: "nonstream", steps: [] } };
          },
          stream: async () => { throw new Error("Not a streaming test"); },
        },
      );
      await orchestrator.regenerateMessage({ chatId: "chat_1", messageId: "assistant_1", profile, model: "vision-model" });
      expect(inputs).toHaveLength(1);
      expect(JSON.stringify(inputs[0])).toBe(JSON.stringify({ profile, model: "vision-model", prompt }));
      expect(inputs[0]?.prompt).toBe(prompt);
    });
  }
});

type ReplyPath = "send" | "send-stream" | "regenerate" | "regenerate-stream" | "continue" | "continue-stream" | "generate" | "generate-stream";
const paths: ReplyPath[] = ["send", "send-stream", "regenerate", "regenerate-stream", "continue", "continue-stream", "generate", "generate-stream"];
interface EnvOptions {
  media?: "image" | "raw-image" | "file" | "voice" | "raw-voice" | "none";
  model?: "vision-model" | "text-model";
  fallback?: boolean;
  rejectPrefill?: boolean;
  descriptions?: Array<{ attachmentId: string; description: string }>;
}

// T2 executor boundary; everything below it (adapter, profile overlays/cache,
// stores, runtime assembly, attachment loading and real vision gate) runs real.
async function withEnv(options: EnvOptions, run: (env: {
  adapter: ChatAdapter; chatId: string; userId: string; assistantId: string; attachment?: Attachment;
  profile: StoredProviderProfileRecord; inputs: ProviderExecutionInput[];
  prepared: Array<Awaited<ReturnType<typeof prepareSdkMessages>>>;
  stores: Awaited<ReturnType<typeof createStoreContainer>>;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vt-reply-media-"));
  try {
    const stores = await createStoreContainer(":memory:", dir);
    await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
    const voiceProfile = options.media === "raw-voice" ? null : await stores.stt.create({
      name: "Voice probe", backend: "openai-compat", config: { endpoint: "https://stt.invalid", model: "whisper" },
      emotionAnnotation: false, isDefault: true,
    });
    const profiles = createProviderProfileService(stores.providers, stores.proxies);
    const base = await stores.providers.create({
      name: "Media probe", providerPreset: options.fallback ? "anthropic" : "multiai",
      endpoint: "https://provider.invalid/v1", defaultModel: options.model ?? "vision-model", bindPerModel: true,
    });
    await profiles.activateProviderProfile(base.id);
    await profiles.upsertProviderModelSettings(base.id, "text-model", { temperature: 0.25 });
    await stores.providers.saveCachedModels(base.id, [
      { modelSlug: "vision-model", modelName: "Vision", contextLength: null, capabilities: { vision: true } },
      { modelSlug: "text-model", modelName: "Text", contextLength: null, capabilities: { vision: false } },
    ]);
    const runtime = new SessionRuntime(stores, { getActiveProviderProfile: () => profiles.resolveActiveProviderProfile() });
    const created = await runtime.character.createFromScratch({ name: "ReplyProbe", description: "A probe", firstMessage: "Hello" });
    const chat = await stores.chats.getById(created.activeChatId);
    if (!chat) throw new Error("Missing seed chat");
    const assets = new AssetService(join(dir, "assets"));
    let attachment: Attachment | undefined;
    if (options.media !== "none") {
      const media = options.media ?? "image";
      const text = media === "file";
      const voice = media === "voice" || media === "raw-voice";
      const name = text ? "notes.md" : voice ? "note.webm" : "scene.png";
      const mimeType = text ? "text/markdown" : voice ? "audio/webm" : "image/png";
      const bytes = text ? Buffer.from("Full file text\n  Last line\n") : Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const uploaded = await assets.upload(new File([bytes], name, { type: mimeType }));
      attachment = {
        id: "history_attachment", assetId: uploaded.assetId, name, mimeType, type: text ? "file" : voice ? "audio" : "image", sizeBytes: bytes.length,
        ...(!text && media !== "raw-image" && media !== "raw-voice" ? { description: voice ? "Spoken words" : "A red tower" } : {}),
      };
    }
    const user = await stores.messages.addMessage({
      chatId: chat.id, branchId: chat.activeBranchId, role: "user", authorType: "user", content: "Look",
      attachmentsJson: attachment ? JSON.stringify([attachment]) : null,
    });
    const assistant = await stores.messages.addMessage({
      chatId: chat.id, branchId: chat.activeBranchId, role: "assistant", authorType: "character", content: "The story begins",
    });
    const inputs: ProviderExecutionInput[] = [];
    const prepared: Array<Awaited<ReturnType<typeof prepareSdkMessages>>> = [];
    const prefillRejection = () => new ProviderExecutionError(
      "The conversation cannot end with a model response. Add a user or tool message before continuing.", "invalid_request", "openai_compat", { statusCode: 400 },
    );
    const execute = async (input: ProviderExecutionInput, rejectImmediately = true) => {
      inputs.push(input);
      if (rejectImmediately && options.rejectPrefill && input.prefill && !input.continuationFallback) {
        throw prefillRejection();
      }
      if (options.descriptions) await input.onAttachmentDescriptions?.(options.descriptions);
      prepared.push(await prepareSdkMessages(toSdkMessages(input.prompt), {
        providerType: "openai_compat",
        visionGate: { hasVision: input.cachedModels?.find((model) => model.modelSlug === input.model)?.capabilities?.vision ?? false, visionModel: input.visionModel ?? null },
        assetLoader: input.assetLoader,
      }));
      return { text: "A reply", providerResponse: { mode: "nonstream" as const, steps: [] } };
    };
    const orchestrator = new LiveChatOrchestrator(
      runtime.chatRuntime, runtime.chatApp, new ProviderOrchestrator(profiles), new EventBus(), async () => new RpModeStrategy(),
      undefined, undefined, {
        nonstreaming: execute,
        stream: async (input) => {
          await execute(input, false);
          return {
            stream: (async function* () {
              // Provider streaming errors are lazy, not startStream failures.
              if (options.rejectPrefill && input.prefill && !input.continuationFallback) throw prefillRejection();
              yield { type: "text-delta" as const, delta: "A reply" };
            })(),
            text: Promise.resolve("A reply"), reasoning: Promise.resolve(undefined),
            finished: Promise.resolve({ finishReason: "stop" }), hasRedactedReasoning: false,
            providerResponse: { mode: "stream", steps: [] },
          };
        },
      },
    );
    const adapter = new ChatAdapter(stores, runtime, orchestrator, new ChatSummaryService(stores, runtime, profiles), profiles, assets, async (id) => {
      if (id !== voiceProfile?.id) throw new Error("Wrong voice profile binding");
      return { text: "Probe transcript" };
    });
    await run({ adapter, chatId: chat.id, userId: user.id, assistantId: assistant.id, attachment, profile: base, inputs, prepared, stores });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function invoke(path: ReplyPath, env: Parameters<Parameters<typeof withEnv>[1]>[0], overrideModel?: string) {
  const { adapter, chatId, assistantId } = env;
  let events: AsyncGenerator<{ event: string; data: string }> | undefined;
  switch (path) {
    case "send": await adapter.sendMessage(chatId, { content: "Next" }); break;
    case "send-stream": events = adapter.sendMessageStream(chatId, { content: "Next" }); break;
    case "regenerate": await adapter.regenerateMessage(chatId, assistantId, { model: overrideModel }); break;
    case "regenerate-stream": events = adapter.regenerateMessageStream(chatId, assistantId, { model: overrideModel }); break;
    case "continue": await adapter.continueMessage(chatId, assistantId); break;
    case "continue-stream": events = adapter.continueMessageStream(chatId, assistantId); break;
    case "generate": await adapter.generateReply(chatId); break;
    case "generate-stream": events = adapter.generateReplyStream(chatId); break;
  }
  if (events) {
    const received = [];
    for await (const event of events) received.push(event);
    expect(received.some((event) => event.event === "finish")).toBe(true);
    expect(received.some((event) => event.event === "error")).toBe(false);
  }
}

describe("reply media through real adapter and runtime (CA-1b2)", () => {
  for (const path of paths) {
    for (const model of ["vision-model", "text-model"] as const) {
      test(`${path}: ${model} receives history pixels or its stored description`, async () => {
        const regenerate = path.startsWith("regenerate");
        await withEnv({ model: regenerate ? "vision-model" : model }, async (env) => {
          await invoke(path, env, regenerate ? model : undefined);
          const input = env.inputs[0]!;
          expect(input.model).toBe(model);
          expect(input.profile.id).toBe(env.profile.id);
          expect(input.profile.defaultModel).toBe(model);
          if (model === "text-model") expect(input.profile.temperature).toBe(0.25);
          expect(input.cachedModels?.find((entry) => entry.modelSlug === model)?.capabilities?.vision).toBe(model === "vision-model");
          expect(input.assetLoader).toBeFunction();
          expect(await input.voiceTranscriber?.({ buffer: Buffer.from("audio"), mimeType: "audio/webm", fileName: "note.webm" })).toEqual({ transcript: "Probe transcript" });
          expect(input.visionDescribePrompt?.length).toBeGreaterThan(0);
          const wire = env.prepared[0]!.conversationMessages;
          const content = wire.flatMap((message) => Array.isArray(message.content) ? message.content : []);
          expect(content.some((part) => part.type === "image")).toBe(model === "vision-model");
          expect(JSON.stringify(wire).includes("A red tower")).toBe(model === "text-model");
        });
      });
    }
  }

  for (const path of paths.filter((path) => !path.startsWith("send"))) {
    test(`${path}: full history file text and voice transcripts reach the gate`, async () => {
      for (const media of ["file", "voice"] as const) {
        await withEnv({ media }, async (env) => {
          await invoke(path, env);
          expect(JSON.stringify(env.prepared[0]!.conversationMessages)).toContain(media === "file" ? "Full file text\\n  Last line\\n" : "Transcript: Spoken words");
        });
      }
    });
  }

  for (const stream of [false, true]) {
    for (const retry of [false, true]) {
      test(`continue fallback stream=${stream} retry=${retry}: attachments survive every attempt`, async () => {
        await withEnv({ media: "file", fallback: !retry, rejectPrefill: retry }, async (env) => {
          await invoke(stream ? "continue-stream" : "continue", env);
          expect(env.inputs).toHaveLength(retry ? 2 : 1);
          expect(env.inputs.at(-1)?.continuationFallback).toBe(true);
          expect(env.inputs.every((input) => typeof input.assetLoader === "function")).toBe(true);
          expect(env.inputs.every((input) => typeof input.voiceTranscriber === "function")).toBe(true);
          expect(JSON.stringify(env.prepared.at(-1)?.conversationMessages)).toContain("Full file text");
        });
      });
    }
  }

  for (const path of ["regenerate", "regenerate-stream", "continue", "continue-stream", "generate", "generate-stream"] as const) {
    test(`${path}: attachment-free history stays plain text`, async () => {
      await withEnv({ media: "none" }, async (env) => {
        await invoke(path, env);
        const messages = toSdkMessages(env.inputs[0]!.prompt);
        expect(messages.some((message) => message.attachments?.length)).toBe(false);
        expect(messages.find((message) => message.role === "user")?.content).toBe("Look");
        expect(env.prepared[0]!.conversationMessages.every((message) => typeof message.content === "string")).toBe(true);
      });
    });

    test(`${path}: executor-produced descriptions persist on the owning history message`, async () => {
      await withEnv({ descriptions: [{ attachmentId: "history_attachment", description: "Fresh description" }] }, async (env) => {
        await invoke(path, env);
        const owner = await env.stores.messages.getMessageById(env.userId);
        expect(JSON.parse(owner!.attachmentsJson!)[0].description).toBe("Fresh description");
      });
    });
  }

  for (const stream of [false, true]) {
    test(`fallback stream=${stream}: executor-produced descriptions persist`, async () => {
      await withEnv({ fallback: true, descriptions: [{ attachmentId: "history_attachment", description: "Fresh description" }] }, async (env) => {
        await invoke(stream ? "continue-stream" : "continue", env);
        expect(JSON.parse((await env.stores.messages.getMessageById(env.userId))!.attachmentsJson!)[0].description).toBe("Fresh description");
      });
    });
    for (const media of ["raw-image", "raw-voice"] as const) {
      test(`regenerate stream=${stream}: ${media} keeps send's typed error`, async () => {
        await withEnv({ media, model: "text-model" }, async (env) => {
          await expect(invoke(stream ? "regenerate-stream" : "regenerate", env)).rejects.toBeInstanceOf(media === "raw-image" ? VisionNotSupportedError : VoiceTranscribeUnavailableError);
        });
      });
    }
  }
});
