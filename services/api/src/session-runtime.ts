import type { PromptTraceRecordDto } from "@rp-platform/domain";
import {
  type ChatSessionStore,
} from "@rp-platform/db";
import { brandId, ENTITY_ID_NAMESPACE, SYSTEM_RESOURCE_ID, type Chat, type ChatBranch, type ChatBranchId, type ChatId, type Character, type CharacterId, type CharacterVersion, type CharacterVersionId, type ToolProfileId, type LoreEntry, type Message, type MessageId, type PersonaId, type PromptPresetId, type PromptTrace, type RetrievedMemoryHit, type ToolProfile, type StoredProviderProfileRecord } from "@rp-platform/domain";
import { createFileStore } from "@rp-platform/db";
import {
  buildPromptVariableContext,
  createPhaseOneMacroEngine,
} from "@rp-platform/prompt-pipeline";
import { ChatApplicationService } from "./chat-application-service.js";
import { PromptAssemblyService, type PromptAssemblyResolver } from "./prompt-assembly-service.js";
import { notFound, validation, internal, isDomainError, conflict } from "./errors.js";
import {
  mapPromptTraceRecord,
  mapMessageDto,
  entryMatchesRecentText,
} from "./session-runtime-dto.js";
export type { MessageDto } from "./session-runtime-dto.js";
export type { PreparedLiveTurn } from "./session-runtime-chat.js";
import {
  toCharacterRecord,
  applyCharacterEditsToDefinition,
  type CharacterRecord,
  type PersonaRecord,
} from "./session-runtime-character.js";
import { createDefaultSessionStore } from "./session-runtime-store.js";
import * as importExportModule from "./session-runtime-import-export.js";
import * as lorebookModule from "./session-runtime-lorebook.js";
import { ChatRuntime } from "./session-runtime-chat.js";

import type { MessageDto } from "./session-runtime-dto.js";

const phaseOneMacroEngine = createPhaseOneMacroEngine();

export interface ChatListItem {
  id: ChatId;
  title: string;
  characterId: CharacterId;
  characterName: string;
  subtitle: string;
  activeBranchLabel: string;
  messageCount: number;
}

export interface SessionSnapshot {
  chats: ChatListItem[];
  activeChat: Chat;
  activeBranch: ChatBranch;
  branches: ChatBranch[];
  messages: MessageDto[];
  summaries: Array<{
    id: string;
    kind: string;
    summary: string;
  }>;
  promptTrace: PromptTraceRecordDto | null;
  promptTraceHistory: PromptTraceRecordDto[];
  character: CharacterRecord;
  persona: PersonaRecord | null;
}

export interface BootstrapState {
  initialChatId: ChatId | null;
  snapshot: SessionSnapshot | null;
  isFirstRun: boolean;
}

export interface ImportResult {
  activeChatId: ChatId;
  snapshot: SessionSnapshot;
  imported: {
    kind: "character" | "lorebook";
    name: string;
    fileName: string;
    warningCount: number;
    warnings: string[];
    attachedToCharacterName?: string;
  };
}

class StaticPromptResolver implements PromptAssemblyResolver {
  constructor(
    private readonly store: ChatSessionStore,
  ) {}

  getCharacter(characterId: string) {
    const character = this.store.getCharacter(brandId<CharacterId>(characterId));
    if (!character) {
      throw notFound("Character", `Character '${characterId}' was not found.`);
    }
    const version = this.store.getLatestCharacterVersion(character.id);
    return toCharacterRecord(character, version);
  }

  getPersona(personaId: string) {
    const p = this.store.getPersona(brandId<PersonaId>(personaId));
    if (!p) return null;
    return { id: p.id, name: p.name, description: p.description };
  }

  getPromptPreset(presetId: string) {
    const preset = this.store.getPromptPreset(brandId<PromptPresetId>(presetId));
    if (!preset) return null;
    return {
      id: preset.id,
      name: preset.name,
      text: preset.system,
      jailbreak: preset.jailbreak,
      summary: preset.summary,
      tools: preset.tools,
    };
  }

