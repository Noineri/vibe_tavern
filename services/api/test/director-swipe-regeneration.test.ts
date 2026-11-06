import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventBus, type ChatId, type MessageId, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";

// ════════════════════════════════════════════════════════════════════════════
// DMT-13 (director message tools) — the one-shot request instruction rides
// through BOTH ordinary regeneration paths (streaming + non-streaming) into
// the REAL assembly boundary (assemblePromptPreview → assembleSessionPrompt →
// PromptAssemblyService → pure assemblePrompt).
//
// Pinned here:
//  - trace/payload identity: the directed regeneration's linked prompt trace
//    and the executor-captured provider payload BOTH carry the DMT-12
//    request_instruction layer (user role, depth 1), exactly once;
//  - target exclusion: the regenerated target message stays out of the
//    history exactly as in ordinary regeneration;
//  - request-local lifetime: after success, provider failure or user Stop,
//    the NEXT ordinary generation contains no trace of the instruction.
//
// Ordinary regeneration without the option is characterized in the same file:
// no request_instruction layer, no instruction text anywhere.
//
// Harness forked from message-preset-meta.test.ts (real SessionRuntime over
// createRuntimeStore; provider executors through the orchestrator's
// `executors` constructor seam — no `mock.module`, AGENTS.md tier policy).
// ════════════════════════════════════════════════════════════════════════════

const INSTRUCTION = "Keep the reply under three sentences and mention the brass key.";
const GREETING = "Hello there!";
const USER_TURN = "What is behind the door?";
const TARGET_REPLY = "The door creaks open, revealing a dusty study.";
const DIRECTED_REPLY = "Directed variant reply.";
const ORDINARY_REPLY = "Ordinary variant reply.";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function payloadJson(prompt: AssemblePromptResponse): string {
  return JSON.stringify(prompt.finalPayload);
}

interface CapturingExecutors {
  nonstreaming: typeof nonstreamingProviderExecute;
  stream: typeof streamProviderExecutor;
  prompts: AssemblePromptResponse[];
}

function capturingNonstreaming(text: string): CapturingExecutors["nonstreaming"] {
  return async (input) => {
    capturedPrompts.push(input.prompt);
    return { text, providerResponse: {} };
  };
}

function capturingStream(text: string): CapturingExecutors["stream"] {
  return async (input) => {
    capturedPrompts.push(input.prompt);
    return {
      stream: (async function* () {
        yield { type: "text-delta" as const, delta: text };
      })(),
      finished: Promise.resolve({ finishReason: "stop" }),
      text: Promise.resolve(text),
      reasoning: Promise.resolve(undefined),
      providerResponse: { mode: "stream" as const, steps: [] },
    };
  };
}

/** Shared capture sink — reset per test via `capturedPrompts.length = 0`. */
const capturedPrompts: AssemblePromptResponse[] = [];

function makeExecutors(nonstreamingText: string, streamText: string): CapturingExecutors {
  capturedPrompts.length = 0;
  return {
    nonstreaming: capturingNonstreaming(nonstreamingText),
    stream: capturingStream(streamText),
    prompts: capturedPrompts,
  };
}

async function createTestRuntime() {
  const tmpDir = resolve(tmpdir(), "vt-dmt13-" + crypto.randomUUID().slice(0, 8));
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({
    name: "TestBot",
    description: "a probe character",
    firstMessage: GREETING,
  });
  return {
    runtime,
    chatId: created.activeChatId as ChatId,
    stores,
    cleanup: async () => {
      try {
        await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EBUSY") throw error;
      }
    },
  };
}

const regenProfile = {
  id: "dmt13-profile",
  name: "DMT-13 profile",
  providerPreset: "openai",
  coauthorTransport: "chatCompletions",
  generationMode: "chat",
  endpoint: "https://provider.example/v1",
  apiKey: "key",
  defaultModel: "dmt13-model",
  contextBudget: 16000,
  pinContextBudget: false,
  tokenPadding: 0,
  bindPerModel: false,
  modelFreeOnly: false,
  modelGroupByOwner: false,
  maxTokens: 512,
  stopSequences: [],
  bannedStrings: [],
  logitBias: [],
  seed: null,
  showReasoning: false,
  streamResponse: true,
  customSamplers: false,
  proxyMode: "inherit",
  proxyId: null,
} as StoredProviderProfileRecord;

