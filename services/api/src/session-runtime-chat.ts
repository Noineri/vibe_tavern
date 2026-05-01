import type { AssemblePromptResponse, Message, PromptTrace } from "@rp-platform/domain";
import { brandId, type ChatBranchId, type ChatId, type MessageId } from "@rp-platform/domain";
import type { ChatSessionStore } from "@rp-platform/db";
import type { ChatApplicationService } from "./chat-application-service.js";
import type { SessionSnapshot } from "./session-runtime.js";
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
  store: ChatSessionStore;
  chatApp: ChatApplicationService;
  expandChatMacros: (chatId: ChatId, text: string) => string;
  assemblePrompt: (
    chatId: ChatId,
    branchId?: ChatBranchId,
    options?: { excludeMessageIds?: MessageId[]; model?: string },
  ) => {
    branchId: ChatBranchId;
    prompt: AssemblePromptResponse;
    promptTraceDraft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
  };
  getSnapshot: (chatId: ChatId) => SessionSnapshot;
  chatOrder: {
    add: (chatId: ChatId) => void;
    remove: (chatId: ChatId) => void;
  };
}

export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps;
  private readonly pendingPromptTraceByChat = new Map<ChatId, PendingPromptTraceTurn>();

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps;
  }

  prepareLiveTurn(chatId: ChatId, content: string, model: string): PreparedLiveTurn {
    const { store, chatApp, expandChatMacros, assemblePrompt, getSnapshot } = this.deps;
    const trimmed = content.trim();
    if (!trimmed) {
      const assembled = assemblePrompt(chatId, undefined, { model });
      return {
        prompt: assembled.prompt,
        snapshot: getSnapshot(chatId),
      };
    }

    const expandedContent = expandChatMacros(chatId, trimmed);

    const userMessage = chatApp.appendUserMessage(chatId, {
      content: expandedContent,
      mode: "reply",
    });

    let assembled;
    try {
      assembled = assemblePrompt(chatId, undefined, { model });
    } catch (err) {
      try {
        store.deleteMessage(userMessage.id);
      } catch {}
      throw err;
    }
    this.pendingPromptTraceByChat.set(chatId, {
      branchId: assembled.branchId,
      draft: assembled.promptTraceDraft,
    });

    return {
      prompt: assembled.prompt,
      snapshot: getSnapshot(chatId),
    };
  }

  discardPendingPromptTrace(chatId: ChatId): void {
    this.pendingPromptTraceByChat.delete(chatId);
  }

  appendAssistantReply(chatId: ChatId, content: string, latencyMs: number): SessionSnapshot {
    const { store, assemblePrompt, getSnapshot } = this.deps;
    const chat = store.getChat(chatId)!;
    const fallbackDraft = assemblePrompt(chatId, chat.activeBranchId).promptTraceDraft;

    const assistantMessage = store.appendMessage({
      chatId,
      branchId: chat.activeBranchId,
      role: "assistant",
      authorType: "assistant",
      content,
    });

    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId);
    const baseDraft = pending?.draft ?? fallbackDraft;
    this.persistPromptTrace(assistantMessage.id, { ...baseDraft, latencyMs });
    const snapshot = getSnapshot(chatId);
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

  appendMessageVariant(
    chatId: ChatId,
    messageId: MessageId,
    input: { content: string; finishReason?: string | null; latencyMs: number },
  ): SessionSnapshot {
    const { store, assemblePrompt, getSnapshot } = this.deps;
    const trimmed = input.content.trim();
    if (!trimmed) {
      return getSnapshot(chatId);
    }

    const chat = store.getChat(chatId)!;
    const fallbackDraft = assemblePrompt(chatId, chat.activeBranchId, {
      excludeMessageIds: [messageId],
    }).promptTraceDraft;
    store.createMessageVariant({
      messageId,
      content: trimmed,
      finishReason: input.finishReason ?? null,
      isSelected: true,
    });
    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId);
    const baseDraft = pending?.draft ?? fallbackDraft;
    this.persistPromptTrace(messageId, { ...baseDraft, latencyMs: input.latencyMs });
    return getSnapshot(chatId);
  }

  selectMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): SessionSnapshot {
    this.deps.store.selectMessageVariant(messageId, variantIndex);
    return this.deps.getSnapshot(chatId);
  }

  editMessage(chatId: ChatId, messageId: string, content: string): SessionSnapshot {
    this.deps.chatApp.editMessage(messageId, content);
    return this.deps.getSnapshot(chatId);
  }

  deleteMessage(chatId: ChatId, messageId: string): SessionSnapshot {
    this.deps.chatApp.deleteMessage(messageId);
    return this.deps.getSnapshot(chatId);
  }

  forkBranch(chatId: ChatId): SessionSnapshot {
    const { chatApp, store, getSnapshot } = this.deps;
    const { branchState } = chatApp.getChatState(chatId);
    const lastMessage = branchState.messages[branchState.messages.length - 1];

    chatApp.createBranch(chatId, {
      sourceBranchId: branchState.branch.id,
      forkedFromMessageId: lastMessage?.id ?? null,
      label: `branch ${store.listBranches(chatId).length + 1}`,
      activateFork: true,
    });

    this.pendingPromptTraceByChat.delete(chatId);
    return getSnapshot(chatId);
  }

  activateBranch(chatId: ChatId, branchId: ChatBranchId): SessionSnapshot {
    this.deps.chatApp.activateBranch(chatId, branchId);
    this.pendingPromptTraceByChat.delete(chatId);
    return this.deps.getSnapshot(chatId);
  }

  deleteBranch(chatId: string, branchId: string): SessionSnapshot {
    const typedChatId = brandId<ChatId>(chatId);
    const typedBranchId = brandId<ChatBranchId>(branchId);
    this.deps.chatApp.deleteBranch(typedChatId, typedBranchId);
    this.pendingPromptTraceByChat.delete(typedChatId);
    return this.deps.getSnapshot(typedChatId);
  }

  renameChat(chatId: string, title: string): { chatId: string; title: string } {
    this.deps.store.renameChat(brandId<ChatId>(chatId), title);
    return { chatId, title };
  }

  cloneChat(chatId: string): SessionSnapshot {
    const { store, chatOrder, getSnapshot } = this.deps;
    const result = store.cloneChat(brandId<ChatId>(chatId));
    chatOrder.add(result.chat.id);
    return getSnapshot(result.chat.id);
  }

  deleteChat(chatId: string): void {
    const typedChatId = brandId<ChatId>(chatId);
    this.deps.chatOrder.remove(typedChatId);
    this.pendingPromptTraceByChat.delete(typedChatId);
    this.deps.store.deleteChat(typedChatId);
  }

  assemblePromptPreview(
    chatId: ChatId,
    options: { excludeMessageId?: MessageId; model: string },
  ): AssemblePromptResponse {
    const { assemblePrompt } = this.deps;
    const assembled = assemblePrompt(chatId, undefined, {
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

  private persistPromptTrace(
    messageId: Message["id"],
    draft: Omit<PromptTrace, "id" | "messageId" | "createdAt">,
  ): void {
    this.deps.store.createPromptTrace({
      ...draft,
      messageId,
    });
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