  listActiveLoreEntries(input: { chatId: ChatId; branchId: ChatBranchId; recentText: string }): LoreEntry[] {
    const lower = input.recentText.toLowerCase();
    const chat = this.store.getChat(input.chatId);
    const importedEntries = chat
      ? this.store.listLoreEntriesForCharacter(brandId<CharacterId>(chat.characterId))
      : [];

    return importedEntries.filter((entry) => entryMatchesRecentText(entry, lower));
  }

  listRetrievedMemories(input: { chatId: ChatId; branchId: ChatBranchId; recentText: string }): RetrievedMemoryHit[] {
    void input;
    return [];
  }

  getToolInstructions(): string | null {
    return null;
  }
}

export class SessionRuntime {
  readonly store: ChatSessionStore;
  private readonly defaultToolProfile: ToolProfile = {
    id: brandId<ToolProfileId>(SYSTEM_RESOURCE_ID.toolsDisabled),
    name: "Tools Disabled",
    mode: "disabled",
    instructions: null,
    metadata: {},
  };
  private readonly resolver: StaticPromptResolver;
  private readonly chatApp: ChatApplicationService;
  private readonly promptService: PromptAssemblyService;
  private readonly chatOrder: ChatId[] = [];
  private readonly fileStore = createFileStore();
  readonly chatRuntime: ChatRuntime;
  private defaultsEnsured = false;
  private readonly getActiveProviderProfile: () => StoredProviderProfileRecord | null;

  private get importExportDeps(): importExportModule.ImportExportModuleDeps {
    return {
      store: this.store,
      resolver: this.resolver as any,
      chatApp: this.chatApp,
      chatOrder: this.chatOrder,
      fileStore: this.fileStore,
      resolveDefaultPersonaId: () => this.resolveDefaultPersonaId(),
      resolveDefaultPromptPresetId: () => this.resolveDefaultPromptPresetId(),
      getSnapshot: (chatId) => this.getSnapshot(chatId),
      seedImportedOpening: (chatId, firstMessage) => this.seedImportedOpening(chatId, firstMessage),
    };
  }

  private get lorebookDeps(): lorebookModule.LorebookModuleDeps {
    return { store: this.store };
  }

  constructor(
    store: ChatSessionStore = createDefaultSessionStore(),
    options?: {
      getActiveProviderProfile?: () => StoredProviderProfileRecord | null;
    },
  ) {
    this.store = store;
    this.resolver = new StaticPromptResolver(this.store);
    this.chatApp = new ChatApplicationService(this.store);
    this.promptService = new PromptAssemblyService(this.store, this.resolver);
    this.getActiveProviderProfile = options?.getActiveProviderProfile ?? (() => null);
    this.chatRuntime = new ChatRuntime({
      store: this.store,
      chatApp: this.chatApp,
      expandChatMacros: (chatId, text) => this.expandChatMacros(chatId, text),
      assemblePrompt: (chatId, branchId, options) => this.assemblePrompt(chatId, branchId, options),
      getSnapshot: (chatId) => this.getSnapshot(chatId),
      chatOrder: {
        add: (chatId) => this.chatOrder.unshift(chatId),
        remove: (chatId) => {
          const idx = this.chatOrder.indexOf(chatId);
          if (idx !== -1) this.chatOrder.splice(idx, 1);
        },
      },
    });
    this.seed();
  }

  getBootstrapState(): BootstrapState {
    const initialChatId = this.chatOrder[0] ?? null;
    return {
      initialChatId,
      snapshot: initialChatId ? this.getSnapshot(initialChatId) : null,
      isFirstRun: this.store.listCharacters().length === 0,
    };
  }

