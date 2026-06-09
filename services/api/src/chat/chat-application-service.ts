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
import { brandId } from "@vibe-tavern/domain";
import type {
  ChatBranchId,
  ChatId,
  Message,
  MessageId,
  SummaryMemorySnapshot,
} from "@vibe-tavern/domain";
import type { ChatStore } from "@vibe-tavern/db";
import { notFound } from "../errors.js";

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

  async getChatState(chatId: ChatId, branchId?: ChatBranchId): Promise<{
    chat: import("@vibe-tavern/db").Chat;
    branch: import("@vibe-tavern/db").ChatBranch;
    messages: import("@vibe-tavern/db").Message[];
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
    // Defensive: chat with zero branches — auto-create a root branch
    if (!branch && branches.length === 0) {
      const { chatBranches } = await import("@vibe-tavern/db");
      const branchId = this.chatStore["idGen"].next("brnch");
      const now = new Date().toISOString();
      await this.chatStore["db"].insert(chatBranches).values({
        id: branchId, chatId: chat.id, parentBranchId: null, forkedFromMessageId: null, label: "Root", createdAt: now,
      }).run();
      await this.chatStore.activateBranch(chat.id, branchId as ChatBranchId);
      branch = { id: branchId, chatId: chat.id, parentBranchId: null, forkedFromMessageId: null, label: "Root", createdAt: now };
      resolvedBranchId = branchId;
    }
    if (!branch) {
      throw notFound("Branch", `Branch '${resolvedBranchId}' was not found for chat '${chat.id}'.`);
    }
    const messages = await this.chatStore.getMessages(branch.id);

    return {
      chat,
      branch,
      messages,
      summaries: [], // Phase 2: summary snapshots
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

  async activateBranch(chatId: ChatId, branchId: ChatBranchId): Promise<import("@vibe-tavern/db").Chat> {
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

  private async requireChat(chatId: ChatId): Promise<import("@vibe-tavern/db").Chat> {
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