function makeRegenOrchestrator(
  runtime: SessionRuntime,
  executors: { nonstreaming: typeof nonstreamingProviderExecute; stream: typeof streamProviderExecutor },
): LiveChatOrchestrator {
  const strategy: ChatModeStrategy = {
    mode: "rp",
    resolveProvider: async () => ({ profile: regenProfile, model: "dmt13-model" }),
    onMessageAppended: () => {},
    assemble: async () => {
      throw new Error("Regeneration assembles through ChatRuntime deps, not the orchestrator strategy");
    },
  };
  return new LiveChatOrchestrator(
    runtime.chatRuntime,
    runtime.chatApp,
    null!,
    new EventBus(),
    async () => strategy,
    undefined,
    undefined,
    executors,
  );
}

/** Seed greeting (from createFromScratch) + user turn + target assistant reply. */
async function seedConversation(runtime: SessionRuntime, chatId: ChatId): Promise<{ targetMessageId: string; branchId: string }> {
  await runtime.chatRuntime.prepareLiveTurn(chatId, USER_TURN, "dmt13-model");
  const appended = await runtime.chatRuntime.appendAssistantReply(chatId, TARGET_REPLY, 42);
  const chat = (await runtime.chatApp.getChatState(chatId));
  return { targetMessageId: appended.messageId, branchId: chat.branch.id };
}

/** The regenerated target's variant contents, oldest first. */
async function variantContents(stores: Awaited<ReturnType<typeof createRuntimeStore>>, messageId: MessageId): Promise<string[]> {
  return (await stores.messages.getVariants(messageId)).map((variant) => variant.content);
}