  getSnapshot(chatId: ChatId): SessionSnapshot {
    const { chat, branchState } = this.chatApp.getChatState(chatId);
    const branches = this.store.listBranches(chat.id);
    const character = this.resolver.getCharacter(chat.characterId);
    const persona = this.resolver.getPersona(chat.personaId ?? this.resolveDefaultPersonaId());
    const promptTraceHistory = this.getPromptTraceHistory(chat.id, branchState.branch.id);

    return {
      chats: this.chatOrder.map((id) => this.toChatListItem(id)),
      activeChat: chat,
      activeBranch: branchState.branch,
      branches,
      messages: branchState.messages.map((message) =>
        mapMessageDto(message, this.store.listMessageVariants(message.id)),
      ),
      summaries: branchState.summaries.map((summary) => ({
        id: summary.id,
        kind: summary.kind,
        summary: summary.summary,
      })),
      promptTrace: promptTraceHistory[0] ?? null,
      promptTraceHistory,
      character,
      persona,
    };
  }

  getPromptTraceHistory(
    chatId: ChatId,
    branchId?: ChatBranchId,
    limit = 12,
  ): PromptTraceRecordDto[] {
    return this.store
      .listPromptTraces({
        chatId,
        branchId,
        limit,
      })
      .map(mapPromptTraceRecord);
  }

  switchChat(chatId: ChatId): SessionSnapshot {
    return this.getSnapshot(chatId);
  }

