import type { AssemblePromptResponse, Message, PromptTrace, ProviderResponseTrace } from "@vibe-tavern/domain";
import { brandId, type ChatBranchId, type ChatId, type MessageId, type PromptPresetId } from "@vibe-tavern/domain";
import type { ChatStore, MessageStore, PromptTraceStore, DiceRollStore } from "@vibe-tavern/db";
import type { ToolSet } from "ai";
import type { ChatApplicationService } from "../../domain/chat/chat-application-service.js";
import type { SendMessageRequest } from "../../domain/chat/chat-application-types.js";
import type {
  SessionSnapshot,
  MessageResponse,
  VariantResponse,
  BranchResponse,
  BranchMetaResponse,
  ChatListResponse,
} from "./session-runtime.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import type { PromptTraceDraft } from "../../domain/prompt/prompt-assembly-service.js";
import type { ChatModeAssembleResult } from "../../domain/chat/chat-mode-strategy.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { notFound } from "../../shared/errors.js";

export interface PreparedLiveTurn {
  prompt: AssemblePromptResponse;
  /** AI SDK tools resolved by the chat-mode strategy (undefined for RP; co-author's editor tool set). */
  tools?: ToolSet;
  /** Max tool-calling rounds (only meaningful when `tools` is set). */
  maxSteps?: number;
  coauthorModuleId?: string;
  coauthorSkillId?: string | null;
  snapshot: SessionSnapshot;
  userMessage?: {
    id: MessageId;
    content: string;
  };
}

/** Internal append result: wire response plus immutable committed identity. */
export interface AppendedAssistantReply {
  response: MessageResponse;
  branchId: ChatBranchId;
  messageId: MessageId;
}

interface PendingPromptTraceTurn {
  branchId: ChatBranchId;
  draft: PromptTraceDraft;
  coauthorModuleId?: string | null;
  coauthorSkillId?: string | null;
}

export interface ChatRuntimeDeps {
  chats: ChatStore;
  messages: MessageStore;
  traces: PromptTraceStore;
  chatApp: ChatApplicationService;
  /** DICE-B11: dice roll store. Used only by `prepareLiveTurn`'s
   * assembly-failure cleanup to release rolls bound to a just-inserted user
   * message (a compensating write — NOT a transaction rollback). */
  diceRolls: DiceRollStore;
  assemblePrompt: (
    chatId: ChatId,
    branchId?: ChatBranchId,
    options?: { excludeMessageIds?: MessageId[]; model?: string; recentMessageLimit?: number; summary?: boolean; contextBudget?: number | null; responseReserve?: number; presetId?: PromptPresetId },
  ) => Promise<ChatModeAssembleResult>;
  getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
  /** Narrowed message-path response (messages + contextPreview + latest trace; summaries optional). */
  buildMessageResponse: (chatId: ChatId, opts?: { summaries?: boolean }) => Promise<MessageResponse>;
  /** Narrowed variant-path response (messages + contextPreview; activeChat optional). */
  buildVariantResponse: (chatId: ChatId, opts?: { activeChat?: boolean }) => Promise<VariantResponse>;
  /** Narrowed branch-mutation response: fork / activate / delete (conversation text moves). */
  buildBranchResponse: (chatId: ChatId) => Promise<BranchResponse>;
  /** Narrowed branch-meta response: rename-branch only (no text change → no contextPreview). */
  buildBranchMetaResponse: (chatId: ChatId) => Promise<BranchMetaResponse>;
  /** Narrowed chat-list response: rename-chat only (sidebar label changes, nothing else). */
  buildChatListResponse: () => Promise<ChatListResponse>;
  chatOrder: IChatOrder;
}

/**
 * Manages the live turn flow for a chat: prepare a prompt, stream/execute AI generation,
 * and append the result as an assistant message or variant.
 *
 * Stores pending prompt traces between {@link prepareLiveTurn} and
 * {@link appendAssistantReply} / {@link appendMessageVariant} so the trace is saved atomically with the reply.
 */