describe("DMT-13 directed regeneration — non-streaming path", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => { await Promise.all(cleanups.map((cleanup) => cleanup())); });

  it("carries the instruction in the provider payload exactly once, at depth 1, with the target excluded", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId } = await seedConversation(runtime, chatId);
    const executors = makeExecutors(DIRECTED_REPLY, DIRECTED_REPLY);
    const orch = makeRegenOrchestrator(runtime, executors);

    const result = await orch.regenerateMessage({
      chatId,
      profile: regenProfile,
      model: "dmt13-model",
      messageId: targetMessageId,
      requestInstruction: INSTRUCTION,
    });

    // The executor saw exactly one prompt.
    expect(executors.prompts).toHaveLength(1);
    const prompt = executors.prompts[0]!;
    // Payload identity: the instruction rides exactly once, in the message
    // carrying the request_instruction layer attribution (ordinary simple-mode
    // role merging may absorb the adjacent history message INTO it — DMT-12
    // pins that; the layer id and role are retained).
    expect(countOccurrences(payloadJson(prompt), INSTRUCTION)).toBe(1);
    const messages = (prompt.finalPayload as { messages: Array<{ role: string; content: string; layerId?: string }> }).messages;
    const instructionIndex = messages.findIndex((message) => message.layerId === "request_instruction");
    expect(instructionIndex).toBeGreaterThan(-1);
    expect(messages[instructionIndex]!.role).toBe("user");
    expect(messages[instructionIndex]!.content).toContain(INSTRUCTION);
    // Depth 1 (DMT-12 pins both payload placements): the instruction message
    // occupies the last chat slot, or second-to-last when the trailing user
    // turn survived the role merge as its own message — never deeper.
    expect(instructionIndex).toBeGreaterThanOrEqual(messages.length - 2);
    const afterInstruction = messages[instructionIndex + 1];
    expect(afterInstruction === undefined || (afterInstruction.role === "user" && afterInstruction.layerId === undefined)).toBe(true);
    // Target exclusion: the regenerated reply is NOT in the history twice.
    expect(countOccurrences(payloadJson(prompt), TARGET_REPLY)).toBe(0);
    // The rest of the history is intact.
    expect(payloadJson(prompt)).toContain(GREETING);
    expect(payloadJson(prompt)).toContain(USER_TURN);
    // The assembled LAYER LIST itself declares the depth-1 in_chat layer.
    const layer = prompt.layers.find((candidate) => candidate.id === "request_instruction");
    expect(layer).toBeDefined();
    expect(layer!.injectionDepth).toBe(1);
    expect(layer!.position).toBe("in_chat");
    expect(layer!.text).toBe(INSTRUCTION);
    // The directed variant was appended as a normal swipe.
    const contents = await variantContents(stores, targetMessageId);
    expect(contents).toContain(DIRECTED_REPLY);
    expect(result.snapshot.messages.length).toBeGreaterThan(0);
  });

  it("links an exact prompt trace carrying the same instruction layer to the new variant", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId, branchId } = await seedConversation(runtime, chatId);
    const executors = makeExecutors(DIRECTED_REPLY, DIRECTED_REPLY);
    const orch = makeRegenOrchestrator(runtime, executors);

    await orch.regenerateMessage({
      chatId,
      profile: regenProfile,
      model: "dmt13-model",
      messageId: targetMessageId,
      requestInstruction: INSTRUCTION,
    });

    const contents = await variantContents(stores, targetMessageId);
    const directedVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === DIRECTED_REPLY);
    expect(directedVariant).toBeDefined();

    const trace = await stores.traces.getTraceByVariant(chatId, branchId, directedVariant!.id);
    expect(trace).not.toBeNull();
    expect(trace!.messageId).toBe(targetMessageId);
    expect(trace!.variantId).toBe(directedVariant!.id);
    // The linked trace carries exactly the DMT-12 layer — same text the
    // provider payload rode (trace/payload identity).
    const instructionLayers = trace!.assembledLayers.filter((candidate) => candidate.id === "request_instruction");
    expect(instructionLayers).toHaveLength(1);
    expect(instructionLayers[0]!.sourceType).toBe("request_instruction");
    expect(instructionLayers[0]!.injectionDepth).toBe(1);
    expect(instructionLayers[0]!.position).toBe("in_chat");
    expect(instructionLayers[0]!.text).toBe(INSTRUCTION);
    expect(countOccurrences(JSON.stringify(trace!.finalPayload), INSTRUCTION)).toBe(1);
    expect(countOccurrences(JSON.stringify(trace!.assembledLayers), INSTRUCTION)).toBe(1);
  });

  it("ordinary regeneration without the option is unchanged: no instruction layer, no text anywhere", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId, branchId } = await seedConversation(runtime, chatId);
    const executors = makeExecutors(ORDINARY_REPLY, ORDINARY_REPLY);
    const orch = makeRegenOrchestrator(runtime, executors);

    await orch.regenerateMessage({ chatId, profile: regenProfile, model: "dmt13-model", messageId: targetMessageId });

    expect(executors.prompts).toHaveLength(1);
    const prompt = executors.prompts[0]!;
    expect(prompt.layers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(payloadJson(prompt), INSTRUCTION)).toBe(0);
    const directedVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === ORDINARY_REPLY);
    expect(directedVariant).toBeDefined();
    const trace = await stores.traces.getTraceByVariant(chatId, branchId, directedVariant!.id);
    expect(trace).not.toBeNull();
    expect(trace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(JSON.stringify(trace!.finalPayload), INSTRUCTION)).toBe(0);
  });

  it("after a directed regeneration the NEXT ordinary regeneration is clean (no leakage on success)", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId, branchId } = await seedConversation(runtime, chatId);
    const executors = makeExecutors(DIRECTED_REPLY, ORDINARY_REPLY);
    const orch = makeRegenOrchestrator(runtime, executors);

    // Directed (non-streaming executor), then ordinary (non-streaming executor
    // returns the ordinary text on the second call).
    const directedTexts = [DIRECTED_REPLY, ORDINARY_REPLY];
    let call = 0;
    executors.nonstreaming = async (input) => {
      capturedPrompts.push(input.prompt);
      return { text: directedTexts[Math.min(call++, directedTexts.length - 1)]!, providerResponse: {} };
    };

    await orch.regenerateMessage({
      chatId, profile: regenProfile, model: "dmt13-model", messageId: targetMessageId, requestInstruction: INSTRUCTION,
    });
    await orch.regenerateMessage({ chatId, profile: regenProfile, model: "dmt13-model", messageId: targetMessageId });

    // Second (ordinary) prompt: no instruction anywhere.
    expect(executors.prompts).toHaveLength(2);
    const ordinaryPrompt = executors.prompts[1]!;
    expect(ordinaryPrompt.layers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(payloadJson(ordinaryPrompt), INSTRUCTION)).toBe(0);
    const ordinaryVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === ORDINARY_REPLY);
    expect(ordinaryVariant).toBeDefined();
    const ordinaryTrace = await stores.traces.getTraceByVariant(chatId, branchId, ordinaryVariant!.id);
    expect(ordinaryTrace).not.toBeNull();
    expect(ordinaryTrace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(JSON.stringify(ordinaryTrace!.finalPayload), INSTRUCTION)).toBe(0);
  });

  it("after a FAILED directed regeneration nothing leaks (pending trace discarded, next generation clean)", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId, branchId } = await seedConversation(runtime, chatId);
    const providerFailure = new Error("provider failure");
    const failingNonstreaming: typeof nonstreamingProviderExecute = async () => {
      throw providerFailure;
    };
    const failingOrch = makeRegenOrchestrator(runtime, {
      nonstreaming: failingNonstreaming,
      stream: async () => { throw new Error("Streaming executor is not used by this test"); },
    });

    await expect(failingOrch.regenerateMessage({
      chatId, profile: regenProfile, model: "dmt13-model", messageId: targetMessageId, requestInstruction: INSTRUCTION,
    })).rejects.toBe(providerFailure);

    // No variant was appended by the failed attempt.
    const contents = await variantContents(stores, targetMessageId);
    expect(contents).not.toContain(DIRECTED_REPLY);

    // The next ordinary generation (fresh orchestrator with capturing
    // executors over the SAME runtime) is clean.
    const second = makeExecutors(ORDINARY_REPLY, ORDINARY_REPLY);
    const secondOrch = makeRegenOrchestrator(runtime, second);
    await secondOrch.regenerateMessage({ chatId, profile: regenProfile, model: "dmt13-model", messageId: targetMessageId });
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]!.layers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(payloadJson(second.prompts[0]!), INSTRUCTION)).toBe(0);
    const ordinaryVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === ORDINARY_REPLY);
    expect(ordinaryVariant).toBeDefined();
    const trace = await stores.traces.getTraceByVariant(chatId, branchId, ordinaryVariant!.id);
    expect(trace).not.toBeNull();
    expect(trace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(JSON.stringify(trace!.finalPayload), INSTRUCTION)).toBe(0);
  });
});

