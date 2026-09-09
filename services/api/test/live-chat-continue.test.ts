/**
 * LS-4a — Continue generation at the orchestrator boundary, plus the LS-4
 * prefill capability gate.
 *
 * WHAT THIS PROVES
 *   1. `continueMessage` (and its stream twin) end the continuation prompt
 *      with the target assistant variant's text as the PREFILL — the executor
 *      receives the variant text as `input.prefill` (which `prepareSdkMessages`
 *      pushes as the trailing assistant message — the LS-2/LS-3 continuation
 *      seam), the prompt is assembled with `excludeMessageId` so the variant
 *      text is not in the history twice, and the reply (echo asymmetry handled
 *      by ensurePrefillInResponse) APPENDS as a NEW variant of the target
 *      message — the same fork regenerate uses.
 *   2. The pending prompt trace records the ACTUAL continuation text as its
 *      `prefill` (trace honesty — not the preset value).
 *   3. Providers WITHOUT the prefill capability (anthropic/google/koboldcpp,
 *      per the protocol registry) cannot continue — the orchestrator refuses
 *      instead of silently generating a fresh reply masquerading as a
 *      continuation variant.
 *   4. The LS-4 capability gate ALSO applies to prefill on the send path: a
 *      prefill from a capability-less provider is dropped entirely (never
 *      pushed, never prepended by ensurePrefillInResponse — the pre-existing
 *      corruption wart), while a capable provider keeps the preset cascade.
 *
 * HOW: the orchestrator's own DI seams — executor injection (the
 * `executors` constructor seam) + a stub chatRuntime/strategy — no
 * mock.module (tier policy), no network.
 */
import { describe, expect, it } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, MessageId } from "@vibe-tavern/domain";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { GenerationResult } from "../src/infrastructure/ai/provider-execution-types.js";
import type { ProviderExecutionInput, ProviderStreamResult } from "../src/infrastructure/ai/provider-execution-types.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";

const CHAT = "chat_1";
const MESSAGE = "msg_1";

