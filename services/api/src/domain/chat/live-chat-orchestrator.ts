import { brandId, EventBus } from "@vibe-tavern/domain";
import type { ChatBranchId, ChatId, MessageId, PromptPresetId } from "@vibe-tavern/domain";
import type { ChatRuntime } from "../../runtime/session/session-runtime-chat.js";
import type { SessionSnapshot, MessageResponse } from "../../api/contract/session-types.js";
import type { ProviderOrchestrator } from "../providers/provider-orchestrator.js";
import type { CoauthorTransport, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderExecutionInput, ProviderStreamResult, ExtractedToolCall, ExtractedToolResult, CachedModelEntry } from "../../infrastructure/ai/provider-execution-types.js";
import type { ChatModeStrategy } from "./chat-mode-strategy.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../../infrastructure/ai/stream-provider-executor.js";
import { ProviderExecutionError } from "../../infrastructure/ai/provider-execution-types.js";
import { detectPrefillRejection } from "../../infrastructure/ai/prefill-rejection-detector.js";
import { runContinueFallback, runContinueFallbackStream, drainContinuePrefillWithRetry, appendContinueVariant, stitchContinuationOrPrefill, ContinueFallbackMemory, resolveEffectivePrefill, selectContinueEntry, countPromptMessages } from "./continue-fallback.js";
import type { StreamStartInput, DrainStreamInput, DrainFinalSnapshot, ContinueFallbackAttemptInput, ContinueFallbackReason } from "./continue-fallback.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { extractThinkingTags } from "../../infrastructure/ai/extract-thinking-tags.js";
import { ensurePrefillInResponse } from "../../infrastructure/ai/ensure-prefill-in-response.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";
import { classifyProviderError } from "../../infrastructure/ai/provider-error-classifier.js";
import { markUserMessageSaved } from "./user-message-saved.js";
import { effectiveContextBudget, normalizeProviderType } from "@vibe-tavern/domain";
import { providerTokenContextFromProfile, runWithProviderTokenContext } from "../../infrastructure/ai/token-count-cache.js";
import { resolveProtocol } from "../providers/protocol-registry.js";
import { validation } from "../../shared/errors.js";
import type { LiveChatSendInput } from "./live-chat-send-input.js";
import { assembleReplyPrompt } from "./live-chat-reply-prompt.js";

/** Context passed to every regex-text hook invocation (REGEX_EXTENSION_PLAN, RX-5). */
export interface RegexHookContext {
  chatId: string;
  /** Which hook is firing. */
  hook: "USER_INPUT" | "AI_OUTPUT" | "REASONING";
}

/** Text transformer invoked at one hook point. May be async — the live wiring (RegexHookService) resolves active presets from the DB per fire, so every call site awaits it. */
export type RegexTextHook = (text: string, ctx: RegexHookContext) => string | Promise<string>;

/**
 * Coordinates the prepare → execute → append cycle for all AI generation paths:
 * send, generate (continue), regenerate — each with streaming and non-streaming variants.
 *
 * Delegates prompt assembly to {@link ChatRuntime}, AI execution to the provider layer,
 * and mode-specific behavior to {@link ChatModeStrategy}.
 */
