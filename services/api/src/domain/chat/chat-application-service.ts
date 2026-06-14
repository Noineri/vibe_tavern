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
import { brandId, parseStoredAttachments } from "@vibe-tavern/domain";
import type {
  Attachment,
  ChatBranchId,
  ChatId,
  Message,
  MessageId,
  SummaryMemorySnapshot,
} from "@vibe-tavern/domain";
import type { ChatStore, Message as DbMessage } from "@vibe-tavern/db";
import { notFound } from "../../shared/errors.js";

/** Map a DB message row to a domain {@link Message} (brands IDs, narrows enum strings). */
function mapDbMessage(m: DbMessage): Message {
  return {
    id: brandId<MessageId>(m.id),
    chatId: brandId<ChatId>(m.chatId),
    branchId: brandId<ChatBranchId>(m.branchId),
    role: m.role as Message["role"],
    authorType: m.authorType as Message["authorType"],
    position: m.position,
    content: m.content,
    state: m.state as Message["state"],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

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
      attachmentsJson: input.attachments?.length ? JSON.stringify(input.attachments) : null,
    });

    return mapDbMessage(message);
  }

  async updateAttachmentDescriptions(messageId: string, currentAttachments: Attachment[], descriptions: Array<{ attachmentId: string; description: string }>): Promise<void> {
    const descMap = new Map(descriptions.map(d => [d.attachmentId, d.description]));
    const updated = currentAttachments.map(att => {
      const desc = descMap.get(att.id);
      return desc !== undefined ? { ...att, description: desc } : att;
    });
    await this.chatStore.updateMessageAttachments(messageId, JSON.stringify(updated));
  }

  async updateSingleAttachmentDescription(messageId: string, attachmentIdOrAttachments: string | Attachment[], descriptionOrAttachmentId?: string, description?: string): Promise<void> {
    // Overload: (messageId, attachmentId, description) — reads from DB
    if (typeof attachmentIdOrAttachments === 'string') {
      const message = await this.chatStore.getMessageById(messageId);
      if (!message) return;
      const currentAttachments: Attachment[] = parseStoredAttachments(message.attachmentsJson) ?? [];
      await this.updateAttachmentDescriptions(messageId, currentAttachments, [{ attachmentId: attachmentIdOrAttachments, description: descriptionOrAttachmentId ?? '' }]);
      return;
    }
    // Overload: (messageId, currentAttachments, attachmentId, description)
    await this.updateAttachmentDescriptions(messageId, attachmentIdOrAttachments, [{ attachmentId: descriptionOrAttachmentId!, description: description! }]);
  }

  async editMessage(messageId: string, content: string): Promise<Message> {
    const message = await this.chatStore.editMessage(messageId, content);
    return mapDbMessage(message);
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