describe("DMT-13 directed regeneration — streaming path", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => { await Promise.all(cleanups.map((cleanup) => cleanup())); });

  it("carries the instruction in the provider payload exactly once, appends the variant, links the trace", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId, branchId } = await seedConversation(runtime, chatId);
    const executors = makeExecutors(DIRECTED_REPLY, DIRECTED_REPLY);
    const orch = makeRegenOrchestrator(runtime, executors);

    for await (const _event of orch.regenerateMessageStream({
      chatId,
      profile: regenProfile,
      model: "dmt13-model",
      messageId: targetMessageId,
      requestInstruction: INSTRUCTION,
    })) {
      // Consuming the real SSE generator reaches its append-on-final boundary.
    }

    expect(executors.prompts).toHaveLength(1);
    const prompt = executors.prompts[0]!;
    expect(countOccurrences(payloadJson(prompt), INSTRUCTION)).toBe(1);
    const messages = (prompt.finalPayload as { messages: Array<{ role: string; content: string; layerId?: string }> }).messages;
    const instructionIndex = messages.findIndex((message) => message.layerId === "request_instruction");
    expect(instructionIndex).toBeGreaterThanOrEqual(messages.length - 2);
    expect(messages[instructionIndex]!.role).toBe("user");
    expect(messages[instructionIndex]!.content).toContain(INSTRUCTION);
    expect(countOccurrences(payloadJson(prompt), TARGET_REPLY)).toBe(0);

    const directedVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === DIRECTED_REPLY);
    expect(directedVariant).toBeDefined();
    const trace = await stores.traces.getTraceByVariant(chatId, branchId, directedVariant!.id);
    expect(trace).not.toBeNull();
    expect(trace!.variantId).toBe(directedVariant!.id);
    const instructionLayers = trace!.assembledLayers.filter((candidate) => candidate.id === "request_instruction");
    expect(instructionLayers).toHaveLength(1);
    expect(instructionLayers[0]!.text).toBe(INSTRUCTION);
    expect(countOccurrences(JSON.stringify(trace!.finalPayload), INSTRUCTION)).toBe(1);
  });

  it("after a user Stop mid-directed-regeneration the NEXT ordinary regeneration is clean", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId, branchId } = await seedConversation(runtime, chatId);
    // A REAL mid-stream Stop: the stream yields one delta (consumed, so the
    // partial text exists), THEN the user's Stop aborts the signal — the next
    // drainStream loop pass takes the savePartial + abort path.
    const controller = new AbortController();
    const stopMidStream: typeof streamProviderExecutor = async (input) => {
      capturedPrompts.push(input.prompt);
      return {
        stream: (async function* () {
          yield { type: "text-delta" as const, delta: DIRECTED_REPLY };
          controller.abort();
          yield { type: "text-delta" as const, delta: " discarded tail" };
        })(),
        finished: Promise.resolve({ finishReason: "stop" }),
        text: Promise.resolve(DIRECTED_REPLY),
        reasoning: Promise.resolve(undefined),
        providerResponse: { mode: "stream" as const, steps: [] },
      };
    };
    const ordinaryPromptCapture: AssemblePromptResponse[] = [];
    const ordinaryNonstreaming: typeof nonstreamingProviderExecute = async (input) => {
      ordinaryPromptCapture.push(input.prompt);
      return { text: ORDINARY_REPLY, providerResponse: {} };
    };
    const orch = makeRegenOrchestrator(runtime, { nonstreaming: ordinaryNonstreaming, stream: stopMidStream });

    const events: Array<{ event: string }> = [];
    for await (const event of orch.regenerateMessageStream({
      chatId,
      profile: regenProfile,
      model: "dmt13-model",
      messageId: targetMessageId,
      requestInstruction: INSTRUCTION,
      signal: controller.signal,
    })) {
      events.push({ event: event.event });
    }
    expect(events.some((candidate) => candidate.event === "abort")).toBe(true);
    // Stop keeps the streamed partial as a variant of the target.
    const partialVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === DIRECTED_REPLY);
    expect(partialVariant).toBeDefined();
    // The Stop-recorded trace belongs to THAT directed generation — it links
    // to the partial variant and carries the instruction that rode it.
    const partialTrace = await stores.traces.getTraceByVariant(chatId, branchId, partialVariant!.id);
    expect(partialTrace).not.toBeNull();
    expect(partialTrace!.assembledLayers.some((candidate) => candidate.id === "request_instruction")).toBe(true);

    // The NEXT ordinary generation (fresh orchestrator, same runtime) is clean.
    const secondOrch = makeRegenOrchestrator(runtime, {
      nonstreaming: ordinaryNonstreaming,
      stream: async () => { throw new Error("Streaming executor is not used by this test"); },
    });
    await secondOrch.regenerateMessage({ chatId, profile: regenProfile, model: "dmt13-model", messageId: targetMessageId });
    expect(ordinaryPromptCapture).toHaveLength(1);
    expect(ordinaryPromptCapture[0]!.layers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(payloadJson(ordinaryPromptCapture[0]!), INSTRUCTION)).toBe(0);
    const ordinaryVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === ORDINARY_REPLY);
    expect(ordinaryVariant).toBeDefined();
    const ordinaryTrace = await stores.traces.getTraceByVariant(chatId, branchId, ordinaryVariant!.id);
    expect(ordinaryTrace).not.toBeNull();
    expect(ordinaryTrace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(JSON.stringify(ordinaryTrace!.finalPayload), INSTRUCTION)).toBe(0);
  });

  it("ordinary streaming regeneration without the option is unchanged: no instruction layer, no text anywhere", async () => {
    const ctx = await createTestRuntime();
    cleanups.push(ctx.cleanup);
    const { runtime, chatId, stores } = ctx;
    const { targetMessageId, branchId } = await seedConversation(runtime, chatId);
    const executors = makeExecutors(ORDINARY_REPLY, ORDINARY_REPLY);
    const orch = makeRegenOrchestrator(runtime, executors);

    for await (const _event of orch.regenerateMessageStream({
      chatId, profile: regenProfile, model: "dmt13-model", messageId: targetMessageId,
    })) {
      // Drain to the append-on-final boundary.
    }

    expect(executors.prompts).toHaveLength(1);
    const prompt = executors.prompts[0]!;
    expect(prompt.layers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(payloadJson(prompt), INSTRUCTION)).toBe(0);
    const ordinaryVariant = (await stores.messages.getVariants(targetMessageId))
      .find((variant) => variant.content === ORDINARY_REPLY);
    expect(ordinaryVariant).toBeDefined();
    const trace = await stores.traces.getTraceByVariant(chatId, branchId, ordinaryVariant!.id);
    expect(trace).not.toBeNull();
    expect(trace!.assembledLayers.find((candidate) => candidate.id === "request_instruction")).toBeUndefined();
    expect(countOccurrences(JSON.stringify(trace!.finalPayload), INSTRUCTION)).toBe(0);
  });
});
