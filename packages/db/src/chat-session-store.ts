import type {
  AuthorType,
  Chat,
  ChatBranch,
  ChatBranchId,
  ChatId,
  Character,
  CharacterId,
  CharacterVersion,
  GenerationPresetId,
  GenerationPreset,
  LoreEntry,
  Lorebook,
  LorebookId,
  Message,
  MessageId,
  MessageVariant,
  MessageVariantId,
  MessageRole,
  Persona,
  PersonaId,
  PromptPreset,
  PromptPresetId,
  PromptTrace,
  SummaryKind,
  SummaryMemorySnapshot,
  ToolProfile,
  ToolProfileId,
} from "@rp-platform/domain";
import { resolveStoreRuntime, type StoreRuntimeOptions } from "./persistence.js";

export interface CreateChatSessionInput {
  characterId: CharacterId;
  personaId: PersonaId;
  title: string;
  generationPresetId: GenerationPresetId;
  toolProfileId: ToolProfileId;
  createdAt?: string;
}

export interface AppendChatMessageInput {
  chatId: ChatId;
  branchId: ChatBranchId;
  role: MessageRole;
  authorType: AuthorType;
  content: string;
  state?: Message["state"];
  createdAt?: string;
}

export interface ForkChatBranchInput {
  chatId: ChatId;
  sourceBranchId: ChatBranchId;
  forkedFromMessageId?: MessageId | null;
  label: string;
  activateFork?: boolean;
  createdAt?: string;
}

export interface RecordSummarySnapshotInput {
  chatId: ChatId;
  branchId: ChatBranchId;
  kind: SummaryKind;
  summary: string;
  coversThroughMessageId: MessageId;
  createdAt?: string;
}

export interface CreateMessageVariantInput {
  messageId: MessageId;
  content: string;
  finishReason?: string | null;
  createdAt?: string;
  isSelected?: boolean;
}

export interface CreatePromptTraceInput {
  chatId: ChatId;
  branchId: ChatBranchId;
  messageId: MessageId;
  model: string;
  presetName: string;
  assembledLayers: PromptTrace["assembledLayers"];
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: string[];
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
  latencyMs: number;
  createdAt?: string;
}

export interface ListPromptTracesInput {
  chatId: ChatId;
  branchId?: ChatBranchId;
  limit?: number;
}

export interface ChatBranchState {
  branch: ChatBranch;
  messages: Message[];
  summaries: SummaryMemorySnapshot[];
}

export interface CreateChatSessionResult {
  chat: Chat;
  rootBranch: ChatBranch;
}

export interface ForkChatBranchResult {
  branch: ChatBranch;
  copiedMessageCount: number;
}

