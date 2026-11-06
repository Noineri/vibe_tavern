import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createAiAssistantDeps } from "../src/domain/ai-assistant/ai-assistant-deps.js";
import { countAiAssistantTokens, streamAiAssistant, type StreamDeps } from "../src/domain/ai-assistant/ai-assistant-stream.js";
import { runDirectorMessageEditorDelegate, type DirectorMessageEditorDelegateDeps } from "../src/domain/director/director-message-editor-delegate.js";
import { createOllamaModel } from "../src/domain/providers/ollama-adapter.js";

const ORDINARY_INSTRUCTION = "ordinary user instruction: fix the pose";
const DIRECTOR_INSTRUCTION = "director instruction: fix the pose";

/** Same runtime fixture shape as ai-assistant-stream.test.ts's message-editor
 *  fixture (inline per-file factory — real stores over the DB template, the
 *  provider mocked only at the adapter/fetch seam). */
async function createDelegateRuntime() {
  const tempDir = resolve(tmpdir(), `vt-director-editor-delegate-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(resolve(tempDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tempDir, "data"));
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({ name: "Delegate Probe", description: "test character", firstMessage: "greeting-marker" });
  const chatPreset = await stores.presets.create({ name: "Chat assistant prompts", aiAssistantPrompts: JSON.stringify({ message_edit: "<chat-message-editor-policy/>" }) });
  await stores.chats.setPromptPreset(created.activeChatId, chatPreset.id);
  const { ServicePromptProfileStore, UiSettingsStore } = await import("@vibe-tavern/db");
  const spStore = new ServicePromptProfileStore(stores.db);
  const uiStore = new UiSettingsStore(stores.db);
  await spStore.ensureDefaultServicePromptProfile();
  const svcProfile = await spStore.createServicePromptProfile({ name: "Editor Service", overrides: { message_edit: "<chat-message-editor-policy/>" } });
  await uiStore.update({ activeServicePromptProfileId: svcProfile.id });
  const profile = await stores.providers.create({ name: "Message editor profile", providerPreset: "ollama", endpoint: "http://ai-assistant.test", defaultModel: "base-model", contextBudget: 9000, maxTokens: 1000, bindPerModel: true });
  await stores.providers.upsertModelSettings(profile.id, "editor-model", { contextBudget: 600, maxTokens: 17 });
  const chat = await stores.chats.getById(created.activeChatId);
  if (!chat) throw new Error("Test chat was not created.");
  const setEditorPair = async (modelName: string) => {
    await stores.uiSettings.update({ messageEditorProviderId: profile.id, messageEditorModelName: modelName });
  };
  const cleanup = async () => {
    // Windows briefly holds the SQLite WAL handles after the runtime drops
    // them; a locked-dir error here must not fail assertions that already ran.
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!(typeof code === "string" && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(code))) throw err;
    }
  };
  return { runtime, stores, chat, profile, chatPreset, setEditorPair, cleanup };
}

function delegateDeps(fixture: Awaited<ReturnType<typeof createDelegateRuntime>>, overrides: Partial<DirectorMessageEditorDelegateDeps> = {}): DirectorMessageEditorDelegateDeps {
  return {
    ...createAiAssistantDeps(fixture.stores, fixture.runtime),
    getUiSettings: () => fixture.stores.uiSettings.get(),
    ...overrides,
  };
}

/** Snapshot the persisted message/variant/trace identities — the no-write pin. */
async function persistedState(fixture: Awaited<ReturnType<typeof createDelegateRuntime>>) {
  const branchId = fixture.chat.activeBranchId;
  return {
    messages: (await fixture.stores.messages.getMessages(branchId)).map((message) => message.id),
    variants: [...(await fixture.stores.messages.getVariantsByBranch(branchId)).values()].flat().map((variant) => variant.id),
    traces: (await fixture.stores.traces.getTracesByChat(fixture.chat.id)).map((trace) => trace.id),
  };
}

function expectNoWrites(fixture: Awaited<ReturnType<typeof createDelegateRuntime>>, before: Awaited<ReturnType<typeof persistedState>>) {
  return async () => {
    expect(await persistedState(fixture)).toEqual(before);
  };
}

describe("director message editor delegate", () => {
  beforeEach(() => setTokenCountFn((text) => text.length));
  afterEach(() => setTokenCountFn(() => 0));

  it("delegates through the SAME preparation as the ordinary editor: same model, same prompt, only the instruction author differs", async () => {
    const fixture = await createDelegateRuntime();
    try {
      await fixture.setEditorPair("editor-model");
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "swipe-marker", variants: ["canonical-source-marker"], selectedVariantIndex: 0 });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");
      await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "user", authorType: "user", content: "pre-target-marker" });

      const baseDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      const runtimeDeps: StreamDeps = {
        ...baseDeps,
        resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
      };
      const ordinaryRequest = {
        mode: "message_edit" as const, instruction: ORDINARY_INSTRUCTION, providerProfileId: fixture.profile.id, model: "editor-model",
        enabledLayers: [], chatId: fixture.chat.id, targetMessageId: target.id, sourceVariantIds: [source.id],
      };

      const before = await persistedState(fixture);
      const bodies: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        bodies.push(await new Request(input, init).text());
        return new Response(`${JSON.stringify({ message: { role: "assistant", content: "candidate-only" }, done: false })}\n${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
      };
      let delegateResult: Awaited<ReturnType<typeof runDirectorMessageEditorDelegate>>;
      try {
        for await (const chunk of streamAiAssistant(ordinaryRequest, runtimeDeps)) void chunk;
        delegateResult = await runDirectorMessageEditorDelegate({
          chatId: fixture.chat.id,
          branchId: fixture.chat.activeBranchId,
          targetMessageId: target.id,
          sourceVariantId: source.id,
          instruction: DIRECTOR_INSTRUCTION,
        }, delegateDeps(fixture, { resolveModel: runtimeDeps.resolveModel }));
      } finally {
        globalThis.fetch = originalFetch;
      }

      // Same candidate, provenance from the actual editor generation.
      expect(delegateResult.status).toBe("completed");
      if (delegateResult.status !== "completed") throw new Error("Delegate did not complete.");
      expect(delegateResult.candidate).toBe("candidate-only");
      expect(delegateResult.editor).toEqual({ modelId: "editor-model", presetName: fixture.chatPreset.name, finishReason: "stop" });

      // One provider call per path; the delegated payload is the ordinary
      // editor's payload with ONLY the instruction slot replaced.
      expect(bodies.length).toBe(2);
      const ordinaryBody = JSON.parse(bodies[0].replace(ORDINARY_INSTRUCTION, "INSTRUCTION-SLOT"));
      const delegatedBody = JSON.parse(bodies[1].replace(DIRECTOR_INSTRUCTION, "INSTRUCTION-SLOT"));
      expect(delegatedBody).toEqual(ordinaryBody);
      expect(delegatedBody.model).toBe("editor-model");
      expect(bodies[0]).toContain(ORDINARY_INSTRUCTION);
      expect(bodies[1]).toContain(DIRECTOR_INSTRUCTION);
      // The configured service-prompt override reaches both paths (same prompt source).
      expect(bodies[1]).toContain("<chat-message-editor-policy/>");

      // NO WRITE: the delegate returns a candidate; nothing persists.
      await expectNoWrites(fixture, before)();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the ordinary downstream model resolution when the saved editor model is blank", async () => {
    const fixture = await createDelegateRuntime();
    try {
      await fixture.setEditorPair(""); // selected provider, blank model — the provider's default resolves downstream
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "swipe-marker", variants: ["canonical-source-marker"], selectedVariantIndex: 0 });
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
      let delegateResult: Awaited<ReturnType<typeof runDirectorMessageEditorDelegate>>;
      let ordinaryResult: Awaited<ReturnType<typeof countAiAssistantTokens>>;
      try {
        delegateResult = await runDirectorMessageEditorDelegate({
          chatId: fixture.chat.id,
          branchId: fixture.chat.activeBranchId,
          targetMessageId: target.id,
          sourceVariantId: source.id,
          instruction: DIRECTOR_INSTRUCTION,
        }, delegateDeps(fixture, { resolveModel: runtimeDeps.resolveModel }));
        ordinaryResult = await countAiAssistantTokens({
          mode: "message_edit", instruction: ORDINARY_INSTRUCTION, providerProfileId: fixture.profile.id,
          enabledLayers: [], chatId: fixture.chat.id, targetMessageId: target.id, sourceVariantIds: [source.id],
          // no model — the ordinary editor's blank-model request
        }, runtimeDeps);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(bodies.length).toBe(1);
      const delegatedBody = JSON.parse(bodies[0].replace(DIRECTOR_INSTRUCTION, "INSTRUCTION-SLOT"));
      // The profile's saved default model — never a Director-model fallback.
      expect(delegatedBody.model).toBe("base-model");
      expect(delegateResult.status).toBe("completed");
      if (delegateResult.status !== "completed") throw new Error("Delegate did not complete.");
      expect(delegateResult.editor.modelId).toBe("base-model");
      // Same model the ordinary editor's blank-model request resolves to.
      expect(ordinaryResult.model).toBe("base-model");
    } finally {
      await fixture.cleanup();
    }
  });

  it("resolves the same per-model effective profile as the ordinary editor", async () => {
    const fixture = await createDelegateRuntime();
    try {
      await fixture.setEditorPair("editor-model");
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "swipe-marker", variants: ["canonical-source-marker"], selectedVariantIndex: 0 });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");

      const baseDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      const pipelineInputs: Array<{ contextBudget: number | null; responseReserve: number; branchId: string }> = [];
      const deps = delegateDeps(fixture, {
        resolveModel: () => new MockLanguageModelV4({
          doStream: {
            stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "ok" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
              },
            ] }),
          },
        }),
        buildMessageEditorPipelineContext: async (input) => {
          pipelineInputs.push({ contextBudget: input.contextBudget, responseReserve: input.responseReserve, branchId: input.branchId });
          return baseDeps.buildMessageEditorPipelineContext(input);
        },
      });
      await runDirectorMessageEditorDelegate({
        chatId: fixture.chat.id,
        branchId: fixture.chat.activeBranchId,
        targetMessageId: target.id,
        sourceVariantId: source.id,
        instruction: DIRECTOR_INSTRUCTION,
      }, deps);

      // The bound per-model settings (contextBudget 600 / maxTokens 17), not
      // the profile defaults (9000 / 1000) — the ordinary editor's effective profile.
      expect(pipelineInputs).toEqual([{ contextBudget: 600, responseReserve: 17, branchId: fixture.chat.activeBranchId }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps source-ownership and branch-scope checks, writing nothing on refusal", async () => {
    const fixture = await createDelegateRuntime();
    try {
      await fixture.setEditorPair("editor-model");
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "target-source-marker", variants: ["target-source-marker"], selectedVariantIndex: 0 });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");
      const other = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "other-source-marker", variants: ["other-source-marker"] });
      const otherSource = (await fixture.stores.messages.getVariants(other.id))[0];
      if (!otherSource) throw new Error("Other source variant was not created.");
      const forkBranch = await fixture.stores.chats.forkBranch(fixture.chat.id, target.id, "delegate fork");
      const forkTarget = (await fixture.stores.messages.getMessages(forkBranch.id)).find((message) => message.content === "target-source-marker");
      if (!forkTarget) throw new Error("Forked target was not created.");

      const before = await persistedState(fixture);
      // Refusals happen during preparation — generation (and model resolution)
      // must never start; a throwing resolver fails the test loudly if it does.
      const deps = delegateDeps(fixture, { resolveModel: () => { throw new Error("generation must not start for a refused delegate"); } });

      // A source owned by another message on the scoped branch is refused.
      await expect(runDirectorMessageEditorDelegate({
        chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, targetMessageId: target.id,
        sourceVariantId: otherSource.id, instruction: DIRECTOR_INSTRUCTION,
      }, deps)).rejects.toThrow("does not belong to target message");

      // A target outside the delegate's branch scope is refused (the scope is
      // the caller-provided thread branch, not the browser's active chat).
      await expect(runDirectorMessageEditorDelegate({
        chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, targetMessageId: forkTarget.id,
        sourceVariantId: source.id, instruction: DIRECTOR_INSTRUCTION,
      }, deps)).rejects.toThrow("active branch");

      await expectNoWrites(fixture, before)();
    } finally {
      await fixture.cleanup();
    }
  });

  it("accepts an explicit non-active branch scope the ordinary editor cannot reach", async () => {
    const fixture = await createDelegateRuntime();
    try {
      await fixture.setEditorPair("editor-model");
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "target-source-marker", variants: ["target-source-marker"], selectedVariantIndex: 0 });
      const forkBranch = await fixture.stores.chats.forkBranch(fixture.chat.id, target.id, "delegate fork");
      const forkTarget = (await fixture.stores.messages.getMessages(forkBranch.id)).find((message) => message.content === "target-source-marker");
      if (!forkTarget) throw new Error("Forked target was not created.");
      const forkSource = (await fixture.stores.messages.getVariants(forkTarget.id))[0];
      if (!forkSource) throw new Error("Forked source variant was not created.");

      // The ordinary editor is pinned to the chat's ACTIVE branch: the forked
      // target is unreachable for it...
      const baseDeps = createAiAssistantDeps(fixture.stores, fixture.runtime);
      await expect(countAiAssistantTokens({
        mode: "message_edit", instruction: ORDINARY_INSTRUCTION, providerProfileId: fixture.profile.id, model: "editor-model",
        enabledLayers: [], chatId: fixture.chat.id, targetMessageId: forkTarget.id, sourceVariantIds: [forkSource.id],
      }, baseDeps)).rejects.toThrow("active branch");

      // ...while the delegate's internal branch scope is a parameter: the
      // thread's own (non-active) branch works.
      const bodies: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        bodies.push(await new Request(input, init).text());
        return new Response(`${JSON.stringify({ message: { role: "assistant", content: "fork-candidate" }, done: false })}\n${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
      };
      let delegateResult: Awaited<ReturnType<typeof runDirectorMessageEditorDelegate>>;
      try {
        delegateResult = await runDirectorMessageEditorDelegate({
          chatId: fixture.chat.id, branchId: forkBranch.id, targetMessageId: forkTarget.id,
          sourceVariantId: forkSource.id, instruction: DIRECTOR_INSTRUCTION,
        }, delegateDeps(fixture, { resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }) }));
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(delegateResult.status).toBe("completed");
      if (delegateResult.status !== "completed") throw new Error("Delegate did not complete.");
      expect(delegateResult.candidate).toBe("fork-candidate");
      expect(bodies[0]).toContain("<message-editor-instruction>");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports editor_not_configured and makes no provider call when no editor pair is saved", async () => {
    const fixture = await createDelegateRuntime();
    try {
      // No messageEditor pair and no legacy pair (ui settings defaults).
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "swipe-marker", variants: ["canonical-source-marker"], selectedVariantIndex: 0 });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");

      let providerCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        providerCalled = true;
        throw new Error("no provider call may happen without a configured editor");
      };
      try {
        const result = await runDirectorMessageEditorDelegate({
          chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, targetMessageId: target.id,
          sourceVariantId: source.id, instruction: DIRECTOR_INSTRUCTION,
        }, delegateDeps(fixture, {
          // Not-configured must short-circuit BEFORE any model resolution.
          resolveModel: () => { throw new Error("no model may be resolved without a configured editor"); },
        }));
        expect(result).toEqual({ status: "editor_not_configured" });
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(providerCalled).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("pins NO WRITE on cancellation, empty output and provider failure", async () => {
    const fixture = await createDelegateRuntime();
    try {
      await fixture.setEditorPair("editor-model");
      const target = await fixture.stores.messages.addMessage({ chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, role: "assistant", authorType: "assistant", content: "swipe-marker", variants: ["canonical-source-marker"], selectedVariantIndex: 0 });
      const [source] = await fixture.stores.messages.getVariants(target.id);
      if (!source) throw new Error("Source variant was not created.");

      const finishPart: LanguageModelV4StreamPart = {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      };

      const run = (overrides: Partial<DirectorMessageEditorDelegateDeps>, signal?: AbortSignal) => {
        const before = persistedState(fixture);
        const result = runDirectorMessageEditorDelegate({
          chatId: fixture.chat.id, branchId: fixture.chat.activeBranchId, targetMessageId: target.id,
          sourceVariantId: source.id, instruction: DIRECTOR_INSTRUCTION, ...(signal ? { signal } : {}),
        }, delegateDeps(fixture, overrides));
        return { before, result };
      };

      // Cancellation: an already-aborted caller signal — quiet cancelled outcome.
      const controller = new AbortController();
      controller.abort();
      const cancelled = await run({
        resolveModel: () => new MockLanguageModelV4({
          doStream: {
            stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "never-observed" },
              { type: "text-end", id: "text-1" },
              finishPart,
            ] }),
          },
        }),
      }, controller.signal);
      expect(await cancelled.result).toEqual({ status: "cancelled" });
      await expectNoWrites(fixture, await cancelled.before)();

      // Empty output: whitespace-only text is a failure, never a proposal.
      const empty = await run({
        resolveModel: () => new MockLanguageModelV4({
          doStream: {
            stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "   \n" },
              { type: "text-end", id: "text-1" },
              finishPart,
            ] }),
          },
        }),
      });
      expect(await empty.result).toEqual({ status: "failed", reason: "The message editor returned no candidate text." });
      await expectNoWrites(fixture, await empty.before)();

      // Provider failure: the error surfaces as the failed outcome.
      const failed = await run({
        resolveModel: () => new MockLanguageModelV4({
          doStream: {
            stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "error", error: new Error("provider failure") },
            ] }),
          },
        }),
      });
      expect(await failed.result).toEqual({ status: "failed", reason: "provider failure" });
      await expectNoWrites(fixture, await failed.before)();
    } finally {
      await fixture.cleanup();
    }
  });
});