export class LiveChatOrchestrator {
  /** CPF-2b prefill-rejection memory (server-session lifetime, in-memory
   *  only). A hit sends the Continue fallback DIRECTLY — the doomed prefill
   *  attempt is skipped entirely. Populated only by a detector-confirmed
   *  clean rejection; see ContinueFallbackMemory for the keying rule. */
  private readonly continueFallbackMemory = new ContinueFallbackMemory();

  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly chatApp: import("./chat-application-service.js").ChatApplicationService,
    private readonly providers: ProviderOrchestrator,
    private readonly events: EventBus,
    /** Per-chat strategy resolver. The active strategy is derived from
     * `chat.mode` for each turn, not fixed at construction — so adding a mode
     * is a new strategy class + registry entry, never a branch here. */
    private readonly resolveStrategy: (chatId: string) => Promise<ChatModeStrategy>,
    /** Join the preceding forward-state job before any new prompt is built. */
    private readonly waitForForwardState?: (chatId: string, signal?: AbortSignal) => Promise<void>,
    /** RX-5/RX-8/RX-10: regex transformation seam (`RegexHookService.createHooks()`). Absent ⇒ every hook is the identity — byte-for-byte current behavior. Only persist-mode presets transform here; display/prompt-only modes are Wave 3 seams. */
    private readonly regexHooks?: { onUserInput: RegexTextHook; onAiOutput: RegexTextHook; onReasoning: RegexTextHook },
    /** Executor injection seam (mock-free test boundary; `deps.streamTextImpl`
     *  precedent from regex-assist). Absent ⇒ the real infrastructure
     *  executors run — production behavior byte-for-byte. Tests pass stubs of
     *  the executor type here instead of `mock.module()` patching, which is
     *  process-global under bun:test (AGENTS.md tier policy). */
    private readonly executors?: {
      nonstreaming: typeof nonstreamingProviderExecute;
      stream: typeof streamProviderExecutor;
    },
  ) {}

  /** Executor seam accessors: injected stub (tests) or the real module fn. */
  private get executeNonstreaming(): typeof nonstreamingProviderExecute {
    return this.executors?.nonstreaming ?? nonstreamingProviderExecute;
  }

  /** Executor seam accessor — see {@link executors}. */
  private get executeStream(): typeof streamProviderExecutor {
    return this.executors?.stream ?? streamProviderExecutor;
  }

  /** RX-8/RX-10 regex seam: runs `text` through the injected hook (persist-mode presets only), or returns it unchanged when none is present. */
  private async applyRegexLayer(hook: "USER_INPUT" | "AI_OUTPUT" | "REASONING", chatId: string, text: string): Promise<string> {
    if (!this.regexHooks) return text;
    if (hook === "REASONING") {
      return await this.regexHooks.onReasoning(text, { chatId, hook });
    }
    return hook === "USER_INPUT"
      ? await this.regexHooks.onUserInput(text, { chatId, hook })
      : await this.regexHooks.onAiOutput(text, { chatId, hook });
  }

  // ─── Non-streaming methods ────────────────────────────────────────────

  /** Non-streaming send: prepare → execute → append reply → return snapshot. */
  async sendMessage(input: LiveChatSendInput): Promise<{
    preparedMessageCount: number;
    promptMessageCount: number;
    reply: string;
    snapshot: MessageResponse;
  }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.send.prepare.start", { chatId: input.chatId, model: provider.model });
    // RX-8 regex seam: USER_INPUT transform (persist-mode presets only).
    const transformedContent = await this.applyRegexLayer("USER_INPUT", input.chatId, input.content);
    const prepared = await this.withTokenContext(provider, () =>
      this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), transformedContent, provider.model, provider.profile.maxTokens, input.attachments, input.diceCommit, input.experienceCommit, input.coauthorEditorState),
    );
    this.notifyUserMessageCreated(input.chatId, prepared.userMessage);
    logSendDebug("live.send.prepare.done", {
      chatId: input.chatId,
      snapshotMessageCount: prepared.snapshot.messages.length,
      promptMessageCount: countPromptMessages(prepared.prompt),
    });
    const startedAt = Date.now();
    logSendDebug("live.send.provider.start", { chatId: input.chatId, providerId: provider.profile.id, model: provider.model });
    // LS-4: the per-send override (input.prefill) wins over the preset value;
    // both are dropped on protocols without the prefill capability.
    const prefill = resolveEffectivePrefill(provider.profile, input.prefill ?? prepared.prompt.prefill ?? undefined);
    let reply: string;
    let reasoning: string | undefined;
    let toolCalls: ExtractedToolCall[] | undefined;
    let toolResults: ExtractedToolResult[] | undefined;
    try {
      // Non-streaming path: generateText() awaits the full reply, returned as JSON.
      // The streaming equivalent (SSE text/reasoning deltas) lives in sendMessageStream() / startStream().
      const result = await this.executeNonstreaming({
        profile: provider.profile,
        model: provider.model,
        transport: input.transport,
        prompt: prepared.prompt,
        signal: input.signal,
        prefill,
        tools: prepared.tools,
        maxSteps: prepared.maxSteps,
        cachedModels: input.visionAssets?.cachedModels,
        visionModel: input.visionAssets?.visionModel,
        assetLoader: input.visionAssets?.assetLoader,
        visionDescribePrompt: input.visionAssets?.visionDescribePrompt,
        voiceTranscriber: input.voiceTranscriber,
        onAttachmentDescriptions: (prepared.userMessage && input.attachments?.length)
          ? async (descriptions) => {
              await this.chatApp.updateAttachmentDescriptions(prepared.userMessage!.id, input.attachments!, descriptions);
            }
          : undefined,
      });
      reply = ensurePrefillInResponse(result.text, prefill);
      reasoning = result.reasoning;
      toolCalls = result.toolCalls;
      toolResults = result.toolResults;
      this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
        ...(result.sentConfig ? { sentConfig: result.sentConfig } : {}),
        providerResponse: result.providerResponse,
      });
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw prepared.userMessage ? markUserMessageSaved(err) : err; // the client shows it, not restores the draft
    }

    // Extract thinking tags from content (some models embed <thinking> in text)
    const { mainContent: sendText, reasoning: sendReasoning } = extractThinkingTags(reply, reasoning);
    reply = sendText;
    reasoning = sendReasoning;
    // RX-8 regex seam: AI_OUTPUT transform (persist-mode presets, main content only). The variant is created already-transformed — no post-append rewrite, so no variant race by construction.
    reply = await this.applyRegexLayer("AI_OUTPUT", input.chatId, reply);
    // RX-10 regex seam: REASONING transform (persist-mode presets, reasoning only; guarded so undefined/empty never fires the hook).
    if (reasoning) reasoning = await this.applyRegexLayer("REASONING", input.chatId, reasoning);

    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.send.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const appended = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), reply, latencyMs, {
      reasoning,
      toolCalls,
      toolResults,
    });
    const snapshot = appended.response;
    logSendDebug("live.send.append.done", { chatId: input.chatId, messageCount: snapshot.messages.length });
    this.notifyAssistantAppended(input.chatId, appended.branchId, appended.messageId);

    return {
      preparedMessageCount: prepared.snapshot.messages.length,
      promptMessageCount: countPromptMessages(prepared.prompt),
      reply,
      snapshot,
    };
  }

  /** Non-streaming continue: assemble prompt without user message → execute → append reply. */
  async generateReply(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    transport?: CoauthorTransport;
    prefill?: string;
    signal?: AbortSignal;
  }): Promise<{
    promptMessageCount: number;
    reply: string;
    snapshot: MessageResponse;
  }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.generateReply.start", { chatId: input.chatId, model: provider.model });
    const prompt = await assembleReplyPrompt(this.chatRuntime, provider, input.chatId, (fn) => this.withTokenContext(provider, fn));
    const prefill = resolveEffectivePrefill(provider.profile, input.prefill ?? prompt.prefill ?? undefined);
    const startedAt = Date.now();
    let reply: string;
    let reasoning: string | undefined;
    let toolCalls: ExtractedToolCall[] | undefined;
    let toolResults: ExtractedToolResult[] | undefined;
    try {
      const result = await this.executeNonstreaming({
        profile: provider.profile,
        model: provider.model,
        transport: input.transport,
        prompt,
        signal: input.signal,
        prefill,
        tools: prompt.tools,
        maxSteps: prompt.maxSteps,
      });
      reply = ensurePrefillInResponse(result.text, prefill);
      reasoning = result.reasoning;
      toolCalls = result.toolCalls;
      toolResults = result.toolResults;
      this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
        ...(result.sentConfig ? { sentConfig: result.sentConfig } : {}),
        providerResponse: result.providerResponse,
      });
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }

    // Extract thinking tags from content (some models embed <thinking> in text)
    const { mainContent: genText, reasoning: genReasoning } = extractThinkingTags(reply, reasoning);
    reply = genText;
    reasoning = genReasoning;
    // RX-10 regex seam: REASONING transform (persist-mode presets, reasoning only; guarded so undefined/empty never fires the hook).
    if (reasoning) reasoning = await this.applyRegexLayer("REASONING", input.chatId, reasoning);

    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.generateReply.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const appended = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), reply, latencyMs, {
      reasoning,
      toolCalls,
      toolResults,
    });
    const snapshot = appended.response;
    this.notifyAssistantAppended(input.chatId, appended.branchId, appended.messageId);
    return {
      promptMessageCount: countPromptMessages(prompt),
      reply,
      snapshot,
    };
  }

  /** Non-streaming regenerate: exclude target message from prompt → execute → add as variant. */
  async regenerateMessage(input: {
    chatId: string;
    messageId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    transport?: CoauthorTransport;
    /**
     * Optional per-request prompt preset override (Wave Q1b). When set, the
     * assembled prompt uses this preset instead of the chat's `promptPresetId`,
     * WITHOUT mutating the chat row. Undefined → existing cascade (unchanged).
     * Wired into assemblePromptPreview in Q1b; accepted here from Q1a so the
     * adapter can thread it without a second signature change.
     */
    presetId?: PromptPresetId;
    prefill?: string;
    signal?: AbortSignal;
  }): Promise<{
    promptMessageCount: number;
    reply: string;
    snapshot: MessageResponse;
  }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.regenerate.start", { chatId: input.chatId, messageId: input.messageId, model: provider.model });
    const prompt = await this.withTokenContext(provider, () =>
      this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
        excludeMessageId: brandId<MessageId>(input.messageId),
        model: provider.model,
        contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
        responseReserve: provider.profile.maxTokens,
        presetId: input.presetId,
      }),
    );
    logSendDebug("live.regenerate.prompt.ready", {
      chatId: input.chatId,
      messageId: input.messageId,
      promptMessageCount: countPromptMessages(prompt),
    });
    // LS-4 capability gate: drop the preset prefill on non-capable protocols.
    const prefill = resolveEffectivePrefill(provider.profile, prompt.prefill ?? undefined);
    const startedAt = Date.now();
    logSendDebug("live.regenerate.provider.start", { chatId: input.chatId, providerId: provider.profile.id, model: provider.model });
    let reply: string;
    let reasoning: string | undefined;
    let toolCalls: ExtractedToolCall[] | undefined;
    let toolResults: ExtractedToolResult[] | undefined;
    try {
      const result = await this.executeNonstreaming({
        profile: provider.profile,
        model: provider.model,
        transport: input.transport,
        prompt,
        signal: input.signal,
        prefill,
        tools: prompt.tools,
        maxSteps: prompt.maxSteps,
      });
      reply = ensurePrefillInResponse(result.text, prefill);
      reasoning = result.reasoning;
      toolCalls = result.toolCalls;
      toolResults = result.toolResults;
      this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
        ...(result.sentConfig ? { sentConfig: result.sentConfig } : {}),
        providerResponse: result.providerResponse,
      });
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }

    // Extract thinking tags from content (some models embed <thinking> in text)
    const { mainContent: regenText, reasoning: regenReasoning } = extractThinkingTags(reply, reasoning);
    reply = regenText;
    reasoning = regenReasoning;
    // RX-10 regex seam: REASONING transform (persist-mode presets, reasoning only; guarded so undefined/empty never fires the hook).
    if (reasoning) reasoning = await this.applyRegexLayer("REASONING", input.chatId, reasoning);

    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.regenerate.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
      content: reply,
      latencyMs,
      reasoning,
      toolCalls,
      toolResults,
    });
    logSendDebug("live.regenerate.append.done", { chatId: input.chatId, messageId: input.messageId, messageCount: snapshot.messages.length });

    return {
      promptMessageCount: countPromptMessages(prompt),
      reply,
      snapshot,
    };
  }

  // ─── Streaming methods ────────────────────────────────────────────────

  /** Streaming send: prepare → execute stream → yield SSE events → append on finish/abort. */
  async *sendMessageStream(input: LiveChatSendInput): AsyncGenerator<{ event: string; data: string }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.send-stream.prepare.start", { chatId: input.chatId, model: provider.model });
    // RX-8 regex seam: USER_INPUT transform (persist-mode presets only).
    const transformedContent = await this.applyRegexLayer("USER_INPUT", input.chatId, input.content);
    const prepared = await this.withTokenContext(provider, () =>
      this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), transformedContent, provider.model, provider.profile.maxTokens, input.attachments, input.diceCommit, input.experienceCommit, input.coauthorEditorState),
    );
    this.notifyUserMessageCreated(input.chatId, prepared.userMessage);
    // Stored from here on: a later error leaves it in the chat — the client reloads, not restores the draft.
    if (prepared.userMessage) {
      yield { event: "user-message-saved", data: JSON.stringify({ messageId: prepared.userMessage.id }) };
    }
    const prefill = resolveEffectivePrefill(provider.profile, input.prefill ?? prepared.prompt.prefill ?? undefined);
    const onAttachmentDescriptions = (prepared.userMessage && input.attachments?.length)
      ? async (descriptions: Array<{ attachmentId: string; description: string }>) => {
          await this.chatApp.updateAttachmentDescriptions(prepared.userMessage!.id, input.attachments!, descriptions);
        }
      : undefined;
    const { streamResult, startedAt } = await this.startStream({ ...input, ...provider, onAttachmentDescriptions, tools: prepared.tools, maxSteps: prepared.maxSteps }, prepared.prompt);
    this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
      ...(streamResult.sentConfig ? { sentConfig: streamResult.sentConfig } : {}),
      providerResponse: streamResult.providerResponse,
    });

    if (prepared.coauthorModuleId) {
      yield {
        event: "coauthor-module",
        data: JSON.stringify({
          moduleId: prepared.coauthorModuleId,
          skillId: prepared.coauthorSkillId,
        }),
      };
    }

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.send-stream",
      prefill,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          const appended = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
          this.notifyAssistantAppended(input.chatId, appended.branchId, appended.messageId);
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs, toolCalls, toolResults) => {
        const appended = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
          reasoning,
          reasoningDurationMs,
          toolCalls,
          toolResults,
        });
        logSendDebug("live.send-stream.done", { chatId: input.chatId, latencyMs, replyLength: text.length });
        this.notifyAssistantAppended(input.chatId, appended.branchId, appended.messageId);
        return { ...appended.response, lorebookOverflows: appended.overflowAlerts };
      },
    });
  }

  /** Streaming continue: assemble without user message → stream → append. */
  async *generateReplyStream(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    transport?: CoauthorTransport;
    prefill?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.generateReply-stream.start", { chatId: input.chatId, model: provider.model });
    const prompt = await assembleReplyPrompt(this.chatRuntime, provider, input.chatId, (fn) => this.withTokenContext(provider, fn));
    // Resolved again here for drainStream's echo seam; startStream applies the
    // same gate to the executor input (LS-4).
    const prefill = resolveEffectivePrefill(provider.profile, input.prefill ?? prompt.prefill ?? undefined);
    const { streamResult, startedAt } = await this.startStream({ ...input, ...provider, tools: prompt.tools, maxSteps: prompt.maxSteps }, prompt);
    this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
      ...(streamResult.sentConfig ? { sentConfig: streamResult.sentConfig } : {}),
      providerResponse: streamResult.providerResponse,
    });

    if (prompt.coauthorModuleId) {
      yield {
        event: "coauthor-module",
        data: JSON.stringify({
          moduleId: prompt.coauthorModuleId,
          skillId: prompt.coauthorSkillId,
        }),
      };
    }

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.generateReply-stream",
      prefill,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          const appended = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
          this.notifyAssistantAppended(input.chatId, appended.branchId, appended.messageId);
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs, toolCalls, toolResults) => {
        const appended = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
          reasoning,
          reasoningDurationMs,
          toolCalls,
          toolResults,
        });
        logSendDebug("live.generateReply-stream.done", { chatId: input.chatId, latencyMs, replyLength: text.length });
        this.notifyAssistantAppended(input.chatId, appended.branchId, appended.messageId);
        return { ...appended.response, lorebookOverflows: appended.overflowAlerts };
      },
    });
  }

  /** Streaming regenerate: exclude target message → stream → add as variant. */
  async *regenerateMessageStream(input: {
    chatId: string;
    messageId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    transport?: CoauthorTransport;
    /** Optional per-request prompt preset override (Wave Q1b). See regenerateMessage. */
    presetId?: PromptPresetId;
    prefill?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.regenerate-stream.start", { chatId: input.chatId, messageId: input.messageId, model: provider.model });
    const prompt = await this.withTokenContext(provider, () =>
      this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
        excludeMessageId: brandId<MessageId>(input.messageId),
        model: provider.model,
        contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
        responseReserve: provider.profile.maxTokens,
        presetId: input.presetId,
      }),
    );
    // Resolved again here for drainStream's echo seam; startStream applies the
    // same gate to the executor input (LS-4).
    const prefill = resolveEffectivePrefill(provider.profile, input.prefill ?? prompt.prefill ?? undefined);
    const { streamResult, startedAt } = await this.startStream({ ...input, ...provider, tools: prompt.tools, maxSteps: prompt.maxSteps }, prompt);
    this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
      ...(streamResult.sentConfig ? { sentConfig: streamResult.sentConfig } : {}),
      providerResponse: streamResult.providerResponse,
    });

    if (prompt.coauthorModuleId) {
      yield {
        event: "coauthor-module",
        data: JSON.stringify({
          moduleId: prompt.coauthorModuleId,
          skillId: prompt.coauthorSkillId,
        }),
      };
    }

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.regenerate-stream",
      omitMessageCountInFinish: true,
      prefill,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
            content: text,
            latencyMs,
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs, toolCalls, toolResults) => {
        const snapshot = await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
          content: text,
          latencyMs,
          reasoning,
          reasoningDurationMs,
          toolCalls,
          toolResults,
        });
        logSendDebug("live.regenerate-stream.done", { chatId: input.chatId, messageId: input.messageId, latencyMs });
        return { ...snapshot, lorebookOverflows: snapshot.overflowAlerts };
      },
    });
  }

  /** Non-streaming continue (LS-4a): the target assistant variant's text IS
   *  the continuation point. The prompt excludes the target message (so the
   *  variant text is not in the history twice) and the variant text rides as
   *  the executor prefill — `prepareSdkMessages` pushes it as the trailing
   *  assistant message (the LS-2/LS-3 continuation-point seam: the TC
   *  completion renderer treats a trailing assistant as the continuation,
   *  chat-capable providers continue the pushed turn). The reply (echo
   *  asymmetry handled by `ensurePrefillInResponse`) APPENDS as a NEW variant
   *  of the target message — the same fork regenerate uses.
   *
   *  CPF-2b prefill fallback: backends that refuse a last-assistant-turn
   *  request (Gemini via aggregators) reject every prefill attempt. A
   *  detector-confirmed clean rejection retries ONCE as a user-role
   *  continuation ({@link runContinueFallback}) and remembers the pair —
   *  later clicks go straight to the fallback (skip the doomed attempt). */
  async continueMessage(input: {
    chatId: string;
    messageId: string;
    /** The selected variant's text — resolved server-side by the adapter. */
    continuationText: string;
    profile: StoredProviderProfileRecord;
    model: string;
    transport?: CoauthorTransport;
    signal?: AbortSignal;
  }): Promise<{
    promptMessageCount: number;
    reply: string;
    snapshot: MessageResponse;
  }> {
    const provider = await this.resolveProvider(input);
    const memoryKey = ContinueFallbackMemory.key(provider.profile, provider.model);
    const fallbackEntry = selectContinueEntry(provider.profile, this.continueFallbackMemory.has(memoryKey));
    if (fallbackEntry) {
      return await runContinueFallback({
        chatRuntime: this.chatRuntime,
        executeNonstreaming: this.executeNonstreaming,
        applyRegexLayer: (hook, chatId, text) => this.applyRegexLayer(hook, chatId, text),
        withTokenContext: (provider2, fn) => this.withTokenContext(provider2, fn),
      }, input, provider, fallbackEntry);
    }
    logSendDebug("live.continue.start", { chatId: input.chatId, messageId: input.messageId, model: provider.model });
    const prompt = await this.withTokenContext(provider, () =>
      this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
        excludeMessageId: brandId<MessageId>(input.messageId),
        model: provider.model,
        contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
        responseReserve: provider.profile.maxTokens,
      }),
    );
    const prefill = input.continuationText;
    // Trace honesty: the pending draft's `prefill` records what actually rode
    // as the pushed assistant message — the continuation text, not the preset.
    this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { prefill });
    const startedAt = Date.now();
    let reply: string;
    let reasoning: string | undefined;
    try {
      const result = await this.executeNonstreaming({
        profile: provider.profile,
        model: provider.model,
        transport: input.transport,
        prompt,
        signal: input.signal,
        prefill,
        tools: prompt.tools,
        maxSteps: prompt.maxSteps,
      });
      reply = ensurePrefillInResponse(result.text, prefill);
      reasoning = result.reasoning;
      this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
        ...(result.sentConfig ? { sentConfig: result.sentConfig } : {}),
        providerResponse: result.providerResponse,
      });
    } catch (err) {
      // CPF-2b retry-once: a CLEAN prefill rejection (detector match on the
      // executor error) re-issues the request as a user-role continuation.
      // Any other error keeps the existing discard + rethrow unchanged.
      const message = extractProviderErrorMessage(err);
      const cleanRejection = detectPrefillRejection({
        status: err instanceof ProviderExecutionError ? err.statusCode : undefined,
        message,
      });
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      if (!cleanRejection) throw err;
      this.continueFallbackMemory.record(memoryKey);
      logSendDebug("live.continue.rejection-detected", { chatId: input.chatId, messageId: input.messageId, key: memoryKey, message });
      return await runContinueFallback({
        chatRuntime: this.chatRuntime,
        executeNonstreaming: this.executeNonstreaming,
        applyRegexLayer: (hook, chatId, text) => this.applyRegexLayer(hook, chatId, text),
        withTokenContext: (provider2, fn) => this.withTokenContext(provider2, fn),
      }, input, provider, "rejection-retry");
    }

    // Shared continue tail (thinking-tag extraction, regex seams, variant
    // append) — see appendContinueVariant in continue-fallback.ts.
    return await appendContinueVariant({
      chatRuntime: this.chatRuntime,
      applyRegexLayer: (hook, chatId, text) => this.applyRegexLayer(hook, chatId, text),
    }, input, prompt, reply, reasoning, startedAt);
  }

  /** Streaming continue (LS-4a): same seam as {@link continueMessage} — the
   *  variant text rides as the executor prefill; deltas stream the raw
   *  continuation (the same echo asymmetry the preset-prefill send path
   *  shows), and the full text appends as a new variant on finalize.
   *
   *  CPF-2b prefill fallback: a detector-confirmed clean rejection (the
   *  provider 400 rides the LAZY streamText stream — zero deltas reach the
   *  client, which is what makes the retry clean) retries ONCE as a
   *  user-role continuation ({@link runContinueFallbackStream}); the pair is
   *  remembered so later clicks skip the doomed prefill attempt. */
  async *continueMessageStream(input: {
    chatId: string;
    messageId: string;
    continuationText: string;
    profile: StoredProviderProfileRecord;
    model: string;
    transport?: CoauthorTransport;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    const provider = await this.resolveProvider(input);
    const memoryKey = ContinueFallbackMemory.key(provider.profile, provider.model);
    const fallbackEntry = selectContinueEntry(provider.profile, this.continueFallbackMemory.has(memoryKey));
    if (fallbackEntry) {
      yield* this.continueFallbackStream(input, provider, fallbackEntry);
      return;
    }
    logSendDebug("live.continue-stream.start", { chatId: input.chatId, messageId: input.messageId, model: provider.model });
    const prompt = await this.withTokenContext(provider, () =>
      this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
        excludeMessageId: brandId<MessageId>(input.messageId),
        model: provider.model,
        contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
        responseReserve: provider.profile.maxTokens,
      }),
    );
    const prefill = input.continuationText;
    this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { prefill });
    const { streamResult, startedAt } = await this.startStream({ ...input, ...provider, prefill, tools: prompt.tools, maxSteps: prompt.maxSteps }, prompt);
    this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
      ...(streamResult.sentConfig ? { sentConfig: streamResult.sentConfig } : {}),
      providerResponse: streamResult.providerResponse,
    });

    // CPF-2b retry-once: a clean prefill rejection surfaces as drainStream's
    // FIRST `error` event — streamText is lazy, so the 400 rides the stream
    // (zero deltas streamed, which is what makes the retry clean). The drain
    // relay (continue-fallback.ts) swallows that event BEFORE it reaches the
    // client when the detector matches; any other error forwards
    // byte-identical to the pre-fallback behavior.
    let cleanRejection = false;
    yield* drainContinuePrefillWithRetry(
      {
        chatRuntime: this.chatRuntime,
        drainStream: <TFinal extends DrainFinalSnapshot>(drainInput: DrainStreamInput<TFinal>) => this.drainStream(drainInput),
      },
      input,
      startedAt,
      streamResult,
      prefill,
      (message) => {
        cleanRejection = true;
        this.continueFallbackMemory.record(memoryKey);
        logSendDebug("live.continue-stream.rejection-detected", { chatId: input.chatId, messageId: input.messageId, key: memoryKey, message });
      },
    );
    if (cleanRejection) {
      yield* this.continueFallbackStream(input, provider, "rejection-retry");
    }
  }

  /** CPF-2b fallback continue, streaming: delegates to
   *  {@link runContinueFallbackStream} (continue-fallback.ts — extracted per
   *  the file-size ratchet) on this orchestrator's seams. */
  private async *continueFallbackStream(input: ContinueFallbackAttemptInput & { profile: StoredProviderProfileRecord; model: string }, provider: { profile: StoredProviderProfileRecord; model: string }, reason: ContinueFallbackReason): AsyncGenerator<{ event: string; data: string }> {
    yield* runContinueFallbackStream({
      chatRuntime: this.chatRuntime,
      startStream: (startInput, prompt) => this.startStream(startInput, prompt),
      drainStream: <TFinal extends DrainFinalSnapshot>(drainInput: DrainStreamInput<TFinal>) => this.drainStream(drainInput),
      withTokenContext: (scoped, fn) => this.withTokenContext(scoped, fn),
    }, input, provider, reason);
  }

  /**
   * Starts a stream provider execution with error handling.
   * Discards the pending prompt trace on failure.
   */
  private async resolveProvider(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    signal?: AbortSignal;
  }): Promise<{ profile: StoredProviderProfileRecord; model: string }> {
    await this.waitForForwardState?.(input.chatId, input.signal);
    const strategy = await this.resolveStrategy(input.chatId);
    return strategy.resolveProvider(input);
  }

  private notifyUserMessageCreated(chatId: string, message?: { id: MessageId; content: string }): void {
    if (!message) return;
    this.events.emit("message.created", {
      chatId,
      messageId: message.id,
      role: "user",
      content: message.content,
    });
  }

  /**
   * LS-1c: run a prompt-assembly-scoped operation with the send profile's
   * token context in scope (LOCAL_SUPPORT_PLAN). While in scope, every
   * `countTokens` inside reads the provider-exact LRU (`token-count-cache.ts`)
   * and schedules bounded background warm fetches on misses — the assembly
   * itself never awaits a tokenize round-trip. Null context (cloud protocols,
   * unresolved model) → pure local ladder, byte-identical behavior.
   */
  private withTokenContext<T>(
    provider: { profile: StoredProviderProfileRecord; model: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return runWithProviderTokenContext(
      providerTokenContextFromProfile(provider.profile, provider.model),
      fn,
    );
  }

  private notifyAssistantAppended(chatId: string, branchId: ChatBranchId, messageId: MessageId): void {
    this.events.emit("message.appended", { chatId, branchId, messageId, role: "assistant" });
    // Delegate mode-specific post-append work (no-op for RP/coauthor; future
    // hooks for novel/group). Resolved per-chat from `chat.mode`.
    void this.resolveStrategy(chatId).then((s) =>
      s.onMessageAppended({ chatId, messageId, events: this.events }),
    );
  }

  private async startStream(
    input: StreamStartInput,
    prompt: Parameters<typeof streamProviderExecutor>[0]["prompt"],
  ): Promise<{ streamResult: ProviderStreamResult; startedAt: number }> {
    const startedAt = Date.now();
    try {
      const streamResult = await this.executeStream({
        profile: input.profile,
        model: input.model,
        transport: input.transport,
        prompt,
        signal: input.signal,
        // LS-4 capability gate: same rule as the non-stream paths. CPF-2b
        // fallback: no prefill may ride (mutual exclusion is enforced at
        // prepareSdkMessages; suppressing the cascade here keeps it honest).
        prefill: input.continuationFallback
          ? undefined
          : resolveEffectivePrefill(input.profile, input.prefill ?? (prompt as { prefill?: string }).prefill ?? undefined),
        ...(input.continuationFallback ? { continuationFallback: true } : {}),
        tools: input.tools,
        maxSteps: input.maxSteps,
        cachedModels: input.visionAssets?.cachedModels,
        visionModel: input.visionAssets?.visionModel,
        assetLoader: input.visionAssets?.assetLoader,
        visionDescribePrompt: input.visionAssets?.visionDescribePrompt,
        voiceTranscriber: input.voiceTranscriber,
        onAttachmentDescriptions: input.onAttachmentDescriptions,
      });
      return { streamResult, startedAt };
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }
  }

  /**
   * Drains a provider stream: collects text and reasoning chunks,
   * handles aborts via `onAbort`, saves the final result via `onFinal`,
   * and yields SSE events (text-delta, reasoning-delta, reasoning-done, finish).
   */
  private async *drainStream<TFinal extends DrainFinalSnapshot>(input: DrainStreamInput<TFinal>): AsyncGenerator<{ event: string; data: string }> {
    const { streamResult, signal, startedAt, debugLabel, onAbort, onFinal, omitMessageCountInFinish, prefill } = input;
    // ── CA-17/CANARY: loop observability. Counts every tool interaction so a
    // tool-loop runaway (model re-calling write_profile, or a false-positive
    // guard refusing valid input) is diagnosable from send-debug.log. Without
    // this the tool path is invisible: errors feed back to the model via the
    // SDK-internal stepCountIs loop and never reach a log line.
    let toolCallCount = 0;
    let toolResultCount = 0;
    let toolErrorCount = 0;

    const extractedToolCalls: ExtractedToolCall[] = [];
    const extractedToolResults: ExtractedToolResult[] = [];

    let textAccumulator = "";
    let reasoningAccumulator = "";
    let reasoningStartMs: number | null = null;
    let reasoningDurationMs: number | null = null;

    // The partial reply so far via onAbort (user Stop + provider cut); onAbort stores only non-empty text.
    const savePartial = async (): Promise<boolean> => {
      const { mainContent, reasoning } = extractThinkingTags(textAccumulator, reasoningAccumulator);
      await onAbort(mainContent, reasoning ?? "", reasoningStartMs ? Date.now() - reasoningStartMs : undefined, Date.now() - startedAt);
      return mainContent.length > 0;
    };

    // ── Collect stream chunks ──
    try {
      for await (const chunk of streamResult.stream) {
        if (signal?.aborted) {
          await savePartial();
          yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
          return;
        }
        if (chunk.type === "text-delta" && chunk.delta) {
          if (reasoningStartMs && reasoningAccumulator) {
            reasoningDurationMs = Date.now() - reasoningStartMs;
          }
          textAccumulator += chunk.delta;
          yield { event: "text-delta", data: JSON.stringify({ delta: chunk.delta }) };
        }
        if (chunk.type === "reasoning-delta") {
          if (!reasoningStartMs) reasoningStartMs = Date.now();
          reasoningAccumulator += chunk.textDelta;
          yield { event: "reasoning-delta", data: JSON.stringify({ delta: chunk.textDelta }) };
        }
        if (chunk.type === "tool-call") {
          toolCallCount++;
          extractedToolCalls.push({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: chunk.args,
            ...(chunk.providerOptions ? { providerOptions: chunk.providerOptions } : {}),
          });
          logSendDebug(`${debugLabel}.tool-call`, { chatId: input.chatId, n: toolCallCount, toolCallId: chunk.toolCallId, toolName: chunk.toolName, args: chunk.args });
          yield { event: "tool-call", data: JSON.stringify({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, args: chunk.args }) };
        }
        if (chunk.type === "tool-input-start") {
          yield { event: "tool-input-start", data: JSON.stringify({ toolCallId: chunk.toolCallId, toolName: chunk.toolName }) };
        }
        if (chunk.type === "tool-input-delta") {
          yield { event: "tool-input-delta", data: JSON.stringify({ toolCallId: chunk.toolCallId, delta: chunk.inputTextDelta }) };
        }
        if (chunk.type === "tool-result") {
          toolResultCount++;
          const isErr = chunk.isError ?? false;
          const matchedCall = extractedToolCalls.find(c => c.toolCallId === chunk.toolCallId);
          extractedToolResults.push({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: matchedCall ? matchedCall.args : {},
            result: chunk.output,
            isError: isErr,
          });
          // isError=true means the tool's execute() threw (e.g. the CA-17
          // lost-section guard refused the proposal). The stream-helpers layer
          // normalizes the SDK v6 `tool-error` part into this tool-result +
          // isError shape, carrying the error message in `output`. Log it so
          // the exact refusal reason is on disk, not just fed back to the model.
          logSendDebug(`${debugLabel}.tool-result`, { chatId: input.chatId, n: toolResultCount, toolCallId: chunk.toolCallId, toolName: chunk.toolName, isError: isErr, output: isErr ? chunk.output : undefined });
          yield { event: "tool-result", data: JSON.stringify({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, output: chunk.output, isError: isErr }) };
          if (isErr) toolErrorCount++;
        }
        // NOTE: v6 has no separate 'tool-error' stream part at this layer —
        // stream-helpers normalizes SDK `tool-error` into `tool-result` with
        // isError:true above. The draining union (ProviderStreamChunk) reflects
        // that, so there is nothing else to handle here.
      }
    } catch (err) {
      if (signal?.aborted) {
        await savePartial();
        yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
        return;
      }

      const message = extractProviderErrorMessage(err);
      const category = classifyProviderError(err);
      // A provider cut mid-reply keeps what streamed, like a Stop; `partialSaved` → the client reloads the chat.
      const partialSaved = await savePartial();
      logSendDebug(`${debugLabel}.provider-error`, { chatId: input.chatId, message, category, partialSaved });
      if (!partialSaved) this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      yield { event: "error", data: JSON.stringify(partialSaved ? { message, category, partialSaved } : { message, category }) };
      return;
    }

    if (signal?.aborted) {
      await savePartial();
      yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
      return;
    }

    // ── Finalize ──
    const latencyMs = Date.now() - startedAt;
    let finish: Awaited<typeof streamResult.finished>;
    try {
      finish = await streamResult.finished;
    } catch {
      finish = { finishReason: "error" } as Awaited<typeof streamResult.finished>;
    }
    // CA-17/CANARY: log how the tool loop terminated. finishReason + the
    // tool-interaction counts reveal whether the model looped on a refusal
    // (high toolCallCount, toolResult isError) or never called tools at all
    // (toolCallCount=0 → the repeated phrase was plain text, not real calls).
    logSendDebug(`${debugLabel}.finish`, { chatId: input.chatId, finishReason: finish.finishReason, toolCalls: toolCallCount, toolResults: toolResultCount, toolErrors: toolErrorCount, latencyMs });
    let rawText: string;
    try {
      rawText = textAccumulator || (await streamResult.text);
    } catch {
      rawText = textAccumulator;
    }
    let rawReasoning: string | undefined;
    try {
      rawReasoning = reasoningAccumulator || (await streamResult.reasoning) || undefined;
    } catch {
      rawReasoning = reasoningAccumulator || undefined;
    }

    // CPF-fix1: the fallback stitch runs on the RAW reply inside the helper (merge BEFORE extract+regex); prefill echo otherwise.
    const textWithPrefill = stitchContinuationOrPrefill(input, rawText, debugLabel);
    const { mainContent: finalText, reasoning: finalReasoning } = extractThinkingTags(textWithPrefill, rawReasoning);
    // RX-8 regex seam: AI_OUTPUT transform (persist-mode presets, main content only) — covers ALL stream paths funneling through drainStream. Deltas stream raw (ST parity); only the final stored text is transformed.
    const transformedFinalText = await this.applyRegexLayer("AI_OUTPUT", input.chatId, finalText);
    // RX-10 regex seam: REASONING transform (persist-mode presets, reasoning only) — same single choke point for every stream path; guarded so undefined/empty never fires the hook.
    const transformedFinalReasoning = finalReasoning
      ? await this.applyRegexLayer("REASONING", input.chatId, finalReasoning)
      : finalReasoning;

    if (reasoningStartMs && reasoningDurationMs === null) {
      reasoningDurationMs = Date.now() - reasoningStartMs;
    }

    const snapshot = await onFinal(transformedFinalText, transformedFinalReasoning, reasoningDurationMs ?? undefined, latencyMs, extractedToolCalls.length > 0 ? extractedToolCalls : undefined, extractedToolResults.length > 0 ? extractedToolResults : undefined);

    // ── Yield reasoning-done + finish ──
    if (reasoningAccumulator || streamResult.hasRedactedReasoning) {
      yield {
        event: "reasoning-done",
        data: JSON.stringify({
          durationMs: reasoningDurationMs,
          redacted: streamResult.hasRedactedReasoning,
        }),
      };
    }

    const finishData: Record<string, unknown> = {
      finishReason: finish.finishReason,
      usage: finish.usage,
    };
    if (!omitMessageCountInFinish) {
      finishData.messageCount = snapshot.messages.length;
    }
    // P21 (overflowAlert): the per-book overflow notices ride the finish
    // event (same channel as usage) — the client toasts them once per turn.
    if (snapshot.lorebookOverflows?.length) {
      finishData.lorebookOverflows = snapshot.lorebookOverflows;
    }
    yield { event: "finish", data: JSON.stringify(finishData) };
  }
}
