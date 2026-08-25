import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createAiAssistantDeps } from "../src/domain/ai-assistant/ai-assistant-deps.js";
import { countAiAssistantTokens, streamAiAssistant, type StreamDeps } from "../src/domain/ai-assistant/ai-assistant-stream.js";
import { createOllamaModel } from "../src/domain/providers/ollama-adapter.js";

async function deps(overrides: Partial<StreamDeps> = {}): Promise<StreamDeps> {
  const base: Omit<StreamDeps, "db"> = {
    getCharacterById: async () => null,
    getPersonaById: async () => null,
    getLoreEntryById: async () => null,
    resolveModel: () => ({}) as never,
    getProviderProfile: async () => ({ id: "profile_1", providerPreset: "openai", endpoint: "", apiKey: "key", defaultModel: "model_1", contextBudget: null, maxTokens: 2000 }),
    getEffectiveProviderProfile: async () => ({ id: "profile_1", providerPreset: "openai", endpoint: "", apiKey: "key", defaultModel: "model_1", contextBudget: null, maxTokens: 2000 }),
    getPresetPromptData: async () => ({ aiAssistantPrompts: { chat_impersonate: "Impersonate the character.", md_import: "Import this markdown." }, scriptAiSystemPrompt: null }),
    getChatMessages: async () => [],
    getMessageEditorChat: async () => null,
    getMessageEditorMessages: async () => [],
    getMessageEditorVariantsByBranch: async () => new Map(),
    buildMessageEditorPipelineContext: async () => { throw new Error("message editor context is not configured"); },
  };
  // SP-4: prompt resolution now uses service-prompt profiles (db). Seed an
  // in-memory db with the same short prompts the old preset mock provided so
  // token-count expectations stay stable.
  let db: import("@vibe-tavern/db").AppDb;
  if ((overrides as { db?: import("@vibe-tavern/db").AppDb }).db) {
    db = (overrides as { db: import("@vibe-tavern/db").AppDb }).db;
  } else {
    const { createDb } = await import("@vibe-tavern/db");
    const { ServicePromptProfileStore, UiSettingsStore } = await import("@vibe-tavern/db");
    db = await createDb(":memory:");
    const ps = new ServicePromptProfileStore(db);
    const ui = new UiSettingsStore(db);
    await ps.ensureDefaultServicePromptProfile();
    const p = await ps.createServicePromptProfile({
      name: "TestAssistant",
      overrides: { chat_impersonate: "Impersonate the character.", md_import: "Import this markdown." },
    });
    await ui.update({ activeServicePromptProfileId: p.id });
  }
  return { db, ...base, ...overrides, db } as StreamDeps;
}

