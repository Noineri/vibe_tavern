import type { Chat, ChatBranch, ChatBranchId, ChatId, LorebookId, Message, MessageId, MessageVariant, Persona, PersonaId, PromptPreset, PromptPresetId, PromptTrace, PromptTraceId, SummaryMemorySnapshot, ToolProfile, ToolProfileId } from "@rp-platform/domain";

import type { AppendChatMessageInput, ChatBranchState, ChatSessionStore, CreateMessageVariantInput, CreatePromptTraceInput, CreateChatSessionInput, CreateChatSessionResult, ForkChatBranchInput, ForkChatBranchResult, ListPromptTracesInput, RecordSummarySnapshotInput } from "./chat-session-store.js";
import { resolveStoreRuntime, type StoreRuntimeOptions } from "./persistence.js";
import { SqliteChatStore } from "./sqlite-chat-store.js";
import { SqliteCharacterStore } from "./sqlite-character-store.js";
import { SqlitePersonaStore } from "./sqlite-persona-store.js";
import { SqliteProviderStore } from "./sqlite-provider-store.js";
import type { SqliteDatabaseAdapter } from "./sqlite-adapter.js";

type GenerationPresetId = string;
type GenerationPreset = {
  id: GenerationPresetId;
  name: string;
  providerType: string;
  settings: Record<string, unknown>;
};

export class SqliteChatSessionStore implements ChatSessionStore {
  private readonly clock;
  private readonly idGenerator;
  private readonly chat: SqliteChatStore;
  private readonly characters: SqliteCharacterStore;
  private readonly personas: SqlitePersonaStore;
  private readonly providers: SqliteProviderStore;

  constructor(
    private readonly db: SqliteDatabaseAdapter,
    runtimeOptions: StoreRuntimeOptions = {},
  ) {
    const runtime = resolveStoreRuntime(runtimeOptions);
    this.clock = runtime.clock;
    this.idGenerator = runtime.idGenerator;
    this.chat = new SqliteChatStore(db, this.clock, this.idGenerator);
    this.characters = new SqliteCharacterStore(db, this.clock, this.idGenerator);
    this.personas = new SqlitePersonaStore(db, this.clock, this.idGenerator);
    this.providers = new SqliteProviderStore(db, this.clock, this.idGenerator);
  }

  upsertCharacter(input: Parameters<ChatSessionStore["upsertCharacter"]>[0]): void { this.characters.upsertCharacter(input); }

  upsertCharacterVersion(input: Parameters<ChatSessionStore["upsertCharacterVersion"]>[0]): void { this.characters.upsertCharacterVersion(input); }

  upsertPersona(input: Persona): void { this.personas.upsertPersona(input); }

  getPersona(personaId: PersonaId): Persona | null { return this.personas.getPersona(personaId); }

  listPersonas(): Persona[] { return this.personas.listPersonas(); }

  createPersona(input: { name: string; description: string; pronouns: string | null; defaultForNewChats: boolean }): Persona { return this.personas.createPersona(input); }

  deletePersona(personaId: PersonaId): void { this.personas.deletePersona(personaId); }

  countChatsForPersona(personaId: PersonaId): number { return this.personas.countChatsForPersona(personaId); }

  updateChatPersona(chatId: ChatId, personaId: PersonaId): void { this.chat.updateChatPersona(chatId, personaId); }

  createChat(input: CreateChatSessionInput): CreateChatSessionResult { return this.chat.createChat(input); }

  listChats(): Chat[] { return this.chat.listChats(); }

  getChat(chatId: ChatId): Chat | null { return this.chat.getChat(chatId); }

  listBranches(chatId: ChatId): ChatBranch[] { return this.chat.listBranches(chatId); }

  getBranchState(chatId: ChatId, branchId: ChatBranchId): ChatBranchState | null { return this.chat.getBranchState(chatId, branchId); }

  appendMessage(input: AppendChatMessageInput): Message { return this.chat.appendMessage(input); }

