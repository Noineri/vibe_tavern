import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStoreContainer, type Message } from "@vibe-tavern/db";
import { brandId, EventBus, type Attachment, type ChatId } from "@vibe-tavern/domain";
import * as pipeline from "@vibe-tavern/prompt-pipeline";
import { assembleCoauthorPrompt } from "../src/domain/chat/coauthor-prompt.js";
import type { ChatModeAssembleInput } from "../src/domain/chat/chat-mode-strategy.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { historyAttachmentDescriptions } from "../src/domain/chat/live-chat-media.js";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { prepareSdkMessages, toSdkMessages } from "../src/infrastructure/ai/provider-executor-utils.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";

// T1: real assembly, bundled prompts and compaction; a deterministic tokenizer
// at its external boundary, restored between tests and after the file. Fresh
// template-compatible stores supply complete typed rows, without disk fixtures.
let counter: ReturnType<typeof spyOn> | undefined;
function restore() { counter?.mockRestore(); counter = undefined; }
beforeEach(() => { restore(); counter = spyOn(pipeline, "estimateTokens").mockImplementation((text: string) => text.length); });
afterEach(restore);
afterAll(restore);

async function fixture() {
  const stores = await createStoreContainer(":memory:");
  const character = await stores.characters.create({ name: "Attachment probe", description: "A test card", firstMessage: "Hello" });
  const chat = await stores.chats.createChat({ characterId: character.id, title: "Probe", mode: "coauthor", promptPresetId: null });
  const messages: Message[] = [];
  const input: ChatModeAssembleInput = {
    chatId: brandId<ChatId>(chat.id), model: "test-model",
    // Unused by the Co-Author strategy: only RP delegates to this service.
    promptService: null as unknown as ChatModeAssembleInput["promptService"],
    loaders: {
      getChat: async () => chat, getCharacter: async () => character, getMessages: async () => messages,
      getProfileMdText: async () => "---\nname: Attachment probe\n---\n# PERSONALITY\nA test card.\n",
      getCoauthorContextItems: async () => [], getCoauthorBoundResources: async () => ({ lorebooks: [], scripts: [] }),
      getChatSummaries: async () => [], getCoauthorUserModules: async () => [], getSkillCatalog: async () => [],
    },
  };
  async function row(role: "user" | "assistant" | "tool", content: string, extra: Partial<Message> = {}) {
    const message = await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role, authorType: role === "user" ? "user" : "ai", content });
    messages.push({ ...message, ...extra });
    return messages[messages.length - 1]!;
  }
  return { input, row, messages };
}

const image: Attachment = { id: "image", assetId: "asset-image", type: "image", name: "scene.png", mimeType: "image/png", sizeBytes: 4, description: "A red tower" };
const file: Attachment = { id: "file", assetId: "asset-file", type: "file", name: "notes.md", mimeType: "text/markdown", sizeBytes: 100, tokenCount: 1200 };
function payload(result: Awaited<ReturnType<typeof assembleCoauthorPrompt>>) {
  return (result.prompt.finalPayload as { messages: Array<{ role: string; content: unknown; attachments?: Attachment[]; messageId?: string }> }).messages;
}
function historyCount(result: Awaited<ReturnType<typeof assembleCoauthorPrompt>>) {
  return result.prompt.layers.find((layer) => layer.id === "chat_history")!.tokenCount!;
}

