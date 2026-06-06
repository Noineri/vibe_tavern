import type { AssemblePromptResponse, Message, PromptTrace } from "@vibe-tavern/domain";
import { brandId, type ChatBranchId, type ChatId, type MessageId } from "@vibe-tavern/domain";
import type { ChatStore } from "@vibe-tavern/db";
import type { ChatApplicationService } from "../chat/chat-application-service.js";
import type { SessionSnapshot } from "./session-runtime.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import { logSendDebug } from "../send-debug-log.js";

export interface PreparedLiveTurn {
  prompt: AssemblePromptResponse;
  snapshot: SessionSnapshot;
  userMessage?: {
    id: MessageId;
    content: string;
  };
}

interface PendingPromptTraceTurn {
  branchId: ChatBranchId;
  draft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
}

export interface ChatRuntimeDeps {
  chats: ChatStore;
  chatApp: ChatApplicationService;
  assemblePrompt: (
    chatId: ChatId,
    branchId?: ChatBranchId,
    options?: { excludeMessageIds?: MessageId[]; model?: string; recentMessageLimit?: number; mode?: "chat" | "continue" | "regenerate" | "summary" | "tool_call"; contextBudget?: number | null; responseReserve?: number },
  ) => Promise<{
    branchId: ChatBranchId;
    prompt: AssemblePromptResponse;
    promptTraceDraft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
  }>;
  getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
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
   * If `content` is empty, skips user message insertion (used for continue/regenerate).
   */
  async prepareLiveTurn(chatId: ChatId, content: string, model: string, responseReserve?: number): Promise<PreparedLiveTurn> {
    const { chatApp, assemblePrompt, getSnapshot } = this.deps;
    const trimmed = content.trim();
    if (!trimmed) {
      const assembled = await assemblePrompt(chatId, undefined, { model, responseReserve });
      return {
        prompt: assembled.prompt,
        snapshot: await getSnapshot(chatId),
      };
    }

    const userMessage = await chatApp.appendUserMessage(chatId, {
      content: trimmed,
      mode: "reply",
    });

    let assembled;
    try {
      assembled = await assemblePrompt(chatId, undefined, { model, responseReserve });
    } catch (err) {
      try {
        await this.deps.chatApp.deleteMessage(userMessage.id);
      } catch {}
      throw err;
    }
    this.pendingPromptTraceByChat.set(chatId, {
      branchId: assembled.branchId,
      draft: assembled.promptTraceDraft,
    });

    return {
      prompt: assembled.prompt,
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

  async appendAssistantReply(
    chatId: ChatId,
    content: string,
    latencyMs: number,
    reasoningData?: { reasoning?: string; reasoningDurationMs?: number },
  ): Promise<SessionSnapshot> {
    const { chats, assemblePrompt, getSnapshot } = this.deps;
    const chat = (await chats.getById(chatId))!;

    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId as ChatBranchId);

    const assistantMessage = await chats.addMessage({
      chatId,
      branchId: chat.activeBranchId,
      role: "assistant",
      authorType: "assistant",
      content,
      modelId: pending?.draft.model ?? null,
      reasoning: reasoningData?.reasoning,
      reasoningDurationMs: reasoningData?.reasoningDurationMs,
    });

    if (pending) {
      await chats.saveTrace({
        chatId,
        branchId: pending.branchId,
        messageId: assistantMessage.id,
        model: pending.draft.model,
        presetName: pending.draft.presetName,
        assembledLayers: pending.draft.assembledLayers,
        tokenAccounting: pending.draft.tokenAccounting,
        finalPayload: pending.draft.finalPayload,
        activatedLoreEntries: pending.draft.activatedLoreEntries,
        retrievedMemories: pending.draft.retrievedMemories ?? [],
        scriptInjections: pending.draft.scriptInjections ?? [],
        latencyMs,
        prefill: pending.draft.prefill,
        compactionSummary: pending.draft.compactionSummary,
      });
    }

    const snapshot = await getSnapshot(chatId);
    logSendDebug("prompt.trace.afterAppend", {
      chatId,
      messageId: assistantMessage.id,
      traceCount: snapshot.promptTraceHistory.length,
      latestTraceId: snapshot.promptTraceHistory[0]?.id ?? null,
      latestTraceCreatedAt: snapshot.promptTraceHistory[0]?.createdAt ?? null,
      latestTraceLayers: snapshot.promptTraceHistory[0]?.layers?.length ?? 0,
      personaLayerSourceId: snapshot.promptTraceHistory[0]?.layers?.find((l: { sourceType: string }) => l.sourceType === "persona")?.sourceId ?? null,
    });
    return snapshot;
  }

  async appendMessageVariant(
    chatId: ChatId,
    messageId: MessageId,
    input: { content: string; finishReason?: string | null; latencyMs: number; reasoning?: string; reasoningDurationMs?: number },
  ): Promise<SessionSnapshot> {
    const { chats, getSnapshot } = this.deps;
    const trimmed = input.content.trim();
    if (!trimmed) {
      return await getSnapshot(chatId);
    }

    const chat = (await chats.getById(chatId))!;
    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId as ChatBranchId);

    await chats.addVariant(
      messageId,
      trimmed,
      input.finishReason ?? undefined,
      input.reasoning,
      input.reasoningDurationMs,
      pending?.draft.model ?? null,
    );

    if (pending) {
      await chats.saveTrace({
        chatId,
        branchId: pending.branchId,
        messageId,
        model: pending.draft.model,
        presetName: pending.draft.presetName,
        assembledLayers: pending.draft.assembledLayers,
        tokenAccounting: pending.draft.tokenAccounting,
        finalPayload: pending.draft.finalPayload,
        activatedLoreEntries: pending.draft.activatedLoreEntries,
        retrievedMemories: pending.draft.retrievedMemories ?? [],
        scriptInjections: pending.draft.scriptInjections ?? [],
        latencyMs: input.latencyMs,
        prefill: pending.draft.prefill,
        compactionSummary: pending.draft.compactionSummary,
      });
    }
    return await getSnapshot(chatId);
  }

