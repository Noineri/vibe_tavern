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
import { brandId, parseStoredAttachments, ensureActiveObjectiveTarget } from "@vibe-tavern/domain";
import type {
  Attachment,
  ChatBranchId,
  ChatId,
  Message,
  MessageId,
  SummaryMemorySnapshot,
} from "@vibe-tavern/domain";
import type { ChatStore, MessageStore, DiceRollStore, ExperienceStore, DbTransaction, Message as DbMessage, MessageVariant as DbMessageVariant } from "@vibe-tavern/db";
import { conflict, notFound } from "../../shared/errors.js";

/**
 * Apply the objective "exactly one active target" display invariant to a chat
 * before it leaves the service layer as part of a snapshot/activeChat. The
 * effective injected goal (first `active`, else first `pending`) is promoted to
 * `active` so the existing UI marks it as current; the DB keeps the stored
 * statuses (display-only / on-read — the invariant mirrors what
 * `selectActiveTask` injects into the prompt, applied here at the wire boundary).
 * See `ensureActiveObjectiveTarget` in @vibe-tavern/domain.
 */
function withActiveObjectiveTarget<T extends { insightsObjectiveState: Record<string, unknown> }>(chat: T): T {
  const raw = chat.insightsObjectiveState;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return chat;
  const obj = raw as Record<string, unknown>;
  const tasks = Array.isArray(obj.tasks) ? ensureActiveObjectiveTarget(obj.tasks as { status: string }[]) : undefined;
  const shortTermGoals = Array.isArray(obj.shortTermGoals) ? ensureActiveObjectiveTarget(obj.shortTermGoals as { status: string }[]) : undefined;
  if (tasks === undefined && shortTermGoals === undefined) return chat;
  return {
    ...chat,
    insightsObjectiveState: {
      ...obj,
      ...(tasks !== undefined && { tasks }),
      ...(shortTermGoals !== undefined && { shortTermGoals }),
    },
  };
}

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

type AddEditorVariantInput = {
  readonly content: string;
  readonly sourceVariantIds: readonly string[];
  readonly modelId?: string;
  /** Baked preset name (immutable text, no FK to a preset row) — sourced from
   *  the resolved pending prompt-trace draft by the chat-runtime wrapper. */
  readonly presetName?: string | null;
  readonly finishReason?: string;
};

export class ChatApplicationService {
  constructor(private readonly chatStore: ChatStore, private readonly messageStore: MessageStore, private readonly diceRollStore: DiceRollStore, private readonly experienceStore: ExperienceStore) {}