async function createMessageEditorRuntime() {
  const tempDir = resolve(tmpdir(), `vt-message-editor-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(resolve(tempDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tempDir, "data"));
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({ name: "Editor Probe", description: "test character", firstMessage: "greeting-marker" });
  const globalPreset = await stores.presets.create({ name: "Global assistant prompts", aiAssistantPrompts: JSON.stringify({ message_edit: "<global-message-editor-policy/>" }) });
  const chatPreset = await stores.presets.create({ name: "Chat assistant prompts", aiAssistantPrompts: JSON.stringify({ message_edit: "<chat-message-editor-policy/>" }) });
  await stores.uiSettings.update({ activePromptPresetId: globalPreset.id });
  await stores.chats.setPromptPreset(created.activeChatId, chatPreset.id);
  // SP-4: assistant prompts now come from service-prompt profiles, not preset JSON.
  // Seed a service profile so the message-editor prompt is deterministic for the trace test.
  const { ServicePromptProfileStore, UiSettingsStore } = await import("@vibe-tavern/db");
  const spStore = new ServicePromptProfileStore(stores.db);
  const uiStore2 = new UiSettingsStore(stores.db);
  await spStore.ensureDefaultServicePromptProfile();
  const svcProfile = await spStore.createServicePromptProfile({ name: "Editor Service", overrides: { message_edit: "<chat-message-editor-policy/>" } });
  await uiStore2.update({ activeServicePromptProfileId: svcProfile.id });
  const profile = await stores.providers.create({ name: "Message editor profile", providerPreset: "ollama", endpoint: "http://ai-assistant.test", defaultModel: "base-model", contextBudget: 9000, maxTokens: 1000, bindPerModel: true });
  await stores.providers.upsertModelSettings(profile.id, "editor-model", { contextBudget: 600, maxTokens: 17 });
  const chat = await stores.chats.getById(created.activeChatId);
  if (!chat) throw new Error("Test chat was not created.");
  const cleanup = async () => {
    // Windows briefly holds the SQLite WAL handles after the runtime drops
    // them, so `rm` can race with EBUSY/EPERM. The temp dir is disposable (the
    // OS reaps it); a locked-dir error here must not fail the assertions that
    // already ran in the test body above.
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!(typeof code === "string" && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(code))) throw err;
    }
  };
  return { runtime, stores, chat, profile, chatPreset, cleanup };
}

describe("AI assistant stream prompt preparation", () => {
  beforeEach(() => setTokenCountFn((text) => text.length));
  afterEach(() => setTokenCountFn(() => 0));

  it("loads history only for chat_impersonate and includes it in the traced assembly", async () => {
    const calls: Array<[string, number]> = [];
    const result = await countAiAssistantTokens({
      mode: "chat_impersonate", instruction: "Continue.", providerProfileId: "profile_1", enabledLayers: [], chatId: "chat_1", recentMessageCount: 7,
    }, await deps({ getChatMessages: async (chatId, count) => {
      calls.push([chatId, count]);
      return [{ id: "msg_1", role: "user", content: "Hello" }, { id: "msg_2", role: "assistant", content: "Hi" }];
    } }));
    expect(calls).toEqual([["chat_1", 7]]);
    expect(result).toEqual({ tokens: 65, model: "model_1", layerCount: 3, messageCount: 3, activatedLoreCount: 0 });
  });

  it("keeps md_import as a direct two-message path with no resolved context", async () => {
    let resolvedContext = false;
    const result = await countAiAssistantTokens({
      mode: "md_import", instruction: "Ignored when content exists.", existingContent: "# Imported card", providerProfileId: "profile_1", enabledLayers: ["character_base", "lore"],
    }, await deps({ getCharacterById: async () => { resolvedContext = true; return null; } }));
    expect(resolvedContext).toBeFalse();
    expect(result).toEqual({ tokens: 36, model: "model_1", layerCount: 2, messageCount: 2, activatedLoreCount: 0 });
  });

  it("builds canonical pre-target editor candidates without persistence", async () => {
    const fixture = await createMessageEditorRuntime();
    try {
      const before = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "user", authorType: "user", content: "pre-target-marker" });
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "selected-swipe-marker", variants: ["canonical-source-marker", "selected-swipe-marker"], selectedVariantIndex: 1 });
      await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "user", authorType: "user", content: "future-marker" });
      const targetVariants = await fixture.stores.messages.getVariants(target.id);
      const source = targetVariants.find((variant) => variant.content === "canonical-source-marker");
      const selectedSource = targetVariants.find((variant) => variant.content === "selected-swipe-marker");
      if (!source || !selectedSource) throw new Error("Canonical source variants were not created.");

      const baseDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      const pipelineInputs: Array<{ throughMessageId: string; excludeMessageIds: string[]; contextBudget: number | null; responseReserve: number }> = [];
      const streamedTokenEstimates: number[] = [];
      const runtimeDeps: StreamDeps = {
        ...baseDeps,
        resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
        buildMessageEditorPipelineContext: async (input) => {
          pipelineInputs.push({ throughMessageId: input.throughMessageId, excludeMessageIds: input.excludeMessageIds, contextBudget: input.contextBudget, responseReserve: input.responseReserve });
          return baseDeps.buildMessageEditorPipelineContext(input);
        },
        logDebug: (event, data) => {
          if (event === "api.ai-assistant.assembly-complete" && typeof data.totalTokenEstimate === "number") streamedTokenEstimates.push(data.totalTokenEstimate);
        },
      };
      const request = {
        mode: "message_edit" as const, instruction: "revise the selected source", existingContent: "untrusted-client-source-marker", providerProfileId: fixture.profile.id, model: "editor-model", enabledLayers: [], chatId: fixture.chat.id, targetMessageId: target.id, sourceVariantIds: [source.id],
      };
      const messageIdsBefore = (await fixture.stores.messages.getMessages(fixture.chat.activeBranchId)).map((message) => message.id);
      const variantIdsBefore = [...(await fixture.stores.messages.getVariantsByBranch(fixture.chat.activeBranchId)).values()].flat().map((variant) => variant.id);
      const traceIdsBefore = (await fixture.stores.traces.getTracesByChat(fixture.chat.id)).map((trace) => trace.id);
      const preview = await countAiAssistantTokens(request, runtimeDeps);
      const mergeRequest = { ...request, mode: "message_merge" as const, sourceVariantIds: [source.id, selectedSource.id] };
      const mergePreview = await countAiAssistantTokens(mergeRequest, runtimeDeps);
      const expectedPipelineInput = { throughMessageId: target.id, excludeMessageIds: [target.id], contextBudget: 600, responseReserve: 17 };
      expect(pipelineInputs).toEqual([expectedPipelineInput, expectedPipelineInput]);

      const originalFetch = globalThis.fetch;
      const serializedModelRequests: string[] = [];
      globalThis.fetch = async (input, init) => {
        serializedModelRequests.push(await new Request(input, init).text());
        return new Response(`${JSON.stringify({ message: { role: "assistant", content: "candidate-only" }, done: false })}\n${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
      };
      try {
        const editChunks = [];
        for await (const chunk of streamAiAssistant(request, runtimeDeps)) editChunks.push(chunk);
        const mergeChunks = [];
        for await (const chunk of streamAiAssistant(mergeRequest, runtimeDeps)) mergeChunks.push(chunk);
        for (const chunks of [editChunks, mergeChunks]) {
          expect(chunks).toContainEqual({ type: "text", text: "candidate-only" });
          expect(chunks).toContainEqual({ type: "done", modelId: "editor-model", promptPresetId: fixture.chatPreset.id, finishReason: "stop" });
        }
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(streamedTokenEstimates).toEqual([preview.tokens, mergePreview.tokens, preview.tokens, mergePreview.tokens]);
      const [editPayload, mergePayload] = serializedModelRequests;
      if (!editPayload || !mergePayload) throw new Error("Message editor streams did not reach the provider.");
      expect(editPayload).toContain("<chat-message-editor-policy/>");
      expect(editPayload).not.toContain("<global-message-editor-policy/>");
      expect(editPayload).toContain("canonical-source-marker");
      expect(editPayload).not.toContain("untrusted-client-source-marker");
      expect(editPayload).toContain("pre-target-marker");
      expect(editPayload).not.toContain("selected-swipe-marker");
      expect(editPayload).not.toContain("future-marker");
      expect(editPayload.indexOf("pre-target-marker")).toBeLessThan(editPayload.indexOf("<message-editor-instruction>"));
      expect(mergePayload).toContain("canonical-source-marker");
      expect(mergePayload).toContain("selected-swipe-marker");
      expect((await fixture.stores.messages.getMessages(fixture.chat.activeBranchId)).map((message) => message.id)).toEqual(messageIdsBefore);
      expect([...(await fixture.stores.messages.getVariantsByBranch(fixture.chat.activeBranchId)).values()].flat().map((variant) => variant.id)).toEqual(variantIdsBefore);
      expect((await fixture.stores.traces.getTracesByChat(fixture.chat.id)).map((trace) => trace.id)).toEqual(traceIdsBefore);
      expect(before.id).toBeTruthy();
    } finally {
      await fixture.cleanup();
    }
  });

  it("threads recentMessageCount into the message-editor pipeline context as recentMessageLimit", async () => {
    const fixture = await createMessageEditorRuntime();
    try {
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "swipe-marker", variants: ["source-marker"], selectedVariantIndex: 0 });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");

      const baseDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      const pipelineInputs: Array<{ recentMessageLimit?: number }> = [];
      const runtimeDeps: StreamDeps = {
        ...baseDeps,
        resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
        buildMessageEditorPipelineContext: async (input) => {
          pipelineInputs.push({ recentMessageLimit: input.recentMessageLimit });
          return baseDeps.buildMessageEditorPipelineContext(input);
        },
      };
      const request = {
        mode: "message_edit" as const, instruction: "revise the selected source", providerProfileId: fixture.profile.id, model: "editor-model",
        enabledLayers: [], chatId: fixture.chat.id, targetMessageId: target.id, sourceVariantIds: [source.id],
        recentMessageCount: 5,
      };
      await countAiAssistantTokens(request, runtimeDeps);
      expect(pipelineInputs).toEqual([{ recentMessageLimit: 5 }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("honors maxOutputTokens for message-editor streams (surfaced as num_predict in the provider body)", async () => {
    const fixture = await createMessageEditorRuntime();
    try {
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "swipe-marker", variants: ["source-marker"], selectedVariantIndex: 0 });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");

      const baseDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      const runtimeDeps: StreamDeps = {
        ...baseDeps,
        resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
      };
      const bodies: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        bodies.push(await new Request(input, init).text());
        return new Response(`${JSON.stringify({ message: { role: "assistant", content: "candidate-only" }, done: false })}\n${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
      };
      try {
        const baseRequest = {
          mode: "message_edit" as const, instruction: "revise the selected source", providerProfileId: fixture.profile.id, model: "editor-model",
          enabledLayers: [], chatId: fixture.chat.id, targetMessageId: target.id, sourceVariantIds: [source.id],
        };
        const withCap: typeof baseRequest & { maxOutputTokens: number } = { ...baseRequest, maxOutputTokens: 500 };
        for await (const chunk of streamAiAssistant(withCap, runtimeDeps)) void chunk;
        for await (const chunk of streamAiAssistant(baseRequest, runtimeDeps)) void chunk;
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(bodies.length).toBe(2);
      expect(bodies[0]).toContain("num_predict");   // maxOutputTokens honored when sent
      expect(bodies[1]).not.toContain("num_predict"); // omitted (undefined) when not sent
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects noncanonical message editor targets and sources", async () => {
    const fixture = await createMessageEditorRuntime();
    try {
      const userTarget = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "user", authorType: "user", content: "user-target-marker" });
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "assistant-target-marker", variants: ["assistant-target-marker", "deleted-source-marker", "valid-source-marker"] });
      const other = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "wrong-message-marker" });
      const variants = await fixture.stores.messages.getVariants(target.id);
      const deletedSource = variants.find((variant) => variant.content === "deleted-source-marker");
      const validSource = variants.find((variant) => variant.content === "valid-source-marker");
      const wrongSource = (await fixture.stores.messages.getVariants(other.id))[0];
      const userSource = (await fixture.stores.messages.getVariants(userTarget.id))[0];
      if (!deletedSource || !validSource || !wrongSource || !userSource) throw new Error("Invalid-source test variants were not created.");
      await fixture.stores.messages.deleteVariant(target.id, deletedSource.variantIndex);
      const inactiveBranch = await fixture.stores.chats.forkBranch(fixture.chat.id, target.id, "inactive editor branch");
      const inactiveTarget = (await fixture.stores.messages.getMessages(inactiveBranch.id)).find((message) => message.content === "assistant-target-marker");
      if (!inactiveTarget) throw new Error("Inactive-branch target was not created.");

      const cases = [
        { targetMessageId: target.id, sourceVariantIds: ["mvar_missing"], error: "Message editor source variant" },
        { targetMessageId: target.id, sourceVariantIds: [deletedSource.id], error: "Message editor source variant" },
        { targetMessageId: target.id, sourceVariantIds: [wrongSource.id], error: "Message editor source variant" },
        { targetMessageId: userTarget.id, sourceVariantIds: [userSource.id], error: "assistant" },
        { targetMessageId: inactiveTarget.id, sourceVariantIds: [validSource.id], error: "active branch" },
      ];
      const runtimeDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      for (const testCase of cases) {
        await expect(countAiAssistantTokens({
          mode: "message_edit", instruction: "validate canonical source", providerProfileId: fixture.profile.id, model: "editor-model", enabledLayers: [], chatId: fixture.chat.id, targetMessageId: testCase.targetMessageId, sourceVariantIds: testCase.sourceVariantIds,
        }, runtimeDeps)).rejects.toThrow(testCase.error);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps an edited message editable: editMessage does not flip state, so the editor reopens (regression: editor unusable after first Apply)", async () => {
    // Regression: MessageStore.editMessage used to flip `state` to 'edited',
    // and the editor target check rejected anything but 'complete' — so the
    // editor could only ever run once per message. The store no longer writes
    // 'edited' (a content edit leaves the committed state untouched), so a
    // second invocation must succeed.
    const fixture = await createMessageEditorRuntime();
    try {
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "pre-edit-marker", variants: ["pre-edit-marker"] });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");
      // Simulate a prior Apply / manual edit.
      await fixture.stores.messages.editMessage(target.id, "post-edit-marker", source.id);
      const refreshed = await fixture.stores.messages.getMessages(fixture.chat.activeBranchId);
      expect(refreshed.find((message) => message.id === target.id)?.state).toBe("complete");

      const runtimeDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      // A second editor invocation on the same message must NOT throw
      // "committed assistant messages".
      await expect(countAiAssistantTokens({
        mode: "message_edit", instruction: "revise again", providerProfileId: fixture.profile.id, model: "editor-model", enabledLayers: [], chatId: fixture.chat.id, targetMessageId: target.id, sourceVariantIds: [source.id],
      }, runtimeDeps)).resolves.toEqual(expect.any(Object));
    } finally {
      await fixture.cleanup();
    }
  });
});