  async selectMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): Promise<SessionSnapshot> {
    await this.deps.chats.selectVariant(messageId, variantIndex);
    return await this.deps.getSnapshot(chatId);
  }

  async deleteMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): Promise<SessionSnapshot> {
    await this.deps.chats.deleteVariant(messageId, variantIndex);
    return await this.deps.getSnapshot(chatId);
  }

  async editMessage(chatId: ChatId, messageId: string, content: string): Promise<SessionSnapshot> {
    await this.deps.chatApp.editMessage(messageId, content);
    return await this.deps.getSnapshot(chatId);
  }

  async renameBranch(chatId: ChatId, branchId: string, label: string): Promise<SessionSnapshot> {
    await this.deps.chats.renameBranch(branchId, label);
    return await this.deps.getSnapshot(chatId);
  }

  async deleteMessage(chatId: ChatId, messageId: string): Promise<SessionSnapshot> {
    await this.deps.chatApp.deleteMessage(messageId);
    return await this.deps.getSnapshot(chatId);
  }

  async forkBranch(chatId: ChatId, fromMessageId?: string): Promise<SessionSnapshot> {
    const { chatApp, chats, getSnapshot } = this.deps;
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
    return await getSnapshot(chatId);
  }

  async activateBranch(chatId: ChatId, branchId: ChatBranchId): Promise<SessionSnapshot> {
    await this.deps.chatApp.activateBranch(chatId, branchId);
    this.pendingPromptTraceByChat.delete(chatId);
    return await this.deps.getSnapshot(chatId);
  }

  async deleteBranch(chatId: string, branchId: string): Promise<SessionSnapshot> {
    const typedChatId = brandId<ChatId>(chatId);
    const typedBranchId = brandId<ChatBranchId>(branchId);
    await this.deps.chatApp.deleteBranch(typedChatId, typedBranchId);
    this.pendingPromptTraceByChat.delete(typedChatId);
    return await this.deps.getSnapshot(typedChatId);
  }

  async renameChat(chatId: string, title: string): Promise<{ chatId: string; title: string }> {
    await this.deps.chats.updateTitle(chatId, title);
    return { chatId, title };
  }

  async cloneChat(chatId: string): Promise<SessionSnapshot> {
    // Phase 1: clone not supported via ChatStore — B-DM6 will handle via session-runtime
    throw new Error("Not implemented: cloneChat will be handled in B-DM6");
  }

  async deleteChat(chatId: string): Promise<void> {
    const typedChatId = brandId<ChatId>(chatId);
    this.deps.chatOrder.remove(typedChatId);
    this.pendingPromptTraceByChat.delete(typedChatId);
    await this.deps.chats.delete(typedChatId);
  }

  async assemblePromptPreview(
    chatId: ChatId,
    options: { excludeMessageId?: MessageId; model: string; contextBudget?: number | null; responseReserve?: number },
  ): Promise<AssemblePromptResponse> {
    const { assemblePrompt } = this.deps;
    const assembled = await assemblePrompt(chatId, undefined, {
      excludeMessageIds: options.excludeMessageId ? [options.excludeMessageId] : [],
      model: options.model,
      contextBudget: options.contextBudget,
      responseReserve: options.responseReserve,
    });
    if (options.excludeMessageId) {
      this.pendingPromptTraceByChat.set(chatId, {
        branchId: assembled.branchId,
        draft: assembled.promptTraceDraft,
      });
    }
    return assembled.prompt;
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
}