  updateMessage(messageId: MessageId, content: string): Message { return this.chat.updateMessage(messageId, content); }

  createMessageVariant(input: CreateMessageVariantInput): MessageVariant { return this.chat.createMessageVariant(input); }

  listMessageVariants(messageId: MessageId): MessageVariant[] { return this.chat.listMessageVariants(messageId); }

  selectMessageVariant(messageId: MessageId, variantIndex: number): Message { return this.chat.selectMessageVariant(messageId, variantIndex); }

  deleteMessage(messageId: MessageId): void { this.chat.deleteMessage(messageId); }

  forkBranch(input: ForkChatBranchInput): ForkChatBranchResult { return this.chat.forkBranch(input); }

  activateBranch(chatId: ChatId, branchId: ChatBranchId): Chat { return this.chat.activateBranch(chatId, branchId); }

  recordSummarySnapshot(input: RecordSummarySnapshotInput): SummaryMemorySnapshot { return this.chat.recordSummarySnapshot(input); }

  sleepBranch(input: RecordSummarySnapshotInput): SummaryMemorySnapshot { return this.chat.sleepBranch(input); }

  createPromptTrace(input: CreatePromptTraceInput): PromptTrace { return this.chat.createPromptTrace(input); }

  getLatestPromptTrace(chatId: ChatId, branchId?: ChatBranchId): PromptTrace | null { return this.chat.getLatestPromptTrace(chatId, branchId); }

  listPromptTraces(input: ListPromptTracesInput): PromptTrace[] { return this.chat.listPromptTraces(input); }

  updateChatPromptPreset(chatId: ChatId, promptPresetId: PromptPresetId): void {
    this.db.transaction(() => {
      const chatExists = this.db.queryOne(`SELECT 1 FROM chats WHERE id = ?`, [chatId]);
      if (!chatExists) {
        throw new Error(`Chat '${chatId}' was not found.`);
      }
      const presetExists = this.db.queryOne(`SELECT 1 FROM prompt_presets WHERE id = ?`, [promptPresetId]);
      if (!presetExists) {
        throw new Error(`Prompt preset '${promptPresetId}' was not found.`);
      }
      this.db.execute(`UPDATE chats SET prompt_preset_id = ?, updated_at = ? WHERE id = ?`, [
        promptPresetId,
        this.clock.now(),
        chatId,
      ]);
    });
  }

  getPersonalLorebookForPersona(personaId: PersonaId): { lorebookId: LorebookId } | null { return this.personas.getPersonalLorebookForPersona(personaId); }

  enablePersonalLorebookForPersona(personaId: PersonaId, name: string): { lorebookId: LorebookId } { return this.personas.enablePersonalLorebookForPersona(personaId, name); }

  disablePersonalLorebookForPersona(personaId: PersonaId): void { this.personas.disablePersonalLorebookForPersona(personaId); }

  upsertGenerationPreset(input: GenerationPreset): void { this.providers.upsertGenerationPreset(input); }

  getGenerationPreset(id: GenerationPresetId): GenerationPreset | null { return this.providers.getGenerationPreset(id); }

  upsertToolProfile(input: ToolProfile): void { this.providers.upsertToolProfile(input); }

  getToolProfile(id: ToolProfileId): ToolProfile | null { return this.providers.getToolProfile(id); }

  upsertLorebook(input: Parameters<ChatSessionStore["upsertLorebook"]>[0]): void { this.characters.upsertLorebook(input); }

  replaceLoreEntries(lorebookId: Parameters<ChatSessionStore["replaceLoreEntries"]>[0], entries: Parameters<ChatSessionStore["replaceLoreEntries"]>[1]): void { this.characters.replaceLoreEntries(lorebookId, entries); }

  createLoreEntry(lorebookId: Parameters<ChatSessionStore["createLoreEntry"]>[0], input: Parameters<ChatSessionStore["createLoreEntry"]>[1]): ReturnType<ChatSessionStore["createLoreEntry"]> { return this.characters.createLoreEntry(lorebookId, input); }