export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps;
  private readonly pendingPromptTraceByChat = new Map<ChatId, PendingPromptTraceTurn>();

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps;
  }

  /**
   * Prepares a live turn: appends user message (if content is non-empty),
   * assembles the prompt, and stores a pending prompt trace.
   *
   * If `content` is empty AND there are no attachments, skips user message
   * insertion (the continue/regenerate path). An attachment-only send (no prose
   * but with attachments) DOES insert — the message carries its attachments and,
   * when `diceCommit` is present, binds Dice exactly like a prose send (DICE-B11).
   */
  async prepareLiveTurn(chatId: ChatId, content: string, model: string, responseReserve?: number, attachments?: import("@vibe-tavern/domain").Attachment[], diceCommit?: SendMessageRequest["diceCommit"]): Promise<PreparedLiveTurn> {
    const { chatApp, assemblePrompt, getSnapshot } = this.deps;
    const trimmed = content.trim();
    const hasAttachments = !!(attachments && attachments.length > 0);
    if (!trimmed && !hasAttachments) {
      const assembled = await assemblePrompt(chatId, undefined, { model, responseReserve });
      return {
        prompt: assembled.prompt,
        tools: assembled.tools,
        maxSteps: assembled.maxSteps,
        snapshot: await getSnapshot(chatId),
      };
    }

    const userMessage = await chatApp.appendUserMessage(chatId, {
      content: trimmed,
      mode: "reply",
      attachments,
      diceCommit,
    });

    let assembled;
    try {
      assembled = await assemblePrompt(chatId, undefined, { model, responseReserve });
    } catch (err) {
      try {
        // DICE-B11: release any Dice rolls the atomic bind just attached to
        // this user message, THEN delete the message. This is a COMPENSATING
        // WRITE (not a tx rollback — the synchronous bind already committed
        // inside addMessageWithDiceBind). Release FIRST so rolls return to
        // pending regardless of the subsequent delete; both ops are idempotent
        // (no-op when no rolls are bound / message already gone). Runs ONLY on
        // assembly (preparation) failure, BEFORE the provider call — provider
        // failure after the user-message commit keeps the bound rolls.
        await this.deps.diceRolls.rollbackRelease(userMessage.id);
        await this.deps.chatApp.deleteMessage(userMessage.id);
      } catch { /* best-effort rollback of the just-inserted user message; the original assemble error is rethrown below */ }
      throw err;
    }
    this.pendingPromptTraceByChat.set(chatId, {
      branchId: assembled.branchId,
      draft: assembled.promptTraceDraft,
      coauthorModuleId: assembled.coauthorModuleId,
      coauthorSkillId: assembled.coauthorSkillId,
    });

    return {
      prompt: assembled.prompt,
      tools: assembled.tools,
      maxSteps: assembled.maxSteps,
      coauthorModuleId: assembled.coauthorModuleId,
      coauthorSkillId: assembled.coauthorSkillId,
      snapshot: await getSnapshot(chatId),
      userMessage: {
        id: userMessage.id,
        content: trimmed,
      },
    };
  }

  discardPendingPromptTrace(chatId: ChatId): void {
    this.pendingPromptTraceByChat.delete(chatId);
  }

  /** Patch the pending prompt trace with executor-level request/response data. */
  patchPendingTrace(chatId: ChatId, patch: {
    sentConfig?: AssemblePromptResponse["sentConfig"];
    providerResponse?: ProviderResponseTrace;
  }): void {
    const pending = this.pendingPromptTraceByChat.get(chatId);
    if (!pending) return;
    if (patch.sentConfig) pending.draft.sentConfig = patch.sentConfig;
    if (patch.providerResponse) pending.draft.providerResponse = patch.providerResponse;
  }

  async appendAssistantReply(
    chatId: ChatId,
    content: string,
    latencyMs: number,
    reasoningData?: {
      reasoning?: string;
      reasoningDurationMs?: number;
      toolCalls?: import("../../infrastructure/ai/provider-execution-types.js").ExtractedToolCall[];
      toolResults?: import("../../infrastructure/ai/provider-execution-types.js").ExtractedToolResult[];
    },
  ): Promise<AppendedAssistantReply> {
    const { chats, messages, traces, buildMessageResponse } = this.deps;
    const chat = (await chats.getById(chatId))!;
    const branchId = chat.activeBranchId as ChatBranchId;

    const pending = this.consumePendingPromptTrace(chatId, branchId);

    let assistantMessage: import("@vibe-tavern/db").Message;

    if (reasoningData?.toolCalls && reasoningData.toolCalls.length > 0) {
      await messages.addMessage({
        chatId,
        branchId,
        role: "assistant",
        authorType: "assistant",
        content: "",
        modelId: pending?.draft.model ?? null,
        presetName: pending?.draft.presetName ?? null,
        reasoning: reasoningData.reasoning,
        reasoningDurationMs: reasoningData.reasoningDurationMs,
        toolCallsJson: JSON.stringify(reasoningData.toolCalls.map(tc => ({
          id: tc.toolCallId,
          name: tc.toolName,
          args: tc.args,
          ...(tc.providerOptions ? { providerOptions: tc.providerOptions } : {}),
        }))),
      });

      if (reasoningData.toolResults) {
        for (const tr of reasoningData.toolResults) {
          await messages.addMessage({
            chatId,
            branchId,
            role: "tool",
            authorType: "tool",
            content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
            toolCallId: tr.toolCallId,
          });
        }
      }

      assistantMessage = await messages.addMessage({
        chatId,
        branchId,
        role: "assistant",
        authorType: "assistant",
        content,
        modelId: pending?.draft.model ?? null,
        presetName: pending?.draft.presetName ?? null,
        coauthorModuleId: pending?.coauthorModuleId ?? null,
        coauthorSkillId: pending?.coauthorSkillId ?? null,
      });
    } else {
      assistantMessage = await messages.addMessage({
        chatId,
        branchId,
        role: "assistant",
        authorType: "assistant",
        content,
        modelId: pending?.draft.model ?? null,
        presetName: pending?.draft.presetName ?? null,
        coauthorModuleId: pending?.coauthorModuleId ?? null,
        coauthorSkillId: pending?.coauthorSkillId ?? null,
        reasoning: reasoningData?.reasoning,
        reasoningDurationMs: reasoningData?.reasoningDurationMs,
      });
    }

    if (pending) {
      await traces.saveTrace({
        chatId,
        branchId: pending.branchId,
        messageId: assistantMessage.id,
        model: pending.draft.model,
        presetName: pending.draft.presetName ?? "(none)",
        assembledLayers: pending.draft.assembledLayers,
        tokenAccounting: pending.draft.tokenAccounting,
        finalPayload: pending.draft.finalPayload,
        activatedLoreEntries: pending.draft.activatedLoreEntries,
        activatedLoreDetail: pending.draft.activatedLoreDetail,
        retrievedMemories: pending.draft.retrievedMemories ?? [],
        scriptInjections: pending.draft.scriptInjections ?? [],
        latencyMs,
        prefill: pending.draft.prefill,
        compactionSummary: pending.draft.compactionSummary,
        sentConfig: pending.draft.sentConfig,
        providerResponse: pending.draft.providerResponse,
      });
    }

    // Narrowed response: messages + contextPreview + latest trace + summaries.
    // The full history is NOT shipped (lazy-loaded — see TRACE_LAZY_LOADING).
    const response = await buildMessageResponse(chatId, { summaries: true });
    logSendDebug("prompt.trace.afterAppend", {
      chatId,
      messageId: assistantMessage.id,
      latestTraceId: response.promptTrace?.id ?? null,
      latestTraceCreatedAt: response.promptTrace?.createdAt ?? null,
      latestTraceLayers: response.promptTrace?.layers?.length ?? 0,
      personaLayerSourceId: response.promptTrace?.layers?.find((l: { sourceType: string }) => l.sourceType === "persona")?.sourceId ?? null,
    });
    return { response, branchId, messageId: assistantMessage.id as MessageId };
  }

  async appendMessageVariant(
    chatId: ChatId,
    messageId: MessageId,
    input: {
      content: string;
      finishReason?: string | null;
      latencyMs: number;
      reasoning?: string;
      reasoningDurationMs?: number;
      toolCalls?: import("../../infrastructure/ai/provider-execution-types.js").ExtractedToolCall[];
      toolResults?: import("../../infrastructure/ai/provider-execution-types.js").ExtractedToolResult[];
    },
  ): Promise<MessageResponse> {
    const { chats, messages, traces, buildMessageResponse } = this.deps;
    const trimmed = input.content.trim();
    if (!trimmed) {
      return await buildMessageResponse(chatId);
    }

    const chat = (await chats.getById(chatId))!;
    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId as ChatBranchId);

    await messages.addVariant(
      messageId,
      trimmed,
      input.finishReason ?? undefined,
      input.reasoning,
      input.reasoningDurationMs,
      pending?.draft.model ?? null,
      // Preset is baked as a NAME snapshot (no FK) — sourced from the resolved
      // draft, which already reflects the override/chat/default cascade used
      // for THIS turn (see buildPipelineContext). Null when no preset resolved
      // or there is no pending trace.
      pending?.draft?.presetName ?? null,
      input.toolCalls && input.toolCalls.length > 0 ? JSON.stringify(input.toolCalls.map(tc => ({ id: tc.toolCallId, name: tc.toolName, args: tc.args }))) : null,
      null,
      pending?.coauthorModuleId ?? null,
      pending?.coauthorSkillId ?? null,
    );

    if (pending) {
      await traces.saveTrace({
        chatId,
        branchId: pending.branchId,
        messageId,
        model: pending.draft.model,
        presetName: pending.draft.presetName ?? "(none)",
        assembledLayers: pending.draft.assembledLayers,
        tokenAccounting: pending.draft.tokenAccounting,
        finalPayload: pending.draft.finalPayload,
        activatedLoreEntries: pending.draft.activatedLoreEntries,
        activatedLoreDetail: pending.draft.activatedLoreDetail,
        retrievedMemories: pending.draft.retrievedMemories ?? [],
        scriptInjections: pending.draft.scriptInjections ?? [],
        latencyMs: input.latencyMs,
        prefill: pending.draft.prefill,
        compactionSummary: pending.draft.compactionSummary,
        sentConfig: pending.draft.sentConfig,
        providerResponse: pending.draft.providerResponse,
      });
    }
    return await buildMessageResponse(chatId);
  }


  async addEditorVariant(
    chatId: ChatId,
    messageId: MessageId,
    input: {
      readonly content: string;
      readonly sourceVariantIds: readonly string[];
      readonly modelId?: string;
      readonly promptPresetId?: string;
      readonly finishReason?: string;
    },
  ): Promise<MessageResponse> {
    const targetMessage = await this.deps.messages.getMessageById(messageId);
    if (!targetMessage || targetMessage.chatId !== chatId) {
      throw notFound("Message", `Message '${messageId}' was not found in chat '${chatId}'.`);
    }

    // Bake the preset NAME from the resolved pending draft (set by the
    // assemblePromptPreview that precedes every editor commit). The draft
    // already reflects the override/chat/default cascade, so this is the
    // preset the editor turn actually used. Peek (not consume) — a subsequent
    // generated variant on the same trace still needs the draft.
    const presetName = this.peekPendingPresetName(chatId);
    await this.deps.chatApp.addEditorVariant(messageId, {
      content: input.content,
      sourceVariantIds: input.sourceVariantIds,
      modelId: input.modelId,
      presetName,
      finishReason: input.finishReason,
    });
    return await this.deps.buildMessageResponse(chatId);
  }

  async selectMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): Promise<VariantResponse> {
    await this.deps.messages.selectVariant(messageId, variantIndex);
    return await this.deps.buildVariantResponse(chatId);
  }

  async deleteMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): Promise<MessageResponse> {
    await this.deps.messages.deleteVariant(messageId, variantIndex);
    return await this.deps.buildMessageResponse(chatId);
  }

  async editMessage(chatId: ChatId, messageId: string, content: string, expectedVariantId?: string): Promise<MessageResponse> {
    await this.deps.chatApp.editMessage(messageId, content, expectedVariantId);
    return await this.deps.buildMessageResponse(chatId);
  }

  async renameBranch(chatId: ChatId, branchId: string, label: string): Promise<BranchMetaResponse> {
    await this.deps.chats.renameBranch(branchId, label);
    // Text unchanged → no contextPreview needed (only the branches list moves).
    return await this.deps.buildBranchMetaResponse(chatId);
  }

  async deleteMessage(chatId: ChatId, messageId: string): Promise<MessageResponse> {
    await this.deps.chatApp.deleteMessage(messageId);
    return await this.deps.buildMessageResponse(chatId, { summaries: true });
  }

  async forkBranch(chatId: ChatId, fromMessageId?: string): Promise<BranchResponse> {
    const { chatApp, chats, buildBranchResponse } = this.deps;
    const chatState = await chatApp.getChatState(chatId);
    let forkedFromId: string;
    if (fromMessageId) {
      forkedFromId = fromMessageId;
    } else {
      const lastMessage = chatState.messages[chatState.messages.length - 1];
      forkedFromId = lastMessage?.id ?? "";
    }

    const branches = await chats.getBranches(chatId);
    await chatApp.createBranch(chatId, {
      sourceBranchId: chatState.branch.id as ChatBranchId,
      forkedFromMessageId: forkedFromId as MessageId,
      label: `branch ${branches.length + 1}`,
      activateFork: true,
    });

    this.pendingPromptTraceByChat.delete(chatId);
    return await buildBranchResponse(chatId);
  }

  async activateBranch(chatId: ChatId, branchId: ChatBranchId): Promise<BranchResponse> {
    await this.deps.chatApp.activateBranch(chatId, branchId);
    this.pendingPromptTraceByChat.delete(chatId);
    return await this.deps.buildBranchResponse(chatId);
  }

  async deleteBranch(chatId: string, branchId: string): Promise<BranchResponse> {
    const typedChatId = brandId<ChatId>(chatId);
    const typedBranchId = brandId<ChatBranchId>(branchId);
    await this.deps.chatApp.deleteBranch(typedChatId, typedBranchId);
    this.pendingPromptTraceByChat.delete(typedChatId);
    return await this.deps.buildBranchResponse(typedChatId);
  }

  async renameChat(chatId: string, title: string): Promise<ChatListResponse> {
    await this.deps.chats.updateTitle(chatId, title);
    // Only the sidebar label moved → return the refreshed chats list. No
    // contextPreview (conversation text unchanged), no messages/branches.
    // The UI renders chat titles from the chats list (Sidebar.tsx / Rail.tsx),
    // not from activeChat.title, so a chats-only refresh updates every title.
    return this.deps.buildChatListResponse();
  }

  async cloneChat(chatId: string): Promise<SessionSnapshot> {
    // Phase 1: clone not supported via ChatStore — B-DM6 will handle via session-runtime
    throw new Error("Not implemented: cloneChat will be handled in B-DM6");
  }

  async deleteChat(chatId: string): Promise<ChatListResponse> {
    const typedChatId = brandId<ChatId>(chatId);
    this.deps.chatOrder.remove(typedChatId);
    this.pendingPromptTraceByChat.delete(typedChatId);
    await this.deps.chats.delete(typedChatId);
    // Return the refreshed chats list so the sidebar deterministically drops
    // the deleted chat. Previously the route returned 204 with no body, so the
    // frontend relied on a racy fire-and-forget bootstrap to refresh the list
    // — and a switchChat ingest (whose snapshot omits `chats`) could land last
    // and preserve the stale list, leaving a "ghost" chat until page reload.
    return this.deps.buildChatListResponse();
  }

  async assemblePromptPreview(
    chatId: ChatId,
    options: { excludeMessageId?: MessageId; model: string; contextBudget?: number | null; responseReserve?: number; presetId?: PromptPresetId },
  ): Promise<AssemblePromptResponse & { tools?: ToolSet; maxSteps?: number; coauthorModuleId?: string; coauthorSkillId?: string | null }> {
    const { assemblePrompt } = this.deps;
    const assembled = await assemblePrompt(chatId, undefined, {
      excludeMessageIds: options.excludeMessageId ? [options.excludeMessageId] : [],
      model: options.model,
      contextBudget: options.contextBudget,
      responseReserve: options.responseReserve,
      presetId: options.presetId,
    });
    if (options.excludeMessageId) {
      this.pendingPromptTraceByChat.set(chatId, {
        branchId: assembled.branchId,
        draft: assembled.promptTraceDraft,
      });
    }
    return { ...assembled.prompt, tools: assembled.tools, maxSteps: assembled.maxSteps, coauthorModuleId: assembled.coauthorModuleId, coauthorSkillId: assembled.coauthorSkillId };
  }

  /** Removes and returns the pending prompt trace for a chat/branch. Returns null if the branch doesn't match. */
  private consumePendingPromptTrace(
    chatId: ChatId,
    branchId: ChatBranchId,
  ): PendingPromptTraceTurn | null {
    const pending = this.pendingPromptTraceByChat.get(chatId);
    if (!pending || pending.branchId !== branchId) {
      return null;
    }

    this.pendingPromptTraceByChat.delete(chatId);
    return pending;
  }

  /** Peek (read without consuming) the resolved preset NAME on the pending
   *  draft for a chat. Used by the editor-variant path, which must NOT consume
   *  the draft — a subsequent generated variant on the same trace still needs
   *  it. Null when there is no pending trace or no preset was resolved. */
  private peekPendingPresetName(chatId: ChatId): string | null {
    return this.pendingPromptTraceByChat.get(chatId)?.draft.presetName ?? null;
  }
}