export interface ChatSessionStore {
  upsertCharacter(input: Character): void;
  upsertCharacterVersion(input: CharacterVersion): void;
  upsertPersona(input: Persona): void;
  listPersonas(): Persona[];
  createPersona(input: { name: string; description: string; pronouns: string | null; defaultForNewChats: boolean }): Persona;
  deletePersona(personaId: PersonaId): void;
  countChatsForPersona(personaId: PersonaId): number;
  getPersonalLorebookForPersona(personaId: PersonaId): { lorebookId: LorebookId } | null;
  enablePersonalLorebookForPersona(personaId: PersonaId, name: string): { lorebookId: LorebookId };
  disablePersonalLorebookForPersona(personaId: PersonaId): void;
  updateChatPersona(chatId: ChatId, personaId: PersonaId): void;
  upsertGenerationPreset(input: GenerationPreset): void;
  upsertToolProfile(input: ToolProfile): void;
  upsertLorebook(input: Lorebook): void;
  replaceLoreEntries(lorebookId: string, entries: LoreEntry[]): void;
  createLoreEntry(lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry;
  updateLoreEntry(entryId: string, input: Partial<Omit<LoreEntry, "id" | "lorebookId">>): LoreEntry;
  deleteLoreEntry(entryId: string): void;
  linkCharacterLorebook(characterId: CharacterId, lorebookId: string): void;
  listCharacters(): Character[];
  getLatestCharacterVersion(characterId: CharacterId): CharacterVersion | null;
  listLoreEntriesForCharacter(characterId: CharacterId): LoreEntry[];
  createChat(input: CreateChatSessionInput): CreateChatSessionResult;
  listChats(): Chat[];
  getChat(chatId: ChatId): Chat | null;
  listBranches(chatId: ChatId): ChatBranch[];
  getBranchState(chatId: ChatId, branchId: ChatBranchId): ChatBranchState | null;
  appendMessage(input: AppendChatMessageInput): Message;
  updateMessage(messageId: MessageId, content: string): Message;
  createMessageVariant(input: CreateMessageVariantInput): MessageVariant;
  listMessageVariants(messageId: MessageId): MessageVariant[];
  selectMessageVariant(messageId: MessageId, variantIndex: number): Message;
  deleteMessage(messageId: MessageId): void;
  forkBranch(input: ForkChatBranchInput): ForkChatBranchResult;
  activateBranch(chatId: ChatId, branchId: ChatBranchId): Chat;
  recordSummarySnapshot(input: RecordSummarySnapshotInput): SummaryMemorySnapshot;
  sleepBranch(input: RecordSummarySnapshotInput): SummaryMemorySnapshot;
  createPromptTrace(input: CreatePromptTraceInput): PromptTrace;
  getLatestPromptTrace(chatId: ChatId, branchId?: ChatBranchId): PromptTrace | null;
  listPromptTraces(input: ListPromptTracesInput): PromptTrace[];

  setCharacterStatus(characterId: CharacterId, status: "active" | "archived"): void;
  deleteCharacter(characterId: CharacterId): void;
  deleteChat(chatId: ChatId): void;
  renameChat(chatId: ChatId, title: string): void;

  // Provider Profiles
  upsertProviderProfile(profile: any): void;
  listProviderProfiles(): any[];
  getProviderProfile(id: string): any | null;
  deleteProviderProfile(id: string): void;
  setActiveProviderProfile(id: string): void;
  getActiveProviderProfile(): any | null;

  listPromptPresets(): PromptPreset[];
  getPromptPreset(presetId: PromptPresetId): PromptPreset | null;
  createPromptPreset(input: { name: string; bindModel: string; system: string; jailbreak: string; summary: string; tools: string }): PromptPreset;
  updatePromptPreset(presetId: PromptPresetId, patch: { name?: string; bindModel?: string; system?: string; jailbreak?: string; summary?: string; tools?: string }): PromptPreset;
  deletePromptPreset(presetId: PromptPresetId): void;
}

interface StoredBranchState {
  branch: ChatBranch;
  messages: Message[];
  summaries: SummaryMemorySnapshot[];
}

export class InMemoryChatSessionStore implements ChatSessionStore {
  private readonly characters = new Map<CharacterId, Character>();
  private readonly characterVersions = new Map<string, CharacterVersion>();
  private readonly personas = new Map<PersonaId, Persona>();
  private readonly generationPresets = new Map<GenerationPresetId, GenerationPreset>();
  private readonly toolProfiles = new Map<ToolProfileId, ToolProfile>();
  private readonly lorebooks = new Map<string, Lorebook>();
  private readonly loreEntries = new Map<string, LoreEntry>();
  private readonly characterLorebooks = new Map<CharacterId, Set<string>>();
  private readonly personaLorebooks = new Map<PersonaId, Set<LorebookId>>();
  private readonly chats = new Map<ChatId, Chat>();
  private readonly branches = new Map<ChatBranchId, StoredBranchState>();
  private readonly branchIdsByChat = new Map<ChatId, ChatBranchId[]>();
  private readonly messageVariants = new Map<MessageVariantId, MessageVariant>();
  private readonly promptTraces = new Map<string, PromptTrace>();
  private readonly providerProfiles = new Map<string, any>();
  private readonly promptPresets = new Map<PromptPresetId, PromptPreset>();
  private readonly clock;
  private readonly idGenerator;

  constructor(runtimeOptions: StoreRuntimeOptions = {}) {
    const runtime = resolveStoreRuntime(runtimeOptions);
    this.clock = runtime.clock;
    this.idGenerator = runtime.idGenerator;
  }

  upsertCharacter(input: Character): void {
    this.characters.set(input.id, { ...input });
  }

  upsertCharacterVersion(input: CharacterVersion): void {
    this.characterVersions.set(input.id, {
      ...input,
      definition: cloneLooseRecord(input.definition),
    });
  }

  upsertPersona(input: Persona): void {
    this.personas.set(input.id, { ...input });
  }