function makeProfile(providerPreset: string): StoredProviderProfileRecord {
  return {
    id: "profile_1",
    name: "profile",
    providerPreset,
    coauthorTransport: "chatCompletions",
    generationMode: "chat",
    endpoint: "http://localhost:8080",
    apiKey: null,
    defaultModel: "model-1",
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
}

interface RuntimeCalls {
  assembleExcludeMessageId: MessageId | undefined;
  appendedVariants: Array<{ messageId: string; content: string }>;
  appendedReplies: string[];
  patchedTracePrefills: Array<string | undefined>;
}

function makeRuntime(calls: RuntimeCalls, assembledPrefill: string | null = null) {
  const assembled = { prefill: assembledPrefill, finalPayload: {} } as AssemblePromptResponse & { tools?: undefined; maxSteps?: undefined; coauthorModuleId?: undefined; coauthorSkillId?: undefined };
  return {
    // sendMessage path.
    async prepareLiveTurn() {
      return { snapshot: { messages: [] }, prompt: assembled, userMessage: undefined };
    },
    // continue/regenerate path.
    async assemblePromptPreview(_chatId: string, options: { excludeMessageId?: MessageId }) {
      calls.assembleExcludeMessageId = options.excludeMessageId;
      return assembled;
    },
    async appendMessageVariant(_chatId: string, messageId: MessageId, input: { content: string }) {
      calls.appendedVariants.push({ messageId, content: input.content });
      return { messages: [] } as never;
    },
    async appendAssistantReply(_chatId: string, content: string) {
      calls.appendedReplies.push(content);
      return { response: { messages: [] }, branchId: "branch_1", messageId: "new_1" } as never;
    },
    patchPendingTrace(_chatId: string, patch: { prefill?: string }) {
      calls.patchedTracePrefills.push(patch.prefill);
    },
    discardPendingPromptTrace() {},
  } as never;
}

function makeOrchestrator(calls: RuntimeCalls, profile: StoredProviderProfileRecord, executors: {
  nonstreaming: (input: ProviderExecutionInput) => Promise<GenerationResult>;
  stream: (input: ProviderExecutionInput) => Promise<ProviderStreamResult>;
}, assembledPrefill: string | null = null) {
  const strategy = {
    resolveProvider: async () => ({ profile, model: "model-1" }),
    onMessageAppended: () => {},
  };
  return new LiveChatOrchestrator(
    makeRuntime(calls, assembledPrefill),
    null as never,
    null as never,
    new EventBus(),
    async () => strategy as never,
    undefined,
    undefined,
    executors as never,
  );
}

describe("LiveChatOrchestrator — continue generation (LS-4a)", () => {
  it("continues from the variant text: prefill rides to the executor, prompt excludes the target, result appends as a variant", async () => {
    const calls: RuntimeCalls = {
      assembleExcludeMessageId: undefined,
      appendedVariants: [],
      appendedReplies: [],
      patchedTracePrefills: [],
    };
    const executorInputs: ProviderExecutionInput[] = [];
    const orchestrator = makeOrchestrator(calls, makeProfile("llamacpp"), {
      nonstreaming: async (input) => {
        executorInputs.push(input);
        // LM Studio-style: continuation only, prefill NOT echoed.
        return { text: " and the story went on.", providerResponse: {} } as GenerationResult;
      },
      stream: null as never,
    });

    const result = await orchestrator.continueMessage({
      chatId: CHAT,
      messageId: MESSAGE,
      continuationText: "Once upon a time",
      profile: makeProfile("llamacpp"),
      model: "model-1",
    });

    expect(executorInputs).toHaveLength(1);
    expect(executorInputs[0]!.prefill).toBe("Once upon a time");
    expect(calls.assembleExcludeMessageId).toBe(MESSAGE);
    // Echo asymmetry: continuation only → the stored variant is prefill + reply.
    expect(calls.appendedVariants).toHaveLength(1);
    expect(calls.appendedVariants[0]!.messageId).toBe(MESSAGE);
    expect(calls.appendedVariants[0]!.content).toBe("Once upon a time and the story went on.");
    // Trace honesty: the pending draft's prefill records the continuation.
    expect(calls.patchedTracePrefills).toContain("Once upon a time");
    expect(result.reply).toBe("Once upon a time and the story went on.");
  });

  it("echoing providers (llama-server) do not double the continuation text", async () => {
    const calls: RuntimeCalls = {
      assembleExcludeMessageId: undefined,
      appendedVariants: [],
      appendedReplies: [],
      patchedTracePrefills: [],
    };
    const orchestrator = makeOrchestrator(calls, makeProfile("llamacpp"), {
      nonstreaming: async () => ({ text: "Once upon a time and the story went on.", providerResponse: {} }) as GenerationResult,
      stream: null as never,
    });

    await orchestrator.continueMessage({
      chatId: CHAT,
      messageId: MESSAGE,
      continuationText: "Once upon a time",
      profile: makeProfile("llamacpp"),
      model: "model-1",
    });

    expect(calls.appendedVariants[0]!.content).toBe("Once upon a time and the story went on.");
  });

  it("streams the continuation and appends the settled variant (stream path)", async () => {
    const calls: RuntimeCalls = {
      assembleExcludeMessageId: undefined,
      appendedVariants: [],
      appendedReplies: [],
      patchedTracePrefills: [],
    };
    const executorInputs: ProviderExecutionInput[] = [];
    const orchestrator = makeOrchestrator(calls, makeProfile("llamacpp"), {
      nonstreaming: null as never,
      stream: async (input) => {
        executorInputs.push(input);
        return {
          stream: (async function* () {
            yield { type: "text-delta", delta: " and more." };
          })(),
          finished: Promise.resolve({ finishReason: "stop" }),
          text: Promise.resolve(" and more."),
          reasoning: Promise.resolve(undefined),
          hasRedactedReasoning: false,
          providerResponse: {},
        } as ProviderStreamResult;
      },
    });

    const events: Array<{ event: string }> = [];
    for await (const event of orchestrator.continueMessageStream({
      chatId: CHAT,
      messageId: MESSAGE,
      continuationText: "Once upon a time",
      profile: makeProfile("llamacpp"),
      model: "model-1",
    })) {
      events.push(event);
    }

    expect(executorInputs[0]!.prefill).toBe("Once upon a time");
    expect(calls.appendedVariants[0]!.content).toBe("Once upon a time and more.");
    expect(events.some((e) => e.event === "text-delta")).toBe(true);
    expect(events.some((e) => e.event === "finish")).toBe(true);
  });

  it("refuses to continue on a provider without the prefill capability", async () => {
    const calls: RuntimeCalls = {
      assembleExcludeMessageId: undefined,
      appendedVariants: [],
      appendedReplies: [],
      patchedTracePrefills: [],
    };
    let executorRan = false;
    const orchestrator = makeOrchestrator(calls, makeProfile("anthropic"), {
      nonstreaming: async () => {
        executorRan = true;
        return { text: "nope", providerResponse: {} } as GenerationResult;
      },
      stream: null as never,
    });

    await expect(orchestrator.continueMessage({
      chatId: CHAT,
      messageId: MESSAGE,
      continuationText: "Once upon a time",
      profile: makeProfile("anthropic"),
      model: "model-1",
    })).rejects.toMatchObject({ kind: "Validation" });
    expect(executorRan).toBe(false);
    expect(calls.appendedVariants).toHaveLength(0);
  });
});

describe("LiveChatOrchestrator — send-path prefill capability gate (LS-4)", () => {
  it("drops the prefill entirely on a capability-less provider (never pushed, never prepended)", async () => {
    const calls: RuntimeCalls = {
      assembleExcludeMessageId: undefined,
      appendedVariants: [],
      appendedReplies: [],
      patchedTracePrefills: [],
    };
    const executorInputs: ProviderExecutionInput[] = [];
    const orchestrator = makeOrchestrator(calls, makeProfile("anthropic"), {
      nonstreaming: async (input) => {
        executorInputs.push(input);
        return { text: "Fresh reply.", providerResponse: {} } as GenerationResult;
      },
      stream: null as never,
    });

    await orchestrator.sendMessage({
      chatId: CHAT,
      content: "hello",
      profile: makeProfile("anthropic"),
      model: "model-1",
      prefill: "One-shot override",
    });

    expect(executorInputs[0]!.prefill).toBeUndefined();
    // The reply is stored WITHOUT the override prepended.
    expect(calls.appendedReplies[0]).toBe("Fresh reply.");
  });

  it("keeps the preset prefill cascade on a capable provider", async () => {
    const calls: RuntimeCalls = {
      assembleExcludeMessageId: undefined,
      appendedVariants: [],
      appendedReplies: [],
      patchedTracePrefills: [],
    };
    const executorInputs: ProviderExecutionInput[] = [];
    const orchestrator = makeOrchestrator(calls, makeProfile("llamacpp"), {
      nonstreaming: async (input) => {
        executorInputs.push(input);
        // Provider does NOT echo the prefill.
        return { text: "the actual reply", providerResponse: {} } as GenerationResult;
      },
      stream: null as never,
    }, "Preset prefill.");

    await orchestrator.sendMessage({
      chatId: CHAT,
      content: "hello",
      profile: makeProfile("llamacpp"),
      model: "model-1",
    });

    expect(executorInputs[0]!.prefill).toBe("Preset prefill.");
    expect(calls.appendedReplies[0]).toBe("Preset prefill.the actual reply");
  });
});
