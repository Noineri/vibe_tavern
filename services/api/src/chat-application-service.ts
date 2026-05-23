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
  ChatBranchId,
  ChatId,
  Message,
  MessageId,
  SummaryMemorySnapshot,
} from "@rp-platform/domain";
import type { ChatStore } from "@rp-platform/db";
import { notFound } from "./errors.js";

export class ChatApplicationService {
  constructor(private readonly chatStore: ChatStore) {}

  async createChat(input: CreateChatRequest): Promise<CreateChatResponse> {
    const chat = await this.chatStore.createChat({
      characterId: input.characterId,
      personaId: input.personaId,
      title: input.title,
      promptPresetId: input.promptPresetId,
    });

    return {
      id: chat.id as ChatId,
      activeBranchId: chat.activeBranchId,
    };
  }

  async getChatState(chatId: ChatId, branchId?: ChatBranchId, options?: { limit?: number }): Promise<{
    chat: import("@rp-platform/db").Chat;
    branch: import("@rp-platform/db").ChatBranch;
    messages: import("@rp-platform/db").Message[];
    hasMore: boolean;
    summaries: SummaryMemorySnapshot[];
  }> {
    const chat = await this.requireChat(chatId);
    let resolvedBranchId = branchId ?? chat.activeBranchId;
    const branches = await this.chatStore.getBranches(chat.id);
    let branch = branches.find((b) => b.id === resolvedBranchId);
    // Defensive fallback: if activeBranchId is dangling, fall back to the root branch
    if (!branch && branches.length > 0) {
      branch = branches.find((b) => b.parentBranchId === null) ?? branches[0];
      resolvedBranchId = branch.id;
      await this.chatStore.activateBranch(chat.id, branch.id as ChatBranchId);
    }
    if (!branch) {
      throw notFound("Branch", `Branch '${resolvedBranchId}' was not found for chat '${chat.id}'.`);
    }
    
    const limit = options?.limit ?? 50;
    const messages = await this.chatStore.getMessages(branch.id, { limit: limit + 1 });
    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(1) : messages;

    return {
      chat,
      branch,
      messages: resultMessages,
      hasMore,
      summaries: [], // Phase 2: summary snapshots
    };
  }

  async getMessages(
    chatId: ChatId,
    options: { limit?: number; beforeMessageId?: string },
    branchId?: ChatBranchId,
  ): Promise<{ messages: import("@rp-platform/db").Message[]; hasMore: boolean }> {
    const chat = await this.requireChat(chatId);
    const targetBranchId = branchId ?? chat.activeBranchId;
    const limit = options.limit ?? 50;
    
    const messages = await this.chatStore.getMessages(targetBranchId, { 
      limit: limit + 1, 
      beforeMessageId: options.beforeMessageId 
    });
    
    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(1) : messages;
    
    return {
      messages: resultMessages,
      hasMore,
    };
  }

  async appendUserMessage(
    chatId: ChatId,
    input: SendMessageRequest,
    branchId?: ChatBranchId,
  ): Promise<Message> {
    const chat = await this.requireChat(chatId);
    const targetBranchId = branchId ?? chat.activeBranchId;

    const message = await this.chatStore.addMessage({
      chatId,
      branchId: targetBranchId,
      role: "user",
      authorType: "user",
      content: input.content,
    });

    return message as unknown as Message;
  }

  async editMessage(messageId: string, content: string): Promise<Message> {
    const message = await this.chatStore.editMessage(messageId, content);
    return message as unknown as Message;
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.chatStore.deleteMessage(messageId);
  }

  async createBranch(chatId: ChatId, input: CreateBranchRequest): Promise<CreateBranchResponse> {
    const branch = await this.chatStore.forkBranch(
      chatId,
      input.forkedFromMessageId ?? "",
      input.label,
    );

    if (input.activateFork !== false) {
      await this.chatStore.activateBranch(chatId, branch.id as ChatBranchId);
    }

    // Count messages in the new branch for the response
    const messages = await this.chatStore.getMessages(branch.id);
    return {
      branchId: branch.id as ChatBranchId,
      copiedMessageCount: messages.length,
    };
  }

  async activateBranch(chatId: ChatId, branchId: ChatBranchId): Promise<import("@rp-platform/db").Chat> {
    return this.chatStore.activateBranch(chatId, branchId);
  }

  async sleepBranch(_chatId: ChatId, _input: SleepBranchRequest): Promise<SleepBranchResponse> {
    // Phase 2: summary snapshots
    throw new Error("Not implemented: summary snapshots are phase 2");
  }

  async deleteBranch(chatId: ChatId, branchId: ChatBranchId): Promise<DeleteBranchResponse> {
    await this.chatStore.deleteBranch(branchId);
    const chat = await this.requireChat(chatId);
    return {
      chatId,
      activeBranchId: chat.activeBranchId as ChatBranchId,
      deletedBranchId: branchId,
    };
  }

  private async requireChat(chatId: ChatId): Promise<import("@rp-platform/db").Chat> {
    const chat = await this.chatStore.getById(chatId);
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