  async createChat(input: CreateChatRequest): Promise<CreateChatResponse> {
    const chat = await this.chatStore.createChat({
      characterId: input.characterId,
      personaId: input.personaId,
      title: input.title,
      promptPresetId: input.promptPresetId,
      mode: input.mode,
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
    const messages = await this.messageStore.getMessages(branch.id);

    return {
      chat: withActiveObjectiveTarget(chat),
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

    const baseData = {
      chatId,
      branchId: targetBranchId,
      role: "user" as const,
      authorType: "user" as const,
      content: input.content,
      attachmentsJson: input.attachments?.length ? JSON.stringify(input.attachments) : null,
    };

    // DICE-B10 / IR-51: when a send carries an optional Dice commit intent
    // and/or an experience attachment commit intent, the user-message insert and
    // ALL the binds run in ONE atomic transaction
    // (MessageStore.addMessageWithBind). Each bind verifies its own preconditions
    // FIRST and throws synchronously on stale/illegal state, so the whole turn
    // rolls back — no ghost message, no partial bind. Absent intents ⇒ the
    // unchanged addMessage path (no Dice/experience query, no bind).
    const bindHooks: Array<(tx: DbTransaction, messageId: string) => void> = [];
    if (input.diceCommit) {
      const { mode, pendingRevision } = input.diceCommit;
      bindHooks.push((tx, messageId) =>
        this.diceRollStore.bindActiveAndResetInTx(tx, chat.id, targetBranchId, mode, pendingRevision, messageId),
      );
    }
    if (input.experienceCommit) {
      const { attachmentId, queueRevision, sessionRevision } = input.experienceCommit;
      bindHooks.push((tx, messageId) =>
        this.experienceStore.verifyAndBindAttachmentInTx(tx, attachmentId, queueRevision, sessionRevision, messageId),
      );
    }
    if (bindHooks.length > 0) {
      const { message } = this.messageStore.addMessageWithBind(baseData, bindHooks);
      return mapDbMessage(message);
    }

    const message = await this.messageStore.addMessage(baseData);
    return mapDbMessage(message);
  }

  async updateAttachmentDescriptions(messageId: string, currentAttachments: Attachment[], descriptions: Array<{ attachmentId: string; description: string }>): Promise<void> {
    const descMap = new Map(descriptions.map(d => [d.attachmentId, d.description]));
    const updated = currentAttachments.map(att => {
      const desc = descMap.get(att.id);
      return desc !== undefined ? { ...att, description: desc } : att;
    });
    await this.messageStore.updateMessageAttachments(messageId, JSON.stringify(updated));
  }

  async updateSingleAttachmentDescription(messageId: string, attachmentIdOrAttachments: string | Attachment[], descriptionOrAttachmentId?: string, description?: string): Promise<void> {
    // Overload: (messageId, attachmentId, description) — reads from DB
    if (typeof attachmentIdOrAttachments === 'string') {
      const message = await this.messageStore.getMessageById(messageId);
      if (!message) return;
      const currentAttachments: Attachment[] = parseStoredAttachments(message.attachmentsJson) ?? [];
      await this.updateAttachmentDescriptions(messageId, currentAttachments, [{ attachmentId: attachmentIdOrAttachments, description: descriptionOrAttachmentId ?? '' }]);
      return;
    }
    // Overload: (messageId, currentAttachments, attachmentId, description)
    await this.updateAttachmentDescriptions(messageId, attachmentIdOrAttachments, [{ attachmentId: descriptionOrAttachmentId!, description: description! }]);
  }

  /**
   * Remove a single attachment from a message by its id. Persists the remaining
   * attachments (or null when none are left so the column stays empty) and
   * returns the removed attachment so the caller can clean up its stored asset
   * file. Idempotent: returns null if the message or the attachment id is not
   * found (so optimistic UI retries are safe and DELETE is idempotent).
   */
  async removeAttachment(messageId: string, attachmentId: string): Promise<Attachment | null> {
    const message = await this.messageStore.getMessageById(messageId);
    if (!message) return null;
    const current: Attachment[] = parseStoredAttachments(message.attachmentsJson) ?? [];
    const removed = current.find((a) => a.id === attachmentId) ?? null;
    if (!removed) return null;
    const remaining = current.filter((a) => a.id !== attachmentId);
    await this.messageStore.updateMessageAttachments(messageId, remaining.length > 0 ? JSON.stringify(remaining) : null);
    return removed;
  }

  async editMessage(messageId: string, content: string, expectedVariantId?: string): Promise<Message> {
    try {
      const message = await this.messageStore.editMessage(messageId, content, expectedVariantId);
      return mapDbMessage(message);
    } catch (error) {
      if (error instanceof Error && error.name === "SelectedVariantMismatchError") {
        throw conflict("The selected message variant changed before this edit could be applied.");
      }
      throw error;
    }
  }

  async addEditorVariant(messageId: string, input: AddEditorVariantInput): Promise<DbMessageVariant> {
    const variants = await this.messageStore.getVariants(messageId);
    const variantIds = new Set(variants.map((variant) => variant.id));
    const missingSourceVariantId = input.sourceVariantIds.find((variantId) => !variantIds.has(variantId));
    if (missingSourceVariantId) {
      throw notFound("Message variant", `Variant '${missingSourceVariantId}' was not found on message '${messageId}'.`);
    }

    return this.messageStore.addVariant(
      messageId,
      input.content,
      input.finishReason,
      undefined,
      undefined,
      input.modelId,
      input.presetName,
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    // DICE-B12: delete bound Dice rolls BEFORE the message row. The
    // bound_message_id FK is onDelete:set-null, so deleting the message first
    // would orphan the rolls (boundMessageId → null) and the roll delete would
    // find nothing. This is a compensating write, not transaction-reliant (per
    // the lifecycle contract) — the two deletes are independent operations.
    await this.diceRollStore.deleteRollsWithMessage(messageId);
    await this.messageStore.deleteMessage(messageId);
  }

  async createBranch(chatId: ChatId, input: CreateBranchRequest): Promise<CreateBranchResponse> {
    // DICE-B12 + IR-53: clone bound Dice rolls AND bound experience
    // attachments onto the new forked messages inside the fork transaction
    // (atomic + synchronous — both roll back with the fork). Only bindings on
    // copied messages (position <= fork point) move; later unsent state stays.
    const branch = await this.chatStore.forkBranch(
      chatId,
      input.forkedFromMessageId ?? "",
      input.label,
      (tx, msgIdMap) => this.diceRollStore.forkCopyRollsInTx(tx, msgIdMap),
      (tx, msgIdMap, newBranchId) => this.experienceStore.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );

    if (input.activateFork !== false) {
      await this.chatStore.activateBranch(chatId, branch.id as ChatBranchId);
    }

    // Count messages in the new branch for the response
    const messages = await this.messageStore.getMessages(branch.id);
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