  listPersonas(): Persona[] {
    return Array.from(this.personas.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p }));
  }

  createPersona(input: { name: string; description: string; pronouns: string | null; defaultForNewChats: boolean }): Persona {
    const timestamp = new Date().toISOString();
    const id = `persona_${Math.random().toString(36).slice(2, 10)}` as PersonaId;
    const persona: Persona = {
      id,
      name: input.name,
      description: input.description,
      pronouns: input.pronouns,
      avatarAssetId: null,
      defaultForNewChats: input.defaultForNewChats,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.personas.set(id, persona);
    return persona;
  }

  deletePersona(personaId: PersonaId): void {
    if (!this.personas.has(personaId)) {
      throw new Error(`Persona '${personaId}' was not found.`);
    }
    if (this.countChatsForPersona(personaId) > 0) {
      throw new Error(`Persona '${personaId}' is referenced by one or more chats and cannot be deleted.`);
    }
    this.personas.delete(personaId);
  }

  countChatsForPersona(personaId: PersonaId): number {
    let count = 0;
    for (const chat of this.chats.values()) {
      if (chat.personaId === personaId) count += 1;
    }
    return count;
  }

  updateChatPersona(chatId: ChatId, personaId: PersonaId): void {
    const chat = this.requireChat(chatId);
    if (!this.personas.has(personaId)) {
      throw new Error(`Persona '${personaId}' was not found.`);
    }
    chat.personaId = personaId;
    this.touchChat(chat);
  }

  getPersonalLorebookForPersona(personaId: PersonaId): { lorebookId: LorebookId } | null {
    const links = this.personaLorebooks.get(personaId);
    if (!links) return null;
    for (const lorebookId of links) {
      const lorebook = this.lorebooks.get(lorebookId);
      if (lorebook && lorebook.scopeType === "persona" && lorebook.name === `__personal__:${personaId}`) {
        return { lorebookId };
      }
    }
    return null;
  }

  enablePersonalLorebookForPersona(personaId: PersonaId, name: string): { lorebookId: LorebookId } {
    if (!this.personas.has(personaId)) {
      throw new Error(`Persona '${personaId}' was not found.`);
    }
    const existing = this.getPersonalLorebookForPersona(personaId);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const lorebookId = `lorebook_${Math.random().toString(36).slice(2, 10)}` as LorebookId;
    this.lorebooks.set(lorebookId, {
      id: lorebookId,
      name,
      scopeType: "persona",
      description: "Personal lorebook auto-created for persona.",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (!this.personaLorebooks.has(personaId)) {
      this.personaLorebooks.set(personaId, new Set());
    }
    this.personaLorebooks.get(personaId)!.add(lorebookId);
    return { lorebookId };
  }

  disablePersonalLorebookForPersona(personaId: PersonaId): void {
    const existing = this.getPersonalLorebookForPersona(personaId);
    if (!existing) return;
    this.personaLorebooks.get(personaId)?.delete(existing.lorebookId);
    this.lorebooks.delete(existing.lorebookId);
  }

  upsertGenerationPreset(input: GenerationPreset): void {
    this.generationPresets.set(input.id, {
      ...input,
      metadata: cloneLooseRecord(input.metadata),
    });
  }

  upsertToolProfile(input: ToolProfile): void {
    this.toolProfiles.set(input.id, {
      ...input,
      metadata: cloneLooseRecord(input.metadata),
    });
  }

  upsertLorebook(input: Lorebook): void {
    this.lorebooks.set(input.id, { ...input });
  }

  replaceLoreEntries(lorebookId: string, entries: LoreEntry[]): void {
    for (const [entryId, entry] of this.loreEntries.entries()) {
      if (entry.lorebookId === lorebookId) {
        this.loreEntries.delete(entryId);
      }
    }

    for (const entry of entries) {
      this.loreEntries.set(entry.id, {
        ...entry,
        keys: [...entry.keys],
        secondaryKeys: [...entry.secondaryKeys],
        metadata: cloneLooseRecord(entry.metadata),
      });
    }
  }

  createLoreEntry(lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry {
    const entry: LoreEntry = {
      ...input,
      id: this.nextId("lore_entry"),
      lorebookId,
      keys: [...input.keys],
      secondaryKeys: [...input.secondaryKeys],
      metadata: cloneLooseRecord(input.metadata),
    };

    this.loreEntries.set(entry.id, entry);
    return cloneLoreEntry(entry);
  }

  updateLoreEntry(entryId: string, input: Partial<Omit<LoreEntry, "id" | "lorebookId">>): LoreEntry {
    const current = this.loreEntries.get(entryId);
    if (!current) {
      throw new Error(`Lore entry '${entryId}' was not found.`);
    }

    const updated: LoreEntry = {
      ...current,
      ...input,
      keys: input.keys ? [...input.keys] : [...current.keys],
      secondaryKeys: input.secondaryKeys ? [...input.secondaryKeys] : [...current.secondaryKeys],
      metadata: input.metadata ? cloneLooseRecord(input.metadata) : cloneLooseRecord(current.metadata),
    };

    this.loreEntries.set(entryId, updated);
    return cloneLoreEntry(updated);
  }

  deleteLoreEntry(entryId: string): void {
    this.loreEntries.delete(entryId);
  }

  linkCharacterLorebook(characterId: CharacterId, lorebookId: string): void {
    const linked = this.characterLorebooks.get(characterId) ?? new Set<string>();
    linked.add(lorebookId);
    this.characterLorebooks.set(characterId, linked);
  }

  listCharacters(): Character[] {
    return Array.from(this.characters.values())
      .sort((left, right) => compareTimestampsAsc(left.createdAt, right.createdAt, left.id, right.id))
      .map((character) => ({ ...character }));
  }

  getLatestCharacterVersion(characterId: CharacterId): CharacterVersion | null {
    const versions = Array.from(this.characterVersions.values())
      .filter((version) => version.characterId === characterId)
      .sort((left, right) => {
        if (left.isActive !== right.isActive) {
          return left.isActive ? -1 : 1;
        }
        if (left.versionNumber !== right.versionNumber) {
          return right.versionNumber - left.versionNumber;
        }
        return compareTimestampsDesc(left.createdAt, right.createdAt, left.id, right.id);
      });

    const version = versions[0];
    return version
      ? {
          ...version,
          definition: cloneLooseRecord(version.definition),
        }
      : null;
  }

  listLoreEntriesForCharacter(characterId: CharacterId): LoreEntry[] {
    const linkedLorebooks = this.characterLorebooks.get(characterId);
    if (!linkedLorebooks || linkedLorebooks.size === 0) {
      return [];
    }

    return Array.from(this.loreEntries.values())
      .filter((entry) => linkedLorebooks.has(entry.lorebookId))
      .map((entry) => ({
        ...entry,
        keys: [...entry.keys],
        secondaryKeys: [...entry.secondaryKeys],
        metadata: cloneLooseRecord(entry.metadata),
      }));
  }

  createChat(input: CreateChatSessionInput): CreateChatSessionResult {
    if (!this.characters.has(input.characterId)) {
      throw new Error(`Character '${input.characterId}' is missing.`);
    }
    if (!this.personas.has(input.personaId)) {
      throw new Error(`Persona '${input.personaId}' is missing.`);
    }
    if (!this.generationPresets.has(input.generationPresetId)) {
      throw new Error(`Generation preset '${input.generationPresetId}' is missing.`);
    }
    if (!this.toolProfiles.has(input.toolProfileId)) {
      throw new Error(`Tool profile '${input.toolProfileId}' is missing.`);
    }

    const timestamp = input.createdAt ?? this.nowTimestamp();
    const rootBranchId = this.nextId("branch") as ChatBranchId;
    const chatId = this.nextId("chat") as ChatId;

    const chat: Chat = {
      id: chatId,
      characterId: input.characterId,
      personaId: input.personaId,
      title: input.title,
      status: "active",
      activeBranchId: rootBranchId,
      generationPresetId: input.generationPresetId,
      toolProfileId: input.toolProfileId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const rootBranch: ChatBranch = {
      id: rootBranchId,
      chatId,
      parentBranchId: null,
      forkedFromMessageId: null,
      label: "main",
      createdAt: timestamp,
    };

    this.chats.set(chatId, chat);
    this.branches.set(rootBranchId, {
      branch: rootBranch,
      messages: [],
      summaries: [],
    });
    this.branchIdsByChat.set(chatId, [rootBranchId]);

    return {
      chat: cloneChat(chat),
      rootBranch: cloneBranch(rootBranch),
    };
  }

  listChats(): Chat[] {
    return Array.from(this.chats.values())
      .sort((left, right) => compareTimestampsAsc(left.createdAt, right.createdAt, left.id, right.id))
      .map(cloneChat);
  }

  getChat(chatId: ChatId): Chat | null {
    const chat = this.chats.get(chatId);
    return chat ? cloneChat(chat) : null;
  }

  listBranches(chatId: ChatId): ChatBranch[] {
    this.requireChat(chatId);
    const branchIds = this.branchIdsByChat.get(chatId) ?? [];
    return branchIds
      .map((branchId) => this.branches.get(branchId))
      .filter((state): state is StoredBranchState => Boolean(state))
      .map((state) => cloneBranch(state.branch));
  }

  getBranchState(chatId: ChatId, branchId: ChatBranchId): ChatBranchState | null {
    const state = this.getStoredBranchState(chatId, branchId);
    if (!state) {
      return null;
    }

    return cloneBranchState(state);
  }

  appendMessage(input: AppendChatMessageInput): Message {
    const chat = this.requireChat(input.chatId);
    const state = this.requireBranch(input.chatId, input.branchId);
    const timestamp = input.createdAt ?? this.nowTimestamp();

    const message: Message = {
      id: this.nextId("msg") as MessageId,
      chatId: input.chatId,
      branchId: input.branchId,
      role: input.role,
      authorType: input.authorType,
      position: state.messages.length,
      content: input.content,
      state: input.state ?? "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.messages.push(message);
    if (message.role === "assistant") {
      this.messageVariants.set(this.nextId("variant") as MessageVariantId, {
        id: this.nextId("variant") as MessageVariantId,
        messageId: message.id,
        variantIndex: 0,
        content: message.content,
        isSelected: true,
        finishReason: null,
        createdAt: timestamp,
      });
    }
    this.touchChat(chat, timestamp);
    return cloneMessage(message);
  }

  updateMessage(messageId: MessageId, content: string): Message {
    for (const state of this.branches.values()) {
      const message = state.messages.find((m) => m.id === messageId);
      if (message) {
        message.content = content;
        message.updatedAt = this.nowTimestamp();
        if (message.role === "assistant") {
          this.ensureDefaultAssistantVariant(message);
          const selectedVariant = Array.from(this.messageVariants.values()).find(
            (variant) => variant.messageId === messageId && variant.isSelected,
          );
          if (selectedVariant) {
            selectedVariant.content = content;
          }
        }
        this.touchChat(this.requireChat(message.chatId));
        return cloneMessage(message);
      }
    }
    throw new Error(`Message '${messageId}' was not found.`);
  }

  createMessageVariant(input: CreateMessageVariantInput): MessageVariant {
    const message = this.findMessage(input.messageId);
    if (!message) {
      throw new Error(`Message '${input.messageId}' was not found.`);
    }
    if (message.role !== "assistant") {
      throw new Error(`Message '${input.messageId}' does not support variants.`);
    }

    this.ensureDefaultAssistantVariant(message);
    const timestamp = input.createdAt ?? this.nowTimestamp();
    const existingVariants = this.listMessageVariants(message.id);
    const variant: MessageVariant = {
      id: this.nextId("variant") as MessageVariantId,
      messageId: message.id,
      variantIndex: existingVariants.length,
      content: input.content,
      isSelected: input.isSelected ?? true,
      finishReason: input.finishReason ?? null,
      createdAt: timestamp,
    };

    if (variant.isSelected) {
      for (const existing of this.messageVariants.values()) {
        if (existing.messageId === message.id) {
          existing.isSelected = false;
        }
      }
      message.content = variant.content;
      message.updatedAt = timestamp;
    }

    this.messageVariants.set(variant.id, variant);
    this.touchChat(this.requireChat(message.chatId), timestamp);
    return cloneMessageVariant(variant);
  }

  listMessageVariants(messageId: MessageId): MessageVariant[] {
    const message = this.findMessage(messageId);
    if (!message) {
      throw new Error(`Message '${messageId}' was not found.`);
    }
    this.ensureDefaultAssistantVariant(message);
    return Array.from(this.messageVariants.values())
      .filter((variant) => variant.messageId === messageId)
      .sort((left, right) => left.variantIndex - right.variantIndex)
      .map(cloneMessageVariant);
  }

  selectMessageVariant(messageId: MessageId, variantIndex: number): Message {
    const message = this.findMessage(messageId);
    if (!message) {
      throw new Error(`Message '${messageId}' was not found.`);
    }
    this.ensureDefaultAssistantVariant(message);
    const variants = this.listMessageVariants(messageId);
    const nextVariant = variants.find((variant) => variant.variantIndex === variantIndex);
    if (!nextVariant) {
      throw new Error(`Variant '${variantIndex}' was not found for message '${messageId}'.`);
    }

    for (const variant of this.messageVariants.values()) {
      if (variant.messageId === messageId) {
        variant.isSelected = variant.variantIndex === variantIndex;
      }
    }

    message.content = nextVariant.content;
    message.updatedAt = this.nowTimestamp();
    this.touchChat(this.requireChat(message.chatId), message.updatedAt);
    return cloneMessage(message);
  }

  deleteMessage(messageId: MessageId): void {
    for (const state of this.branches.values()) {
      const index = state.messages.findIndex((m) => m.id === messageId);
      if (index !== -1) {
        const message = state.messages[index]!;
        state.messages.splice(index, 1);
        for (const [variantId, variant] of this.messageVariants.entries()) {
          if (variant.messageId === messageId) {
            this.messageVariants.delete(variantId);
          }
        }
        // Re-calculate positions for subsequent messages in this branch
        for (let i = index; i < state.messages.length; i++) {
          state.messages[i]!.position = i;
        }
        this.touchChat(this.requireChat(message.chatId));
        return;
      }
    }
  }

  forkBranch(input: ForkChatBranchInput): ForkChatBranchResult {
    const chat = this.requireChat(input.chatId);
    const sourceState = this.requireBranch(input.chatId, input.sourceBranchId);
    const timestamp = input.createdAt ?? this.nowTimestamp();
    const branchId = this.nextId("branch") as ChatBranchId;

    const forkIndex = resolveForkIndex(
      sourceState.messages,
      input.forkedFromMessageId ?? null,
    );
    const copiedSourceMessages = sourceState.messages.slice(0, forkIndex + 1);
    const copiedMessageIds = new Map<MessageId, MessageId>();
    const copiedMessages = copiedSourceMessages.map((message, index) => ({
      ...message,
      id: (() => {
        const nextId = this.nextId("msg") as MessageId;
        copiedMessageIds.set(message.id, nextId);
        return nextId;
      })(),
      branchId,
      position: index,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const copiedSummaries = sourceState.summaries.filter((summary) =>
      copiedSourceMessages.some(
        (message) => message.id === summary.coversThroughMessageId,
      ),
    );

    copiedSourceMessages.forEach((message) => {
      const nextMessageId = copiedMessageIds.get(message.id);
      if (!nextMessageId) {
        return;
      }
      const copiedVariants = this.listMessageVariants(message.id);
      for (const variant of copiedVariants) {
        const variantId = this.nextId("variant") as MessageVariantId;
        this.messageVariants.set(variantId, {
          ...variant,
          id: variantId,
          messageId: nextMessageId,
          createdAt: timestamp,
        });
      }
    });

    const branch: ChatBranch = {
      id: branchId,
      chatId: input.chatId,
      parentBranchId: input.sourceBranchId,
      forkedFromMessageId:
        copiedSourceMessages.length > 0
          ? copiedSourceMessages[copiedSourceMessages.length - 1]?.id ?? null
          : null,
      label: input.label,
      createdAt: timestamp,
    };

    this.branches.set(branchId, {
      branch,
      messages: copiedMessages,
      summaries: copiedSummaries.map((summary) => {
        const remappedMessageId = copiedMessageIds.get(summary.coversThroughMessageId);
        if (!remappedMessageId) {
          throw new Error(
            `Cannot remap summary '${summary.id}' while forking branch '${input.sourceBranchId}'.`,
          );
        }

        return {
          ...summary,
          id: this.nextId("summary") as SummaryMemorySnapshot["id"],
          branchId,
          coversThroughMessageId: remappedMessageId,
          createdAt: timestamp,
        };
      }),
    });
    this.branchIdsByChat.set(input.chatId, [
      ...(this.branchIdsByChat.get(input.chatId) ?? []),
      branchId,
    ]);

    if (input.activateFork ?? true) {
      chat.activeBranchId = branchId;
    }
    this.touchChat(chat, timestamp);

    return {
      branch: cloneBranch(branch),
      copiedMessageCount: copiedMessages.length,
    };
  }

  activateBranch(chatId: ChatId, branchId: ChatBranchId): Chat {
    const chat = this.requireChat(chatId);
    this.requireBranch(chatId, branchId);
    chat.activeBranchId = branchId;
    this.touchChat(chat);
    return cloneChat(chat);
  }

  recordSummarySnapshot(
    input: RecordSummarySnapshotInput,
  ): SummaryMemorySnapshot {
    const chat = this.requireChat(input.chatId);
    const state = this.requireBranch(input.chatId, input.branchId);
    const timestamp = input.createdAt ?? this.nowTimestamp();

    if (!state.messages.some((message) => message.id === input.coversThroughMessageId)) {
      throw new Error(
        `Cannot record summary for missing message '${input.coversThroughMessageId}' in branch '${input.branchId}'.`,
      );
    }

    const snapshot: SummaryMemorySnapshot = {
      id: this.nextId("summary") as SummaryMemorySnapshot["id"],
      chatId: input.chatId,
      branchId: input.branchId,
      kind: input.kind,
      summary: input.summary,
      coversThroughMessageId: input.coversThroughMessageId,
      createdAt: timestamp,
    };

    state.summaries.push(snapshot);
    this.touchChat(chat, timestamp);
    return cloneSummary(snapshot);
  }

  sleepBranch(input: RecordSummarySnapshotInput): SummaryMemorySnapshot {
    return this.recordSummarySnapshot(input);
  }

  createPromptTrace(input: CreatePromptTraceInput): PromptTrace {
    const chat = this.requireChat(input.chatId);
    const state = this.requireBranch(input.chatId, input.branchId);
    const timestamp = input.createdAt ?? this.nowTimestamp();

    if (!state.messages.some((message) => message.id === input.messageId)) {
      throw new Error(
        `Cannot record prompt trace for missing message '${input.messageId}' in branch '${input.branchId}'.`,
      );
    }

    const trace: PromptTrace = {
      id: this.nextId("trace"),
      chatId: input.chatId,
      branchId: input.branchId,
      messageId: input.messageId,
      model: input.model,
      presetName: input.presetName,
      assembledLayers: input.assembledLayers.map(clonePromptLayer),
      tokenAccounting: { ...input.tokenAccounting },
      activatedLoreEntries: [...input.activatedLoreEntries],
      retrievedMemories: input.retrievedMemories.map(cloneLooseRecord),
      finalPayload: cloneLooseRecord(input.finalPayload),
      latencyMs: input.latencyMs,
      createdAt: timestamp,
    };

    this.promptTraces.set(trace.id, trace);
    this.touchChat(chat, timestamp);
    return clonePromptTrace(trace);
  }

  getLatestPromptTrace(chatId: ChatId, branchId?: ChatBranchId): PromptTrace | null {
    return this.listPromptTraces({
      chatId,
      branchId,
      limit: 1,
    })[0] ?? null;
  }

  listPromptTraces(input: ListPromptTracesInput): PromptTrace[] {
    this.requireChat(input.chatId);
    if (input.branchId) {
      this.requireBranch(input.chatId, input.branchId);
    }

    const traces = Array.from(this.promptTraces.values())
      .filter(
        (trace) =>
          trace.chatId === input.chatId &&
          (input.branchId ? trace.branchId === input.branchId : true),
      )
      .sort((left, right) => compareTimestampsDesc(left.createdAt, right.createdAt, left.id, right.id));

    return traces.slice(0, input.limit ?? traces.length).map(clonePromptTrace);
  }

  upsertProviderProfile(profile: any): void {
    const id = profile.id || (this.nextId("provider") as string);
    const existing = this.providerProfiles.get(id);
    const isActive = profile.isActive !== undefined ? profile.isActive : existing?.isActive ?? false;
    this.providerProfiles.set(id, { ...existing, ...profile, id, isActive });
  }

  setCharacterStatus(characterId: CharacterId, status: "active" | "archived"): void {
    const character = this.characters.get(characterId);
    if (character) {
      character.status = status;
      character.updatedAt = this.nowTimestamp();
    }
  }

  deleteCharacter(characterId: CharacterId): void {
    const chatIdsToDelete: ChatId[] = [];
    for (const [chatId, chat] of this.chats.entries()) {
      if (chat.characterId === characterId) {
        chatIdsToDelete.push(chatId);
      }
    }
    for (const chatId of chatIdsToDelete) {
      const branchIds = this.branchIdsByChat.get(chatId) ?? [];
      for (const branchId of branchIds) {
        const state = this.branches.get(branchId);
        if (state) {
          for (const message of state.messages) {
            for (const [variantId, variant] of this.messageVariants.entries()) {
              if (variant.messageId === message.id) {
                this.messageVariants.delete(variantId);
              }
            }
          }
          this.branches.delete(branchId);
        }
      }
      this.branchIdsByChat.delete(chatId);
      this.chats.delete(chatId);
    }
    for (const [traceId, trace] of this.promptTraces.entries()) {
      if (trace.chatId === characterId || chatIdsToDelete.includes(trace.chatId)) {
        this.promptTraces.delete(traceId);
      }
    }
    this.characterVersions.delete(characterId);
    this.characters.delete(characterId);
  }

  deleteChat(chatId: ChatId): void {
    const branchIds = this.branchIdsByChat.get(chatId) ?? [];
    for (const branchId of branchIds) {
      const state = this.branches.get(branchId);
      if (state) {
        for (const message of state.messages) {
          for (const [variantId, variant] of this.messageVariants.entries()) {
            if (variant.messageId === message.id) {
              this.messageVariants.delete(variantId);
            }
          }
        }
        this.branches.delete(branchId);
      }
    }
    this.branchIdsByChat.delete(chatId);
    for (const [traceId, trace] of this.promptTraces.entries()) {
      if (trace.chatId === chatId) {
        this.promptTraces.delete(traceId);
      }
    }
    this.chats.delete(chatId);
  }

  renameChat(chatId: ChatId, title: string): void {
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.title = title;
      chat.updatedAt = this.nowTimestamp();
    }
  }

  listProviderProfiles(): any[] {
    return Array.from(this.providerProfiles.values());
  }

  getProviderProfile(id: string): any | null {
    const profile = this.providerProfiles.get(id);
    return profile ? { ...profile } : null;
  }

  deleteProviderProfile(id: string): void {
    this.providerProfiles.delete(id);
  }

  setActiveProviderProfile(id: string): void {
    if (!this.providerProfiles.has(id)) {
      throw new Error(`Provider profile '${id}' was not found.`);
    }
    for (const [key, profile] of this.providerProfiles) {
      this.providerProfiles.set(key, { ...profile, isActive: key === id });
    }
  }

  getActiveProviderProfile(): any | null {
    for (const profile of this.providerProfiles.values()) {
      if (profile.isActive) {
        return { ...profile };
      }
    }
    return null;
  }

  listPromptPresets(): PromptPreset[] {
    return [...this.promptPresets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getPromptPreset(presetId: PromptPresetId): PromptPreset | null {
    return this.promptPresets.get(presetId) ?? null;
  }

  createPromptPreset(input: { name: string; bindModel: string; system: string; jailbreak: string; summary: string; tools: string }): PromptPreset {
    const timestamp = this.nowTimestamp();
    const id = this.nextId("prompt_preset") as PromptPresetId;
    const preset: PromptPreset = { id, ...input, createdAt: timestamp, updatedAt: timestamp };
    this.promptPresets.set(id, preset);
    return preset;
  }

  updatePromptPreset(presetId: PromptPresetId, patch: Partial<Omit<PromptPreset, "id" | "createdAt" | "updatedAt">>): PromptPreset {
    const current = this.promptPresets.get(presetId);
    if (!current) {
      throw new Error(`Prompt preset '${presetId}' was not found.`);
    }
    const next: PromptPreset = { ...current, ...patch, updatedAt: this.nowTimestamp() };
    this.promptPresets.set(presetId, next);
    return next;
  }

  deletePromptPreset(presetId: PromptPresetId): void {
    if (!this.promptPresets.has(presetId)) {
      throw new Error(`Prompt preset '${presetId}' was not found.`);
    }
    this.promptPresets.delete(presetId);
  }

  private getStoredBranchState(
    chatId: ChatId,
    branchId: ChatBranchId,
  ): StoredBranchState | null {
    const state = this.branches.get(branchId);
    if (!state || state.branch.chatId !== chatId) {
      return null;
    }
    return state;
  }

  private requireChat(chatId: ChatId): Chat {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new Error(`Chat '${chatId}' was not found.`);
    }
    return chat;
  }

  private requireBranch(chatId: ChatId, branchId: ChatBranchId): StoredBranchState {
    const state = this.getStoredBranchState(chatId, branchId);
    if (!state) {
      throw new Error(
        `Branch '${branchId}' was not found for chat '${chatId}'.`,
      );
    }
    return state;
  }

  private nextId(prefix: string): string {
    return this.idGenerator.next(prefix);
  }

  private touchChat(chat: Chat, timestamp: string = this.nowTimestamp()): void {
    chat.updatedAt = timestamp;
  }

  private nowTimestamp(): string {
    return this.clock.now();
  }

  private findMessage(messageId: MessageId): Message | null {
    for (const state of this.branches.values()) {
      const message = state.messages.find((entry) => entry.id === messageId);
      if (message) {
        return message;
      }
    }
    return null;
  }

  private ensureDefaultAssistantVariant(message: Message): void {
    if (message.role !== "assistant") {
      return;
    }
    const exists = Array.from(this.messageVariants.values()).some(
      (variant) => variant.messageId === message.id,
    );
    if (exists) {
      return;
    }
    const variantId = this.nextId("variant") as MessageVariantId;
    this.messageVariants.set(variantId, {
      id: variantId,
      messageId: message.id,
      variantIndex: 0,
      content: message.content,
      isSelected: true,
      finishReason: null,
      createdAt: message.createdAt,
    });
  }
}

function resolveForkIndex(
  messages: Message[],
  forkedFromMessageId: MessageId | null,
): number {
  if (messages.length === 0) {
    return -1;
  }

  if (forkedFromMessageId === null) {
    return messages.length - 1;
  }

  const index = messages.findIndex((message) => message.id === forkedFromMessageId);
  if (index === -1) {
    throw new Error(
      `Cannot fork from missing message '${forkedFromMessageId}'.`,
    );
  }

  return index;
}

function cloneChat(chat: Chat): Chat {
  return { ...chat };
}

function cloneBranch(branch: ChatBranch): ChatBranch {
  return { ...branch };
}

function cloneMessage(message: Message): Message {
  return { ...message };
}

function cloneMessageVariant(variant: MessageVariant): MessageVariant {
  return { ...variant };
}

function cloneLoreEntry(entry: LoreEntry): LoreEntry {
  return {
    ...entry,
    keys: [...entry.keys],
    secondaryKeys: [...entry.secondaryKeys],
    metadata: cloneLooseRecord(entry.metadata),
  };
}

function cloneSummary(snapshot: SummaryMemorySnapshot): SummaryMemorySnapshot {
  return { ...snapshot };
}

function cloneBranchState(state: StoredBranchState): ChatBranchState {
  return {
    branch: cloneBranch(state.branch),
    messages: state.messages.map(cloneMessage),
    summaries: state.summaries.map(cloneSummary),
  };
}

function clonePromptTrace(trace: PromptTrace): PromptTrace {
  return {
    ...trace,
    assembledLayers: trace.assembledLayers.map(clonePromptLayer),
    tokenAccounting: { ...trace.tokenAccounting },
    activatedLoreEntries: [...trace.activatedLoreEntries],
    retrievedMemories: trace.retrievedMemories.map(cloneLooseRecord),
    finalPayload: cloneLooseRecord(trace.finalPayload),
  };
}

function clonePromptLayer(
  layer: PromptTrace["assembledLayers"][number],
): PromptTrace["assembledLayers"][number] {
  return {
    ...layer,
  };
}

function cloneLooseRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareTimestampsAsc(
  leftTimestamp: string,
  rightTimestamp: string,
  leftId: string,
  rightId: string,
): number {
  if (leftTimestamp === rightTimestamp) {
    return leftId.localeCompare(rightId);
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

function compareTimestampsDesc(
  leftTimestamp: string,
  rightTimestamp: string,
  leftId: string,
  rightId: string,
): number {
  return compareTimestampsAsc(rightTimestamp, leftTimestamp, rightId, leftId);
}