  listPersonas(): Array<{ id: string; name: string; description: string }> {
    return this.store.listPersonas().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    }));
  }

  setChatPersona(chatId: ChatId, personaId: string): SessionSnapshot {
    const before = this.store.getChat(chatId);
    this.store.updateChatPersona(chatId, brandId<PersonaId>(personaId));
    const after = this.store.getChat(chatId);
    console.info("[persona-switch]", {
      chatId,
      beforePersonaId: before?.personaId ?? null,
      afterPersonaId: after?.personaId ?? null,
      requestedPersonaId: personaId,
    });
    return this.getSnapshot(chatId);
  }

  setChatPromptPreset(chatId: ChatId, promptPresetId: string): SessionSnapshot {
    this.store.updateChatPromptPreset(chatId, brandId<PromptPresetId>(promptPresetId));
    return this.getSnapshot(chatId);
  }

  createPersona(input: {
    name: string;
    description: string;
    pronouns?: string | null;
    defaultForNewChats?: boolean;
  }): { id: string; name: string; description: string } {
    const trimmedName = (input.name ?? "").trim();
    const trimmedDescription = (input.description ?? "").trim();
    if (!trimmedName) {
      throw validation("Persona name is required.");
    }
    const persona = this.store.createPersona({
      name: trimmedName,
      description: trimmedDescription,
      pronouns: input.pronouns?.trim() || null,
      defaultForNewChats: input.defaultForNewChats === true,
    });
    return { id: persona.id, name: persona.name, description: persona.description };
  }

  deletePersona(personaId: string): void {
    try {
      this.store.deletePersona(brandId<PersonaId>(personaId));
    } catch (error) {
      if (isDomainError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/referenced by one or more chats/i.test(message)) {
        throw conflict(message);
      }
      if (/not found/i.test(message)) {
        throw notFound("Persona", message);
      }
      throw error;
    }
  }

  getPersonalLorebookStatus(personaId: string): { enabled: boolean; lorebookId: string | null } {
    const result = this.store.getPersonalLorebookForPersona(brandId<PersonaId>(personaId));
    return result ? { enabled: true, lorebookId: result.lorebookId } : { enabled: false, lorebookId: null };
  }

  setPersonalLorebookEnabled(personaId: string, enabled: boolean): { enabled: boolean; lorebookId: string | null } {
    const typedPersonaId = brandId<PersonaId>(personaId);
    if (enabled) {
      const persona = this.store.getPersona(typedPersonaId);
      if (!persona) {
        throw notFound("Persona", `Persona '${personaId}' was not found.`);
      }
      const result = this.store.enablePersonalLorebookForPersona(typedPersonaId, `__personal__:${personaId}`);
      return { enabled: true, lorebookId: result.lorebookId };
    }
    this.store.disablePersonalLorebookForPersona(typedPersonaId);
    return { enabled: false, lorebookId: null };
  }

  archiveCharacter(characterId: string): { characterId: string; status: "archived" } {
    const typedCharacterId = brandId<CharacterId>(characterId);
    this.store.setCharacterStatus(typedCharacterId, "archived");
    const character = this.store.getCharacter(typedCharacterId);
    if (character) {
      const chatId = this.store.listChats().find((c) => c.characterId === typedCharacterId)?.id;
      if (chatId) {
        const chatIndex = this.chatOrder.indexOf(chatId);
        if (chatIndex !== -1) {
          this.chatOrder.splice(chatIndex, 1);
        }
      }
    }
    return { characterId, status: "archived" };
  }

  unarchiveCharacter(characterId: string): { characterId: string; status: "active" } {
    this.store.setCharacterStatus(brandId<CharacterId>(characterId), "active");
    return { characterId, status: "active" };
  }

  deleteCharacter(characterId: string): void {
    const typedCharacterId = brandId<CharacterId>(characterId);
    const chatIds = this.store.listChats()
      .filter((c) => c.characterId === typedCharacterId)
      .map((c) => c.id);
    for (const chatId of chatIds) {
      const idx = this.chatOrder.indexOf(chatId);
      if (idx !== -1) this.chatOrder.splice(idx, 1);
      this.chatRuntime.discardPendingPromptTrace(chatId);
    }
    this.store.deleteCharacter(typedCharacterId);
  }

  createChatForCharacter(characterId: string): SessionSnapshot {
    const typedCharacterId = brandId<CharacterId>(characterId);
    const character = this.store.getCharacter(typedCharacterId);
    if (!character) {
      throw notFound("Character", `Character '${characterId}' was not found.`);
    }

    const created = this.chatApp.createChat({
      characterId: typedCharacterId,
      personaId: this.resolveDefaultPersonaId(),
      title: `${character.name} chat`,
      promptPresetId: this.resolveDefaultPromptPresetId(),
      toolProfileId: this.defaultToolProfile.id,
    });

    const createdChatId = created.id;
    this.chatOrder.unshift(createdChatId);

    const greeting = character.firstMessage;
    if (greeting) {
      const chat = this.store.getChat(createdChatId);
      if (chat) {
        this.store.appendMessage({
          chatId: createdChatId,
          branchId: chat.activeBranchId,
          role: "assistant",
          authorType: "assistant",
          content: this.expandChatMacros(createdChatId, greeting),
        });
      }
    }

    return this.getSnapshot(createdChatId);
  }

  async createCharacterFromScratch(input: {
    name: string;
    description?: string;
    personalitySummary?: string | null;
    scenario?: string | null;
    firstMessage?: string;
    mesExample?: string | null;
    alternateGreetings?: string[];
  }): Promise<ImportResult> {
    const timestamp = new Date().toISOString();
    const characterId = brandId<CharacterId>(`${ENTITY_ID_NAMESPACE.scratchCharacter}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const versionId = brandId<CharacterVersionId>(`${ENTITY_ID_NAMESPACE.scratchCharacterVersion}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

    const character: Character = {
      id: characterId,
      slug: input.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-zа-яё0-9-]/gi, ''),
      name: input.name,
      description: input.description ?? '',
      personalitySummary: input.personalitySummary?.trim() || null,
      defaultScenario: input.scenario?.trim() || null,
      firstMessage: input.firstMessage?.trim() || null,
      mesExample: input.mesExample?.trim() || null,
      alternateGreetings: input.alternateGreetings ?? [],
      postHistoryInstructions: null,
      creatorNotes: null,
      characterBook: null,
      depthPrompt: null,
      depthPromptDepth: null,
      depthPromptRole: null,
      extensions: {},
      systemPrompt: null,
      tags: [],
      avatarAssetId: null,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const version: CharacterVersion = {
      id: versionId,
      characterId,
      versionNumber: 1,
      title: 'Initial',
      cardFormat: 'st_v3',
      definition: {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name: input.name,
          description: input.description ?? "",
          personality: input.personalitySummary ?? "",
          scenario: input.scenario ?? "",
          first_mes: input.firstMessage ?? "",
          mes_example: input.mesExample ?? "",
          alternate_greetings: input.alternateGreetings ?? [],
        },
      },
      isActive: true,
      createdAt: timestamp,
    };

    await this.store.upsertCharacter(character);
    await this.store.upsertCharacterVersion(version);

    const created = this.chatApp.createChat({
      characterId,
      personaId: this.resolveDefaultPersonaId(),
      title: input.name,
      promptPresetId: this.resolveDefaultPromptPresetId(),
      toolProfileId: this.defaultToolProfile.id,
    });

    const createdChatId = created.id;
    this.chatOrder.unshift(createdChatId);

    if (input.firstMessage?.trim()) {
      this.seedImportedOpening(createdChatId, input.firstMessage);
    }

    return {
      activeChatId: createdChatId,
      snapshot: this.getSnapshot(createdChatId),
      imported: {
        kind: 'character',
        name: input.name,
        fileName: '',
        warningCount: 0,
        warnings: [],
      },
    };
  }

  async createFreeChat(): Promise<SessionSnapshot> {
    const timestamp = new Date().toISOString();
    const characterId = brandId<CharacterId>(`${ENTITY_ID_NAMESPACE.freeCharacter}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const versionId = brandId<CharacterVersionId>(`${ENTITY_ID_NAMESPACE.freeCharacterVersion}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

    const character: Character = {
      id: characterId,
      slug: 'free-chat',
      name: 'Free chat',
      description: '',
      personalitySummary: null,
      defaultScenario: null,
      firstMessage: null,
      mesExample: null,
      alternateGreetings: [],
      postHistoryInstructions: null,
      creatorNotes: null,
      characterBook: null,
      depthPrompt: null,
      depthPromptDepth: null,
      depthPromptRole: null,
      extensions: {},
      systemPrompt: null,
      tags: [],
      avatarAssetId: null,
      status: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const version: CharacterVersion = {
      id: versionId,
      characterId,
      versionNumber: 1,
      title: 'Free chat',
      cardFormat: 'st_v3',
      definition: {},
      isActive: true,
      createdAt: timestamp,
    };

    await this.store.upsertCharacter(character);
    await this.store.upsertCharacterVersion(version);

    const created = this.chatApp.createChat({
      characterId,
      personaId: this.resolveDefaultPersonaId(),
      title: 'Free chat',
      promptPresetId: this.resolveDefaultPromptPresetId(),
      toolProfileId: this.defaultToolProfile.id,
    });

    const freeChatId = created.id;
    this.chatOrder.unshift(freeChatId);
    return this.getSnapshot(freeChatId);
  }

  exportCharacter(characterId: string): Record<string, unknown> {
    return importExportModule.exportCharacter(this.importExportDeps, characterId);
  }

  exportChatJsonl(chatId: string): string {
    return importExportModule.exportChatJsonl(this.importExportDeps, chatId);
  }

  exportPromptTrace(traceId: string): PromptTraceRecordDto {
    return importExportModule.exportPromptTrace(this.importExportDeps, traceId);
  }

  mirrorChatTranscript(chatId: string): string[] {
    return importExportModule.mirrorChatTranscript(this.importExportDeps, chatId);
  }

  mirrorPromptTrace(traceId: string): string {
    return importExportModule.mirrorPromptTrace(this.importExportDeps, traceId);
  }

  createLoreEntry(lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry {
    return lorebookModule.createLoreEntry(this.lorebookDeps, lorebookId, input);
  }

  updateLoreEntry(lorebookId: string, entryId: string, input: Partial<Omit<LoreEntry, "id" | "lorebookId">>): LoreEntry {
    return lorebookModule.updateLoreEntry(this.lorebookDeps, lorebookId, entryId, input);
  }

  deleteLoreEntry(lorebookId: string, entryId: string): void {
    lorebookModule.deleteLoreEntry(this.lorebookDeps, lorebookId, entryId);
  }

  async updateCharacter(
    characterId: CharacterId,
    input: {
      chatId?: ChatId;
      name?: string;
      description?: string;
      personalitySummary?: string | null;
      scenario?: string;
      systemPrompt?: string;
      firstMessage?: string | null;
      mesExample?: string | null;
      alternateGreetings?: string[];
      postHistoryInstructions?: string | null;
      creatorNotes?: string | null;
      characterBook?: Record<string, unknown> | null;
      depthPrompt?: string | null;
      depthPromptDepth?: number | null;
      depthPromptRole?: string | null;
      extensions?: Record<string, unknown>;
      tags?: string[];
    },
  ): Promise<SessionSnapshot> {
    const currentCharacter = this.store.listCharacters().find((character) => character.id === characterId);
    if (!currentCharacter) {
      throw notFound("Character", `Character '${characterId}' was not found.`);
    }

    const nextName = (input.name ?? currentCharacter.name).trim();
    if (!nextName) {
      throw validation("Character name is required.");
    }

    const now = new Date().toISOString();
    const nextDescription = input.description ?? currentCharacter.description;
    const nextPersonalitySummary = input.personalitySummary !== undefined ? input.personalitySummary : currentCharacter.personalitySummary;
    const nextScenario = input.scenario ?? currentCharacter.defaultScenario ?? "";
    const currentVersion = this.store.getLatestCharacterVersion(characterId);
    const currentRecord = toCharacterRecord(currentCharacter, currentVersion);
    const nextSystemPrompt = input.systemPrompt ?? currentCharacter.systemPrompt ?? currentRecord.systemPrompt;
    const updatedCharacter: Character = {
      ...currentCharacter,
      name: nextName,
      description: nextDescription,
      personalitySummary: nextPersonalitySummary,
      defaultScenario: nextScenario || null,
      firstMessage: input.firstMessage !== undefined ? input.firstMessage : currentCharacter.firstMessage,
      mesExample: input.mesExample !== undefined ? input.mesExample : currentCharacter.mesExample,
      alternateGreetings: input.alternateGreetings ?? currentCharacter.alternateGreetings,
      postHistoryInstructions: input.postHistoryInstructions !== undefined ? input.postHistoryInstructions : currentCharacter.postHistoryInstructions,
      creatorNotes: input.creatorNotes !== undefined ? input.creatorNotes : currentCharacter.creatorNotes,
      characterBook: input.characterBook !== undefined ? input.characterBook : currentCharacter.characterBook,
      depthPrompt: input.depthPrompt !== undefined ? input.depthPrompt : currentCharacter.depthPrompt,
      depthPromptDepth: input.depthPromptDepth !== undefined ? input.depthPromptDepth : currentCharacter.depthPromptDepth,
      depthPromptRole: input.depthPromptRole !== undefined ? input.depthPromptRole : currentCharacter.depthPromptRole,
      extensions: input.extensions ?? currentCharacter.extensions,
      systemPrompt: nextSystemPrompt || null,
      tags: input.tags ?? currentCharacter.tags,
      updatedAt: now,
    };

    const updatedVersion = currentVersion
      ? {
          ...currentVersion,
          definition: applyCharacterEditsToDefinition(currentVersion.definition, {
            name: nextName,
            description: nextDescription,
            personalitySummary: nextPersonalitySummary,
            scenario: nextScenario,
            systemPrompt: nextSystemPrompt,
            firstMessage: input.firstMessage !== undefined ? input.firstMessage : currentCharacter.firstMessage,
            mesExample: input.mesExample !== undefined ? input.mesExample : currentCharacter.mesExample,
            alternateGreetings: input.alternateGreetings ?? currentCharacter.alternateGreetings,
            postHistoryInstructions: input.postHistoryInstructions !== undefined ? input.postHistoryInstructions : currentCharacter.postHistoryInstructions,
            creatorNotes: input.creatorNotes !== undefined ? input.creatorNotes : currentCharacter.creatorNotes,
            characterBook: input.characterBook !== undefined ? input.characterBook : currentCharacter.characterBook,
            depthPrompt: input.depthPrompt !== undefined ? input.depthPrompt : currentCharacter.depthPrompt,
            depthPromptDepth: input.depthPromptDepth !== undefined ? input.depthPromptDepth : currentCharacter.depthPromptDepth,
            depthPromptRole: input.depthPromptRole !== undefined ? input.depthPromptRole : currentCharacter.depthPromptRole,
            extensions: input.extensions ?? currentCharacter.extensions,
            tags: input.tags ?? currentCharacter.tags,
          }),
        }
      : null;

    await this.store.upsertCharacter(updatedCharacter);
    if (updatedVersion) {
      await this.store.upsertCharacterVersion(updatedVersion);
    }

    const preferredChat = input.chatId ? this.store.getChat(input.chatId) : null;
    const targetChatId =
      (preferredChat?.characterId === characterId ? preferredChat.id : null) ??
      this.store.listChats().find((chat) => chat.characterId === characterId)?.id ??
      this.chatOrder[0];

    if (!targetChatId) {
      throw notFound("Chat", "No chat is available for the updated character.");
    }

    return this.getSnapshot(targetChatId);
  }

  updatePersona(
    personaId: string,
    input: {
      chatId?: ChatId;
      name?: string;
      description?: string;
    },
  ): SessionSnapshot {
    const currentPersona = this.store.getPersona(brandId<PersonaId>(personaId));
    if (!currentPersona) {
      throw notFound("Persona", `Persona '${personaId}' was not found.`);
    }

    const nextName = (input.name ?? currentPersona.name).trim();
    if (!nextName) {
      throw validation("Persona name is required.");
    }

    const nextDescription = input.description ?? currentPersona.description;
    
    this.store.upsertPersona({
      ...currentPersona,
      name: nextName,
      description: nextDescription,
      updatedAt: new Date().toISOString(),
    });

    const preferredChat = input.chatId ? this.store.getChat(input.chatId) : null;
    const targetChatId =
      (preferredChat?.personaId === personaId ? preferredChat.id : null) ??
      this.store.listChats().find((chat) => chat.personaId === personaId)?.id ??
      this.chatOrder[0];

    if (!targetChatId) {
      throw notFound("Chat", "No chat is available for the updated persona.");
    }

    return this.getSnapshot(targetChatId);
  }

  listLoreEntries(lorebookId: string): LoreEntry[] {
    return lorebookModule.listLoreEntries(this.lorebookDeps, lorebookId);
  }

  testLoreActivation(
    lorebookId: string,
    text: string,
  ): { activatedIds: string[]; totalEntries: number } {
    return lorebookModule.testLoreActivation(this.lorebookDeps, lorebookId, text);
  }

  async importJson(input: {
    fileName: string;
    jsonText: string;
    chatId?: string;
  }): Promise<ImportResult> {
    return importExportModule.importJson(this.importExportDeps, input);
  }

  private seed(): void {
    const existingChats = this.store.listChats();
    if (existingChats.length > 0) {
      this.chatOrder.push(...existingChats.map((chat) => chat.id));
      return;
    }
  }

  private seedImportedOpening(chatId: ChatId, firstMessage: string): void {
    const trimmed = firstMessage.trim();
    if (!trimmed) {
      return;
    }

    const chat = this.store.getChat(chatId)!;
    const assembled = this.assemblePrompt(chatId, chat.activeBranchId);
    const message = this.store.appendMessage({
      chatId,
      branchId: chat.activeBranchId,
      role: "assistant",
      authorType: "assistant",
      content: this.expandChatMacros(chatId, trimmed),
    });
    this.store.createPromptTrace({
      ...assembled.promptTraceDraft,
      messageId: message.id,
    });
  }

  private resolvePromptVariableContext(chatId: ChatId) {
    const chat = this.store.getChat(chatId);
    if (!chat) {
      throw notFound("Chat", `Chat '${chatId}' was not found.`);
    }
    const character = this.resolver.getCharacter(chat.characterId);
    const persona = this.resolver.getPersona(chat.personaId ?? this.resolveDefaultPersonaId());
    const latestVersion = this.store.getLatestCharacterVersion(chat.characterId);
    return buildPromptVariableContext({
      character: {
        name: character.name,
        description: character.description,
        personality: character.personalitySummary,
        scenario: character.scenario,
        firstMessage: character.firstMessage,
        alternateGreetings: character.alternateGreetings,
        mesExample: character.mesExample,
        postHistoryInstructions: character.postHistoryInstructions,
        creatorNotes: character.creatorNotes,
        depthPrompt: character.depthPrompt,
        depthPromptDepth: character.depthPromptDepth,
        depthPromptRole: character.depthPromptRole,
        systemPrompt: character.systemPrompt,
        version: latestVersion ? {
          versionNumber: latestVersion.versionNumber,
          title: latestVersion.title,
          cardFormat: latestVersion.cardFormat,
          definition: latestVersion.definition,
        } : null,
        tags: character.tags,
        characterBook: character.characterBook,
        extensions: character.extensions,
      },
      persona: {
        name: persona?.name ?? "User",
        description: persona?.description ?? "",
      },
    });
  }

  private expandChatMacros(chatId: ChatId, text: string): string {
    return phaseOneMacroEngine.resolve(text, this.resolvePromptVariableContext(chatId));
  }

  private resolveDefaultPersonaId(): PersonaId {
    this.ensureDefaultsOnce();

    let personas = this.store.listPersonas();
    if (personas.length === 0) {
      const created = this.store.createPersona({
        name: "User",
        description: "",
        pronouns: null,
        defaultForNewChats: true,
      });
      return created.id;
    }

    const defaultPersona = personas.find((persona) => persona.defaultForNewChats) ?? personas[0];
    if (!defaultPersona) {
      throw internal("No persona is available for new chats.");
    }
    return defaultPersona.id;
  }

  private resolveDefaultPromptPresetId(): PromptPresetId {
    this.ensureDefaultsOnce();

    const presets = this.store.listPromptPresets();
    const globalPreset = presets.find((preset) => preset.bindModel.trim() === "") ?? presets[0];
    if (!globalPreset) {
      throw internal("No prompt preset is available for new chats.");
    }
    return globalPreset.id;
  }

  private ensureDefaultsOnce(): void {
    if (this.defaultsEnsured) return;
    this.defaultsEnsured = true;

    if (!this.store.getToolProfile(this.defaultToolProfile.id)) {
      this.store.upsertToolProfile(this.defaultToolProfile);
    }

    if (this.store.listPromptPresets().length === 0) {
      this.store.createPromptPreset({
        name: "Стандартный",
        bindModel: "",
        system: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
        jailbreak: "",
        summary: "",
        tools: "",
      });
    }
  }

  private assemblePrompt(
    chatId: ChatId,
    branchId?: ChatBranchId,
    options?: { excludeMessageIds?: MessageId[]; model?: string },
  ) {
    const activeProfileForAssembly = this.getActiveProviderProfile();
    return this.promptService.assembleForChat({
      chatId,
      branchId,
      model: options?.model ?? SYSTEM_RESOURCE_ID.unresolvedModel,
      excludeMessageIds: options?.excludeMessageIds,
      contextBudget: activeProfileForAssembly?.contextBudget ?? null,
    });
  }

  private toChatListItem(chatId: ChatId): ChatListItem {
    const chat = this.store.getChat(chatId)!;
    const branchState = this.store.getBranchState(chat.id, chat.activeBranchId)!;
    let characterName = "Unknown";
    let subtitle = "";
    try {
      const charRecord = this.resolver.getCharacter(chat.characterId);
      characterName = charRecord.name;
      subtitle = charRecord.subtitle;
    } catch {}
    return {
      id: chat.id,
      title: chat.title,
      characterId: chat.characterId,
      characterName,
      subtitle,
      activeBranchLabel: branchState.branch.label,
      messageCount: branchState.messages.length,
    };
  }

}