  updateLoreEntry(entryId: Parameters<ChatSessionStore["updateLoreEntry"]>[0], input: Parameters<ChatSessionStore["updateLoreEntry"]>[1]): ReturnType<ChatSessionStore["updateLoreEntry"]> { return this.characters.updateLoreEntry(entryId, input); }

  deleteLoreEntry(entryId: string): void { this.characters.deleteLoreEntry(entryId); }

  linkCharacterLorebook(characterId: string, lorebookId: string): void { this.characters.linkCharacterLorebook(characterId, lorebookId); }

  listCharacters(): ReturnType<ChatSessionStore["listCharacters"]> { return this.characters.listCharacters(); }

  getCharacter(characterId: Parameters<ChatSessionStore["getCharacter"]>[0]): ReturnType<ChatSessionStore["getCharacter"]> { return this.characters.getCharacter(characterId); }

  getLatestCharacterVersion(characterId: Parameters<ChatSessionStore["getLatestCharacterVersion"]>[0]): ReturnType<ChatSessionStore["getLatestCharacterVersion"]> { return this.characters.getLatestCharacterVersion(characterId); }

  listLoreEntriesForCharacter(characterId: Parameters<ChatSessionStore["listLoreEntriesForCharacter"]>[0]): ReturnType<ChatSessionStore["listLoreEntriesForCharacter"]> { return this.characters.listLoreEntriesForCharacter(characterId); }

  setCharacterStatus(characterId: Parameters<ChatSessionStore["setCharacterStatus"]>[0], status: Parameters<ChatSessionStore["setCharacterStatus"]>[1]): void { this.characters.setCharacterStatus(characterId, status); }

  deleteCharacter(characterId: Parameters<ChatSessionStore["deleteCharacter"]>[0]): void { this.characters.deleteCharacter(characterId); }

  deleteChat(chatId: ChatId): void { this.chat.deleteChat(chatId); }

  renameChat(chatId: ChatId, title: string): void { this.chat.renameChat(chatId, title); }

  deleteBranch(chatId: ChatId, branchId: ChatBranchId): { activeBranchId: ChatBranchId; deletedBranchId: ChatBranchId } { return this.chat.deleteBranch(chatId, branchId); }

  cloneChat(chatId: ChatId, title?: string): CreateChatSessionResult { return this.chat.cloneChat(chatId, title); }

  getPromptTrace(promptTraceId: PromptTraceId): PromptTrace | null { return this.chat.getPromptTrace(promptTraceId); }

  // Provider Profiles
  upsertProviderProfile(profile: any): void { this.providers.upsertProviderProfile(profile); }

  listProviderProfiles(): any[] { return this.providers.listProviderProfiles(); }

  getProviderProfile(id: string): any | null { return this.providers.getProviderProfile(id); }

  deleteProviderProfile(id: string): void { this.providers.deleteProviderProfile(id); }

  setActiveProviderProfile(id: string): void { this.providers.setActiveProviderProfile(id); }

  getActiveProviderProfile(): any | null { return this.providers.getActiveProviderProfile(); }

  listPromptPresets(): PromptPreset[] { return this.providers.listPromptPresets(); }

  getPromptPreset(presetId: PromptPresetId): PromptPreset | null { return this.providers.getPromptPreset(presetId); }

  createPromptPreset(input: { name: string; bindModel: string; system: string; jailbreak: string; summary: string; tools: string }): PromptPreset { return this.providers.createPromptPreset(input); }

  updatePromptPreset(presetId: PromptPresetId, patch: Partial<Omit<PromptPreset, "id" | "createdAt" | "updatedAt">>): PromptPreset { return this.providers.updatePromptPreset(presetId, patch); }

  deletePromptPreset(presetId: PromptPresetId): void { this.providers.deletePromptPreset(presetId); }

}
