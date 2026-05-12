import type { AssemblePromptResponse, Message, PromptTrace } from "@rp-platform/domain";
import { brandId, type ChatBranchId, type ChatId, type MessageId } from "@rp-platform/domain";
import type { ChatStore } from "@rp-platform/db";
import type { ChatApplicationService } from "./chat-application-service.js";
import type { SessionSnapshot } from "./session-runtime.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import { logSendDebug } from "./send-debug-log.js";

export interface PreparedLiveTurn {
  prompt: AssemblePromptResponse;
  snapshot: SessionSnapshot;
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
    options?: { excludeMessageIds?: MessageId[]; model?: string; recentMessageLimit?: number; mode?: "chat" | "continue" | "regenerate" | "summary" | "tool_call"; contextBudget?: number | null },
  ) => Promise<{
    branchId: ChatBranchId;
    prompt: AssemblePromptResponse;
    promptTraceDraft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
  }>;
  getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
  chatOrder: IChatOrder;
}

export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps;
  private readonly pendingPromptTraceByChat = new Map<ChatId, PendingPromptTraceTurn>();

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps;
  }

  async prepareLiveTurn(chatId: ChatId, content: string, model: string): Promise<PreparedLiveTurn> {
    const { chatApp, assemblePrompt, getSnapshot } = this.deps;
    const trimmed = content.trim();
    if (!trimmed) {
      const assembled = await assemblePrompt(chatId, undefined, { model });
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
      assembled = await assemblePrompt(chatId, undefined, { model });
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
    };
  }

  discardPendingPromptTrace(chatId: ChatId): void {
    this.pendingPromptTraceByChat.delete(chatId);
  }

  async appendAssistantReply(chatId: ChatId, content: string, latencyMs: number): Promise<SessionSnapshot> {
    const { chats, assemblePrompt, getSnapshot } = this.deps;
    const chat = (await chats.getById(chatId))!;

    const assistantMessage = await chats.addMessage({
      chatId,
      branchId: chat.activeBranchId,
      role: "assistant",
      authorType: "assistant",
      content,
    });

    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId as ChatBranchId);
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
        latencyMs,
        prefill: pending.draft.prefill,
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
    input: { content: string; finishReason?: string | null; latencyMs: number },
  ): Promise<SessionSnapshot> {
    const { chats, getSnapshot } = this.deps;
    const trimmed = input.content.trim();
    if (!trimmed) {
      return await getSnapshot(chatId);
    }

    await chats.addVariant(messageId, trimmed, input.finishReason ?? undefined);

    const chat = (await chats.getById(chatId))!;
    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId as ChatBranchId);
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
        latencyMs: input.latencyMs,
        prefill: pending.draft.prefill,
      });
    }
    return await getSnapshot(chatId);
  }

  async selectMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): Promise<SessionSnapshot> {
    await this.deps.chats.selectVariant(messageId, variantIndex);
    return await this.deps.getSnapshot(chatId);
  }

  async editMessage(chatId: ChatId, messageId: string, content: string): Promise<SessionSnapshot> {
    await this.deps.chatApp.editMessage(messageId, content);
    return await this.deps.getSnapshot(chatId);
  }

  async deleteMessage(chatId: ChatId, messageId: string): Promise<SessionSnapshot> {
    await this.deps.chatApp.deleteMessage(messageId);
    return await this.deps.getSnapshot(chatId);
  }

  async forkBranch(chatId: ChatId): Promise<SessionSnapshot> {
    const { chatApp, chats, getSnapshot } = this.deps;
    const chatState = await chatApp.getChatState(chatId);
    const lastMessage = chatState.messages[chatState.messages.length - 1];

    const branches = await chats.getBranches(chatId);
    await chatApp.createBranch(chatId, {
      sourceBranchId: chatState.branch.id as ChatBranchId,
      forkedFromMessageId: (lastMessage?.id ?? null) as MessageId | null,
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
    options: { excludeMessageId?: MessageId; model: string },
  ): Promise<AssemblePromptResponse> {
    const { assemblePrompt } = this.deps;
    const assembled = await assemblePrompt(chatId, undefined, {
      excludeMessageIds: options.excludeMessageId ? [options.excludeMessageId] : [],
      model: options.model,
    });
    if (options.excludeMessageId) {
      this.pendingPromptTraceByChat.set(chatId, {
        branchId: assembled.branchId,
        draft: assembled.promptTraceDraft,
      });
    }
    return assembled.prompt;
  }

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
