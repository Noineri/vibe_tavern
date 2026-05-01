import type {
  CreateBranchRequest,
  CreateBranchResponse,
  CreateChatRequest,
  CreateChatResponse,
  DeleteBranchResponse,
  SendMessageRequest,
  SleepBranchRequest,
  SleepBranchResponse,
} from "./chat-application-types.js";
import { brandId } from "@rp-platform/domain";
import type {
  Chat,
  ChatBranchId,
  ChatId,
  Message,
  MessageId,
  SummaryMemorySnapshot,
} from "@rp-platform/domain";
import type { ChatBranchState, ChatSessionStore } from "@rp-platform/db";
import { notFound } from "./errors.js";

export class ChatApplicationService {
  constructor(private readonly store: ChatSessionStore) {}

  createChat(input: CreateChatRequest): CreateChatResponse {
    const result = this.store.createChat({
      characterId: input.characterId,
      personaId: input.personaId,
      title: input.title,
      promptPresetId: input.promptPresetId,
      toolProfileId: input.toolProfileId,
    });

    return {
      id: result.chat.id,
      activeBranchId: result.rootBranch.id,
    };
  }

  getChatState(chatId: ChatId, branchId?: ChatBranchId): {
    chat: Chat;
    branchState: ChatBranchState;
  } {
    const chat = this.requireChat(chatId);
    const resolvedBranchId = branchId ?? chat.activeBranchId;
    const branchState = this.store.getBranchState(chat.id, resolvedBranchId);

    if (!branchState) {
      throw notFound("Branch", `Branch '${resolvedBranchId}' was not found for chat '${chat.id}'.`);
    }

    return {
      chat,
      branchState,
    };
  }

  appendUserMessage(
    chatId: ChatId,
    input: SendMessageRequest,
    branchId?: ChatBranchId,
  ): Message {
    const chat = this.requireChat(chatId);
    const targetBranchId = branchId ?? chat.activeBranchId;

    return this.store.appendMessage({
      chatId,
      branchId: targetBranchId,
      role: "user",
      authorType: "user",
      content: input.content,
    });
  }

  editMessage(messageId: string, content: string): Message {
    return this.store.updateMessage(brandId<MessageId>(messageId), content);
  }

  deleteMessage(messageId: string): void {
    this.store.deleteMessage(brandId<MessageId>(messageId));
  }

  createBranch(chatId: ChatId, input: CreateBranchRequest): CreateBranchResponse {
    const result = this.store.forkBranch({
      chatId,
      sourceBranchId: input.sourceBranchId,
      forkedFromMessageId: input.forkedFromMessageId ?? null,
      label: input.label,
      activateFork: input.activateFork,
    });

    return {
      branchId: result.branch.id,
      copiedMessageCount: result.copiedMessageCount,
    };
  }

  activateBranch(chatId: ChatId, branchId: ChatBranchId): Chat {
    return this.store.activateBranch(chatId, branchId);
  }

  sleepBranch(chatId: ChatId, input: SleepBranchRequest): SleepBranchResponse {
    const snapshot = this.store.sleepBranch({
      chatId,
      branchId: input.branchId,
      kind: input.kind,
      summary: input.summary,
      coversThroughMessageId: input.coversThroughMessageId,
    });

    return mapSleepResponse(snapshot);
  }

  deleteBranch(chatId: ChatId, branchId: ChatBranchId): DeleteBranchResponse {
    const result = this.store.deleteBranch(chatId, branchId);

    return {
      chatId,
      activeBranchId: result.activeBranchId,
      deletedBranchId: result.deletedBranchId,
    };
  }

  private requireChat(chatId: ChatId): Chat {
    const chat = this.store.getChat(chatId);
    if (!chat) {
      throw notFound("Chat", `Chat '${chatId}' was not found.`);
    }
    return chat;
  }
}

function mapSleepResponse(snapshot: SummaryMemorySnapshot): SleepBranchResponse {
  return {
    snapshotId: snapshot.id,
    branchId: snapshot.branchId,
    kind: snapshot.kind,
  };
}