describe("Co-Author attachments (CA-3a)", () => {
  test("no-attachment characterization pins system, history, finalPayload and token accounting", async () => {
    const h = await fixture();
    await h.row("user", "Rewrite the card");
    await h.row("assistant", "I will revise it", { toolCalls: [{ id: "call_1", name: "read_skill_file", args: { path: "writing/SKILL.md" } }] });
    await h.row("tool", "Skill content", { toolCallId: "call_1" });
    const { prompt, promptTraceDraft } = await assembleCoauthorPrompt(h.input);
    // Captured on 2026-10-23 before CA-3a production changes, at 58f72de59.
    expect(createHash("sha256").update(JSON.stringify({ payload: prompt.finalPayload, accounting: prompt.tokenAccounting, layers: prompt.layers.map(({ id, tokenCount }) => ({ id, tokenCount })) })).digest("hex")).toBe("2a9052b6a2226e81f53e6a739caaced87cea4de3f56d5df93a57d8588b7caaf6");
    expect(promptTraceDraft.finalPayload).toEqual(prompt.finalPayload);
    expect(prompt.tokenAccounting.recentHistory).toBe(3);
  });

  test("user and assistant rows share the RP attachment projection; tool rows stay untouched", async () => {
    const h = await fixture();
    const user = await h.row("user", "Look", { attachmentsJson: JSON.stringify([image, file, { ...file, id: "excluded", includeInPrompt: false }]) });
    const assistant = await h.row("assistant", "Reference", { attachmentsJson: JSON.stringify([image]) });
    await h.row("tool", "Result", { attachmentsJson: JSON.stringify([file]), toolCallId: "call" });
    const result = await assembleCoauthorPrompt(h.input);
    expect(payload(result)[1]).toEqual({ role: "user", content: "Look", attachments: [image, file], messageId: user.id });
    expect(payload(result)[2]).toEqual({ role: "assistant", content: "Reference", attachments: [image], messageId: assistant.id });
    expect(payload(result)[3]).not.toHaveProperty("attachments");
    expect(payload(result)[3]).not.toHaveProperty("messageId");
  });

  test("all-excluded attachments omit both fields and keep the text-only accounting", async () => {
    const h = await fixture();
    const row = await h.row("user", "Look");
    const plain = await assembleCoauthorPrompt(h.input);
    row.attachmentsJson = JSON.stringify([{ ...file, includeInPrompt: false }]);
    const excluded = await assembleCoauthorPrompt(h.input);
    expect(excluded.prompt).toEqual(plain.prompt);
  });

  test("history and total add the full file count, then prefer the summary count", async () => {
    const h = await fixture();
    const row = await h.row("user", "Look");
    const plain = await assembleCoauthorPrompt(h.input);
    row.attachmentsJson = JSON.stringify([file, image]);
    const full = await assembleCoauthorPrompt(h.input);
    expect(historyCount(full)).toBe(historyCount(plain) + 1200);
    expect(full.prompt.tokenAccounting.total).toBe(plain.prompt.tokenAccounting.total + 1200);
    row.attachmentsJson = JSON.stringify([{ ...file, description: "Summary", summaryTokenCount: 20 }]);
    const summarized = await assembleCoauthorPrompt(h.input);
    expect(historyCount(summarized)).toBe(historyCount(plain) + 20);
    row.attachmentsJson = JSON.stringify([{ ...file, description: "Legacy summary" }]);
    expect(historyCount(await assembleCoauthorPrompt(h.input))).toBe(historyCount(plain) + "Legacy summary".length);
  });

  test("a recent large file pushes older history out under the same small budget", async () => {
    const h = await fixture();
    await h.row("user", "Old user");
    await h.row("assistant", "Old assistant");
    const recent = await h.row("user", "New user");
    await h.row("assistant", "New assistant");
    const plain = await assembleCoauthorPrompt(h.input);
    const contextBudget = plain.prompt.tokenAccounting.total + 100;
    expect(payload(await assembleCoauthorPrompt({ ...h.input, contextBudget }))).toHaveLength(5);
    recent.attachmentsJson = JSON.stringify([{ ...file, tokenCount: 100 }]);
    const full = await assembleCoauthorPrompt(h.input);
    const compacted = await assembleCoauthorPrompt({ ...h.input, contextBudget: contextBudget - 10 });
    expect(payload(compacted).length).toBeLessThan(payload(full).length);
    expect(payload(compacted).at(-2)?.attachments).toEqual([{ ...file, tokenCount: 100 }]);
    expect(compacted.promptTraceDraft.compactionSummary).toBeDefined();
  });

  for (const stream of [false, true]) {
    for (const vision of [false, true]) {
      test(`real Co-Author send stream=${stream} vision=${vision}: history reaches the gate with assets and description ownership`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vt-coauthor-media-"));
        const stores = await createStoreContainer(":memory:", root);
        await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
        const profiles = createProviderProfileService(stores.providers, stores.proxies);
        const profile = await stores.providers.create({ name: "Co-Author media", providerPreset: "multiai", endpoint: "https://provider.invalid/v1", defaultModel: "media-model" });
        await stores.coauthorSettings.upsert(profile.id, { modelName: "media-model", settings: { maxTokens: 128 } });
        await stores.uiSettings.update({ coauthorProviderId: profile.id });
        await stores.providers.saveCachedModels(profile.id, [{ modelSlug: "media-model", modelName: "Media", contextLength: null, capabilities: { vision } }]);
        const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
        const created = await runtime.character.createFromScratch({ name: "Media", description: "Probe", firstMessage: "Hello" });
        const coauthor = await runtime.chatLifecycle.createChatForCharacter(created.snapshot.character!.id, "coauthor");
        const chatId = coauthor.activeChat.id;
        const assets = new AssetService(join(root, "assets"));
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const uploaded = await assets.upload(new File([bytes], image.name, { type: image.mimeType }));
        const text = "Whole file\n  Last line\n";
        const textAsset = await assets.upload(new File([text], file.name, { type: file.mimeType }));
        const historyImage = { ...image, assetId: uploaded.assetId };
        const historyFile = { ...file, assetId: textAsset.assetId };
        const user = await stores.messages.addMessage({ chatId, branchId: coauthor.activeChat.activeBranchId, role: "user", authorType: "user", content: "Look", attachmentsJson: JSON.stringify([historyImage, historyFile]) });
        const calls: ProviderExecutionInput[] = [];
        const execute = async (input: ProviderExecutionInput) => {
          calls.push(input);
          expect(input.assetLoader).toBeFunction();
          expect(input.tools).toHaveProperty("write_profile");
          expect(toSdkMessages(input.prompt).find((message) => message.role === "user")?.attachments).toEqual([historyImage, historyFile]);
          const prepared = await prepareSdkMessages(toSdkMessages(input.prompt), {
            providerType: "openai_compat", assetLoader: input.assetLoader,
            visionGate: { hasVision: input.cachedModels?.[0]?.capabilities?.vision ?? false, visionModel: input.visionModel ?? null },
          });
          const parts = prepared.conversationMessages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
          expect(parts.some((part) => part.type === "image")).toBe(vision);
          if (vision) expect(parts.find((part) => part.type === "image")).toMatchObject({ image: bytes });
          else expect(JSON.stringify(prepared.conversationMessages)).toContain("A red tower");
          expect(parts.some((part) => part.type === "text" && part.text.includes(text))).toBe(true);
          return { text: "Reply", providerResponse: { mode: "nonstream" as const, steps: [] } };
        };
        const orchestrator = new LiveChatOrchestrator(runtime.chatRuntime, runtime.chatApp, new ProviderOrchestrator(profiles), new EventBus(), (id) => runtime.resolveChatModeStrategy(id), undefined, undefined, {
          nonstreaming: execute,
          stream: async (input) => {
            await execute(input);
            return { stream: (async function* () { yield { type: "text-delta" as const, delta: "Reply" }; })(), text: Promise.resolve("Reply"), reasoning: Promise.resolve(undefined), finished: Promise.resolve({ finishReason: "stop" }), providerResponse: { mode: "stream", steps: [] } };
          },
        });
        const adapter = new ChatAdapter(stores, runtime, orchestrator, new ChatSummaryService(stores, runtime, profiles), profiles, assets, async () => null);
        if (stream) {
          const events = [];
          for await (const event of adapter.sendMessageStream(chatId, { content: "Next" })) events.push(event.event);
          expect(events).toContain("finish");
          expect(events).not.toContain("error");
        } else await adapter.sendMessage(chatId, { content: "Next" });
        expect(calls).toHaveLength(1);
        // Send describes its current uploads before assembly. Later reply paths
        // use this shared CA-1b2 writer over the assembled history instead.
        const write = historyAttachmentDescriptions(calls[0]!.prompt, runtime.chatApp);
        expect(write).toBeFunction();
        await write?.([{ attachmentId: image.id, description: "Fresh description" }]);
        expect(JSON.parse((await stores.messages.getMessageById(user.id))!.attachmentsJson!)[0].description).toBe("Fresh description");
      });
    }
  }
});
