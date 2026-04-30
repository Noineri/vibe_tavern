import type { AssemblePromptResponse, PromptTraceRecordDto, PromptPresetDto } from "@rp-platform/api-contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ChatSessionStore,
} from "@rp-platform/db";
import { ENTITY_ID_NAMESPACE, SYSTEM_RESOURCE_ID } from "@rp-platform/domain";
import { logSendDebug } from "./send-debug-log.js";
import type {
  Chat,
  ChatBranch,
  ChatBranchId,
  ChatId,
  Character,
  CharacterId,
  CharacterVersion,
  CharacterVersionId,
  LoreEntry,
  Message,
  MessageId,
  Persona,
  PromptPresetId,
  PromptTrace,
  RetrievedMemoryHit,
  Lorebook,
  ToolProfile,
} from "@rp-platform/domain";
import {
  importCharacterCardV3Json,
  importStLorebookJson,
} from "../../../packages/import-export/src/index.js";
import { serializeSillyTavernChat } from "../../../packages/import-export/src/chats/st-chat.js";
import { createFileStore, STORAGE_FOLDERS } from "../../../packages/db/src/file-store.js";
import {
  activateLoreEntries,
  buildPromptVariableContext,
  createPhaseOneMacroEngine,
  type ActivatableLoreEntry,
} from "@rp-platform/prompt-pipeline";
import { ChatApplicationService } from "./chat-application-service.js";
import { PromptAssemblyService, type PromptAssemblyResolver } from "./prompt-assembly-service.js";
import {
  mapPromptTraceRecord,
  mapMessageDto,
  entryMatchesRecentText,
  toClientProviderProfile,
  resolveStoredApiKey,
  type StoredProviderProfileRecord,
  type ClientProviderProfileRecord,
  type CachedProviderModelsRecord,
} from "./session-runtime-dto.js";
export type { MessageDto } from "./session-runtime-dto.js";
import {
  toCharacterRecord,
  applyCharacterEditsToDefinition,
  type CharacterRecord,
  type PersonaRecord,
} from "./session-runtime-character.js";
import { createDefaultSessionStore } from "./session-runtime-store.js";

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

export interface PreparedLiveTurn {
  prompt: AssemblePromptResponse;
  snapshot: SessionSnapshot;
}

export interface BootstrapState {
  initialChatId: ChatId | null;
  snapshot: SessionSnapshot | null;
  isFirstRun: boolean;
}

interface PendingPromptTraceTurn {
  branchId: ChatBranchId;
  draft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
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
    const character = this.store.getCharacter(characterId as CharacterId);
    if (!character) {
      throw new Error(`Character '${characterId}' was not found.`);
    }
    const version = this.store.getLatestCharacterVersion(character.id);
    return toCharacterRecord(character, version);
  }

  getPersona(personaId: string) {
    const p = this.store.getPersona(personaId as import("@rp-platform/domain").PersonaId);
    if (!p) return null;
    return { id: p.id, name: p.name, description: p.description };
  }

  getPromptPreset(presetId: string) {
    const preset = this.store.getPromptPreset(presetId as PromptPresetId);
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
      ? this.store.listLoreEntriesForCharacter(chat.characterId as CharacterId)
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
  private readonly store: ChatSessionStore;
  private readonly defaultToolProfile: ToolProfile = {
    id: SYSTEM_RESOURCE_ID.toolsDisabled,
    name: "Tools Disabled",
    mode: "disabled",
    instructions: null,
    metadata: {},
  };
  private readonly resolver: StaticPromptResolver;
  private readonly chatApp: ChatApplicationService;
  private readonly promptService: PromptAssemblyService;
  private readonly chatOrder: ChatId[] = [];
  private readonly pendingPromptTraceByChat = new Map<ChatId, PendingPromptTraceTurn>();
  private readonly providerModelsCache = new Map<string, CachedProviderModelsRecord>();
  private readonly fileStore = createFileStore();

  constructor(store: ChatSessionStore = createDefaultSessionStore()) {
    this.store = store;
    this.ensureDefaultReferences();
    this.resolver = new StaticPromptResolver(this.store);
    this.chatApp = new ChatApplicationService(this.store);
    this.promptService = new PromptAssemblyService(this.store, this.resolver);
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
    this.store.updateChatPersona(chatId, personaId as import("@rp-platform/domain").PersonaId);
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
    this.store.updateChatPromptPreset(chatId, promptPresetId as PromptPresetId);
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
      throw new Error("Persona name is required.");
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
    this.store.deletePersona(personaId as import("@rp-platform/domain").PersonaId);
  }

  getPersonalLorebookStatus(personaId: string): { enabled: boolean; lorebookId: string | null } {
    const result = this.store.getPersonalLorebookForPersona(personaId as import("@rp-platform/domain").PersonaId);
    return result ? { enabled: true, lorebookId: result.lorebookId } : { enabled: false, lorebookId: null };
  }

  setPersonalLorebookEnabled(personaId: string, enabled: boolean): { enabled: boolean; lorebookId: string | null } {
    const typedPersonaId = personaId as import("@rp-platform/domain").PersonaId;
    if (enabled) {
      const persona = this.store.getPersona(personaId as import("@rp-platform/domain").PersonaId);
      if (!persona) {
        throw new Error(`Persona '${personaId}' was not found.`);
      }
      const result = this.store.enablePersonalLorebookForPersona(typedPersonaId, `__personal__:${personaId}`);
      return { enabled: true, lorebookId: result.lorebookId };
    }
    this.store.disablePersonalLorebookForPersona(typedPersonaId);
    return { enabled: false, lorebookId: null };
  }

  prepareLiveTurn(chatId: ChatId, content: string, model: string): PreparedLiveTurn {
    const trimmed = content.trim();
    if (!trimmed) {
      const assembled = this.assemblePrompt(chatId, undefined, { model });
      return {
        prompt: assembled.prompt,
        snapshot: this.getSnapshot(chatId),
      };
    }

    const expandedContent = this.expandChatMacros(chatId, trimmed);

    this.chatApp.appendUserMessage(chatId, {
      content: expandedContent,
      mode: "reply",
    });

    const assembled = this.assemblePrompt(chatId, undefined, { model });
    this.pendingPromptTraceByChat.set(chatId, {
      branchId: assembled.branchId,
      draft: assembled.promptTraceDraft,
    });

    return {
      prompt: assembled.prompt,
      snapshot: this.getSnapshot(chatId),
    };
  }

  appendAssistantReply(chatId: ChatId, content: string, latencyMs: number): SessionSnapshot {
    const chat = this.store.getChat(chatId)!;
    const fallbackDraft = this.assemblePrompt(chatId, chat.activeBranchId).promptTraceDraft;

    const assistantMessage = this.store.appendMessage({
      chatId,
      branchId: chat.activeBranchId,
      role: "assistant",
      authorType: "assistant",
      content,
    });

    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId);
    const baseDraft = pending?.draft ?? fallbackDraft;
    this.persistPromptTrace(assistantMessage.id, { ...baseDraft, latencyMs });
    const snapshot = this.getSnapshot(chatId);
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
    const trimmed = input.content.trim();
    if (!trimmed) {
      return this.getSnapshot(chatId);
    }

    const chat = this.store.getChat(chatId)!;
    const fallbackDraft = this.assemblePrompt(chatId, chat.activeBranchId, {
      excludeMessageIds: [messageId],
    }).promptTraceDraft;
    this.store.createMessageVariant({
      messageId,
      content: trimmed,
      finishReason: input.finishReason ?? null,
      isSelected: true,
    });
    const pending = this.consumePendingPromptTrace(chatId, chat.activeBranchId);
    const baseDraft = pending?.draft ?? fallbackDraft;
    this.persistPromptTrace(messageId, { ...baseDraft, latencyMs: input.latencyMs });
    return this.getSnapshot(chatId);
  }

  selectMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): SessionSnapshot {
    this.store.selectMessageVariant(messageId, variantIndex);
    return this.getSnapshot(chatId);
  }

  editMessage(chatId: ChatId, messageId: string, content: string): SessionSnapshot {
    this.chatApp.editMessage(messageId, content);
    return this.getSnapshot(chatId);
  }

  deleteMessage(chatId: ChatId, messageId: string): SessionSnapshot {
    this.chatApp.deleteMessage(messageId);
    return this.getSnapshot(chatId);
  }

  forkBranch(chatId: ChatId): SessionSnapshot {
    const { branchState } = this.chatApp.getChatState(chatId);
    const lastMessage = branchState.messages[branchState.messages.length - 1];

    this.chatApp.createBranch(chatId, {
      sourceBranchId: branchState.branch.id,
      forkedFromMessageId: lastMessage?.id ?? null,
      label: `branch ${this.store.listBranches(chatId).length + 1}`,
      activateFork: true,
    });

    this.pendingPromptTraceByChat.delete(chatId);
    return this.getSnapshot(chatId);
  }

  activateBranch(chatId: ChatId, branchId: ChatBranchId): SessionSnapshot {
    this.chatApp.activateBranch(chatId, branchId);
    this.pendingPromptTraceByChat.delete(chatId);
    return this.getSnapshot(chatId);
  }

  deleteBranch(chatId: string, branchId: string): SessionSnapshot {
    this.chatApp.deleteBranch(chatId as ChatId, branchId as ChatBranchId);
    this.pendingPromptTraceByChat.delete(chatId as ChatId);
    return this.getSnapshot(chatId as ChatId);
  }

  archiveCharacter(characterId: string): { characterId: string; status: "archived" } {
    this.store.setCharacterStatus(characterId as CharacterId, "archived");
    const character = this.store.getCharacter(characterId as CharacterId);
    if (character) {
      const chatId = this.store.listChats().find((c) => c.characterId === characterId)?.id;
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
    this.store.setCharacterStatus(characterId as CharacterId, "active");
    return { characterId, status: "active" };
  }

  deleteCharacter(characterId: string): void {
    const chatIds = this.store.listChats()
      .filter((c) => c.characterId === characterId)
      .map((c) => c.id);
    for (const chatId of chatIds) {
      const idx = this.chatOrder.indexOf(chatId);
      if (idx !== -1) this.chatOrder.splice(idx, 1);
      this.pendingPromptTraceByChat.delete(chatId);
    }
    this.store.deleteCharacter(characterId as CharacterId);
  }

  deleteChat(chatId: string): void {
    const idx = this.chatOrder.indexOf(chatId as ChatId);
    if (idx !== -1) this.chatOrder.splice(idx, 1);
    this.pendingPromptTraceByChat.delete(chatId as ChatId);
    this.store.deleteChat(chatId as ChatId);
  }

  renameChat(chatId: string, title: string): { chatId: string; title: string } {
    this.store.renameChat(chatId as ChatId, title);
    return { chatId, title };
  }

  createChatForCharacter(characterId: string): SessionSnapshot {
    const character = this.store.getCharacter(characterId as CharacterId);
    if (!character) {
      throw new Error(`Character '${characterId}' was not found.`);
    }

    const created = this.chatApp.createChat({
      characterId: characterId as CharacterId,
      personaId: this.resolveDefaultPersonaId(),
      title: `${character.name} chat`,
      promptPresetId: this.resolveDefaultPromptPresetId(),
      toolProfileId: this.defaultToolProfile.id,
    });

    this.chatOrder.unshift(created.id as ChatId);

    const greeting = character.firstMessage;
    if (greeting) {
      const chat = this.store.getChat(created.id as ChatId);
      if (chat) {
        this.store.appendMessage({
          chatId: created.id as ChatId,
          branchId: chat.activeBranchId,
          role: "assistant",
          authorType: "assistant",
          content: this.expandChatMacros(created.id as ChatId, greeting),
        });
      }
    }

    return this.getSnapshot(created.id as ChatId);
  }

  createCharacterFromScratch(input: {
    name: string;
    description?: string;
    personalitySummary?: string | null;
    scenario?: string | null;
    firstMessage?: string;
    mesExample?: string | null;
    alternateGreetings?: string[];
  }): ImportResult {
    const timestamp = new Date().toISOString();
    const characterId = `${ENTITY_ID_NAMESPACE.scratchCharacter}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` as CharacterId;
    const versionId = `${ENTITY_ID_NAMESPACE.scratchCharacterVersion}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` as CharacterVersionId;

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

    this.store.upsertCharacter(character);
    this.store.upsertCharacterVersion(version);

    const created = this.chatApp.createChat({
      characterId,
      personaId: this.resolveDefaultPersonaId(),
      title: input.name,
      promptPresetId: this.resolveDefaultPromptPresetId(),
      toolProfileId: this.defaultToolProfile.id,
    });

    this.chatOrder.unshift(created.id as ChatId);

    if (input.firstMessage?.trim()) {
      this.seedImportedOpening(created.id as ChatId, input.firstMessage);
    }

    return {
      activeChatId: created.id as ChatId,
      snapshot: this.getSnapshot(created.id as ChatId),
      imported: {
        kind: 'character',
        name: input.name,
        fileName: '',
        warningCount: 0,
        warnings: [],
      },
    };
  }

  createFreeChat(): SessionSnapshot {
    const timestamp = new Date().toISOString();
    const characterId = `${ENTITY_ID_NAMESPACE.freeCharacter}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` as CharacterId;
    const versionId = `${ENTITY_ID_NAMESPACE.freeCharacterVersion}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` as CharacterVersionId;

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

    this.store.upsertCharacter(character);
    this.store.upsertCharacterVersion(version);

    const created = this.chatApp.createChat({
      characterId,
      personaId: this.resolveDefaultPersonaId(),
      title: 'Free chat',
      promptPresetId: this.resolveDefaultPromptPresetId(),
      toolProfileId: this.defaultToolProfile.id,
    });

    this.chatOrder.unshift(created.id as ChatId);
    return this.getSnapshot(created.id as ChatId);
  }

  cloneChat(chatId: string): SessionSnapshot {
    const result = this.store.cloneChat(chatId as ChatId);
    this.chatOrder.unshift(result.chat.id);
    return this.getSnapshot(result.chat.id);
  }

  exportCharacter(characterId: string): Record<string, unknown> {
    const character = this.store.listCharacters().find((c) => c.id === characterId);
    if (!character) {
      throw new Error(`Character '${characterId}' was not found.`);
    }
    const version = this.store.getLatestCharacterVersion(characterId as CharacterId);
    const definition = version?.definition;
    let characterRecord: CharacterRecord | null = null;
    try {
      characterRecord = this.resolver.getCharacter(characterId);
    } catch {}

    if (definition && (definition as Record<string, unknown>).spec === "chara_card_v3") {
      return definition as Record<string, unknown>;
    }

    const data: Record<string, unknown> = {
      name: character.name,
      description: character.description,
      personality: character.personalitySummary ?? "",
      scenario: character.defaultScenario ?? "",
      first_mes: character.firstMessage ?? "",
      mes_example: character.mesExample ?? "",
      creator_notes: character.creatorNotes ?? "",
      system_prompt: character.systemPrompt ?? characterRecord?.systemPrompt ?? "",
      post_history_instructions: character.postHistoryInstructions ?? "",
      character_book: character.characterBook ?? undefined,
      depth_prompt: character.depthPrompt ?? "",
      depth_prompt_depth: character.depthPromptDepth,
      depth_prompt_role: character.depthPromptRole ?? "",
      alternate_greetings: character.alternateGreetings ?? [],
      extensions: character.extensions,
      tags: character.tags,
    };

    return {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data,
    };
  }

  exportChatJsonl(chatId: string): string {
    const chat = this.store.getChat(chatId as ChatId);
    if (!chat) {
      throw new Error(`Chat '${chatId}' was not found.`);
    }
    const branchState = this.store.getBranchState(chat.id, chat.activeBranchId);
    if (!branchState) {
      throw new Error(`Branch '${chat.activeBranchId}' was not found for chat '${chatId}'.`);
    }

    let characterName = "Assistant";
    try {
      characterName = this.resolver.getCharacter(chat.characterId).name;
    } catch {}
    const persona = this.resolver.getPersona(chat.personaId ?? this.resolveDefaultPersonaId());
    const userName = persona?.name ?? "User";

    return serializeSillyTavernChat({
      userName,
      characterName,
      messages: branchState.messages.map((message) => {
        const variants = this.store.listMessageVariants(message.id);
        const swipes = variants.length > 1
          ? variants.map((v) => v.content)
          : undefined;
        const selectedVariant = variants.find((v) => v.isSelected);
        const swipeId = selectedVariant?.variantIndex ?? 0;

        return {
          name: message.role === "user" ? userName : characterName,
          isUser: message.role === "user",
          isSystem: message.role === "system",
          content: selectedVariant?.content ?? message.content,
          sendDate: message.createdAt,
          swipes,
          swipeId: swipes ? swipeId : undefined,
        };
      }),
    });
  }

  exportPromptTrace(traceId: string): PromptTraceRecordDto {
    const trace = this.store.getPromptTrace(traceId as import("@rp-platform/domain").PromptTraceId);
    if (!trace) {
      throw new Error(`Prompt trace '${traceId}' was not found.`);
    }
    return mapPromptTraceRecord(trace);
  }

  mirrorChatTranscript(chatId: string): string[] {
    const chat = this.store.getChat(chatId as ChatId);
    if (!chat) {
      throw new Error(`Chat '${chatId}' was not found.`);
    }

    const branches = this.store.listBranches(chat.id);
    let characterName = "Assistant";
    try {
      characterName = this.resolver.getCharacter(chat.characterId).name;
    } catch {}
    const persona = this.resolver.getPersona(chat.personaId ?? this.resolveDefaultPersonaId());
    const userName = persona?.name ?? "User";

    const writtenPaths: string[] = [];
    for (const branch of branches) {
      const branchState = this.store.getBranchState(chat.id, branch.id);
      if (!branchState) continue;

      const jsonl = serializeSillyTavernChat({
        userName,
        characterName,
        messages: branchState.messages.map((message) => {
          const variants = this.store.listMessageVariants(message.id);
          const swipes = variants.length > 1
            ? variants.map((v) => v.content)
            : undefined;
          const selectedVariant = variants.find((v) => v.isSelected);
          const swipeId = selectedVariant?.variantIndex ?? 0;
          return {
            name: message.role === "user" ? userName : characterName,
            isUser: message.role === "user",
            isSystem: message.role === "system",
            content: selectedVariant?.content ?? message.content,
            sendDate: message.createdAt,
            swipes,
            swipeId: swipes ? swipeId : undefined,
          };
        }),
      });

      // data/chats/{chatId}/branches/{branchId}.jsonl
      const filePath = this.fileStore.resolvePath(
        STORAGE_FOLDERS.chatMirrors,
        `${chatId}/branches/${branch.id}.jsonl`,
      );
      const dir = resolve(filePath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, jsonl, "utf-8");
      writtenPaths.push(filePath);
    }

    return writtenPaths;
  }

  mirrorPromptTrace(traceId: string): string {
    const trace = this.store.getPromptTrace(traceId as import("@rp-platform/domain").PromptTraceId);
    if (!trace) {
      throw new Error(`Prompt trace '${traceId}' was not found.`);
    }
    // data/traces/{yyyy-mm-dd}/{promptTraceId}.json
    const date = trace.createdAt.split("T")[0];
    const filePath = this.fileStore.resolvePath(
      STORAGE_FOLDERS.traces,
      `${date}/${traceId}.json`,
    );
    this.fileStore.writeJson(filePath, trace);
    return filePath;
  }

  listProviderProfiles(): ClientProviderProfileRecord[] {
    return this.store
      .listProviderProfiles()
      .map((profile) => toClientProviderProfile(profile as StoredProviderProfileRecord));
  }

  async saveProviderProfile(profile: any): Promise<ClientProviderProfileRecord> {
    const existing = profile.id
      ? (this.store.getProviderProfile(profile.id) as StoredProviderProfileRecord | null)
      : null;
    const resolvedId =
      profile.id ||
      existing?.id ||
      `${ENTITY_ID_NAMESPACE.providerProfile}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const hasApiKeyInput = Object.prototype.hasOwnProperty.call(profile, "apiKey");
    const apiKey = hasApiKeyInput
      ? resolveStoredApiKey(profile.apiKey, existing?.apiKey ?? null)
      : (existing?.apiKey ?? null);

    const toSave = {
      ...existing,
      ...profile,
      id: resolvedId,
      apiKey,
    };

    this.store.upsertProviderProfile(toSave);
    return toClientProviderProfile(toSave as StoredProviderProfileRecord);
  }

  deleteProviderProfile(id: string): void {
    this.store.deleteProviderProfile(id);
  }

  activateProviderProfile(id: string): ClientProviderProfileRecord {
    this.store.setActiveProviderProfile(id);
    const profile = this.store.getProviderProfile(id) as StoredProviderProfileRecord | null;
    if (!profile) {
      throw new Error(`Provider profile '${id}' was not found after activation.`);
    }
    return toClientProviderProfile(profile);
  }

  resolveActiveProviderProfile(): StoredProviderProfileRecord | null {
    return this.store.getActiveProviderProfile() as StoredProviderProfileRecord | null;
  }

  updateProviderProfile(
    id: string,
    patch: {
      name?: string;
      type?: string;
      endpoint?: string;
      apiKey?: unknown;
      defaultModel?: string | null;
      contextBudget?: number | null;
      temperature?: number;
      topP?: number;
      minP?: number;
      topK?: number;
      typicalP?: number;
      repPen?: number;
      freqPen?: number;
      presPen?: number;
      maxTokens?: number;
      stopSeq?: string;
      seed?: string | null;
      reasoningEffort?: string;
      streamResponse?: boolean;
    },
  ): ClientProviderProfileRecord {
    const existing = this.store.getProviderProfile(id) as StoredProviderProfileRecord | null;
    if (!existing) {
      throw new Error(`Provider profile '${id}' was not found.`);
    }
    const hasApiKeyInput = Object.prototype.hasOwnProperty.call(patch, "apiKey");
    const apiKey = hasApiKeyInput
      ? resolveStoredApiKey(patch.apiKey, existing.apiKey ?? null)
      : (existing.apiKey ?? null);
    const merged: StoredProviderProfileRecord = {
      ...existing,
      ...patch,
      apiKey,
      id,
      isActive: existing.isActive,
    };
    this.store.upsertProviderProfile(merged);
    return toClientProviderProfile(merged);
  }

  createLoreEntry(lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry {
    let resolvedLorebookId = lorebookId;
    const existing = this.store.listLoreEntriesForCharacter(lorebookId);
    if (existing.length > 0 && existing[0].lorebookId) {
      resolvedLorebookId = existing[0].lorebookId;
    } else {
      const lorebook: Lorebook = {
        id: `${ENTITY_ID_NAMESPACE.lorebook}_${Date.now()}`,
        name: `${lorebookId} lorebook`,
        scopeType: "character",
        description: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.store.upsertLorebook(lorebook);
      this.store.linkCharacterLorebook(lorebookId, lorebook.id);
      resolvedLorebookId = lorebook.id;
    }
    return this.store.createLoreEntry(resolvedLorebookId, input);
  }

  updateLoreEntry(lorebookId: string, entryId: string, input: Partial<Omit<LoreEntry, "id" | "lorebookId">>): LoreEntry {
    return this.store.updateLoreEntry(entryId, input);
  }

  deleteLoreEntry(lorebookId: string, entryId: string): void {
    this.store.deleteLoreEntry(entryId);
  }

  getProviderProfile(id: string): StoredProviderProfileRecord | null {
    return this.store.getProviderProfile(id) as StoredProviderProfileRecord | null;
  }

  getProviderProfileForClient(id: string): ClientProviderProfileRecord | null {
    const profile = this.getProviderProfile(id);
    return profile ? toClientProviderProfile(profile) : null;
  }

  getCachedProviderModels(providerProfileId: string): CachedProviderModelsRecord | null {
    return this.providerModelsCache.get(providerProfileId) ?? null;
  }

  setCachedProviderModels(
    providerProfileId: string,
    models: Array<{ id: string; label: string }>,
  ): CachedProviderModelsRecord {
    const cached = {
      models,
      cachedAt: new Date().toISOString(),
    };
    this.providerModelsCache.set(providerProfileId, cached);
    return cached;
  }

  updateCharacter(
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
  ): SessionSnapshot {
    const currentCharacter = this.store.listCharacters().find((character) => character.id === characterId);
    if (!currentCharacter) {
      throw new Error(`Character '${characterId}' was not found.`);
    }

    const nextName = (input.name ?? currentCharacter.name).trim();
    if (!nextName) {
      throw new Error("Character name is required.");
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

    this.store.upsertCharacter(updatedCharacter);
    if (updatedVersion) {
      this.store.upsertCharacterVersion(updatedVersion);
    }

    const preferredChat = input.chatId ? this.store.getChat(input.chatId) : null;
    const targetChatId =
      (preferredChat?.characterId === characterId ? preferredChat.id : null) ??
      this.store.listChats().find((chat) => chat.characterId === characterId)?.id ??
      this.chatOrder[0];

    if (!targetChatId) {
      throw new Error("No chat is available for the updated character.");
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
    const currentPersona = this.store.getPersona(personaId as import("@rp-platform/domain").PersonaId);
    if (!currentPersona) {
      throw new Error(`Persona '${personaId}' was not found.`);
    }

    const nextName = (input.name ?? currentPersona.name).trim();
    if (!nextName) {
      throw new Error("Persona name is required.");
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
      throw new Error("No chat is available for the updated persona.");
    }

    return this.getSnapshot(targetChatId);
  }

  assemblePromptPreview(
    chatId: ChatId,
    options: { excludeMessageId?: MessageId; model: string },
  ): AssemblePromptResponse {
    const assembled = this.assemblePrompt(chatId, undefined, {
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

  listLoreEntries(lorebookId: string): LoreEntry[] {
    return this.store.listLoreEntriesForCharacter(lorebookId);
  }

  testLoreActivation(
    lorebookId: string,
    text: string,
  ): { activatedIds: string[]; totalEntries: number } {
    const entries = this.listLoreEntries(lorebookId);
    const activatable: ActivatableLoreEntry[] = entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      keys: entry.keys,
      secondaryKeys: entry.secondaryKeys,
      logic: entry.logic,
      position: entry.position,
      priority: entry.priority,
      enabled: entry.enabled,
    }));
    const activated = activateLoreEntries(activatable, {
      recentMessagesText: text,
    });
    return {
      activatedIds: activated.map((entry) => entry.id),
      totalEntries: entries.length,
    };
  }

  importJson(input: {
    fileName: string;
    jsonText: string;
    chatId?: string;
  }): ImportResult {
    const trimmed = input.jsonText.trim();
    if (!trimmed) {
      throw new Error("Import payload is empty.");
    }

    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (parsed.spec === "chara_card_v3") {
      const imported = importCharacterCardV3Json(parsed);
      this.store.upsertCharacter(imported.character);
      this.store.upsertCharacterVersion(imported.version);

      const created = this.chatApp.createChat({
        characterId: imported.character.id,
        personaId: this.resolveDefaultPersonaId(),
        title: imported.character.name,
        promptPresetId: this.resolveDefaultPromptPresetId(),
        toolProfileId: SYSTEM_RESOURCE_ID.toolsDisabled,
      });

      this.chatOrder.unshift(created.id);
      this.seedImportedOpening(created.id, imported.normalized.firstMessage);

      return {
        activeChatId: created.id,
        snapshot: this.getSnapshot(created.id),
        imported: {
          kind: "character",
          name: imported.character.name,
          fileName: input.fileName,
          warningCount: imported.warnings.length,
          warnings: imported.warnings,
        },
      };
    }

    const activeChatId = input.chatId ?? this.chatOrder[0];
    if (!activeChatId) {
      throw new Error("Import a character card first, then attach a lorebook to its chat.");
    }

    const imported = importStLorebookJson(parsed);
    const chat = this.store.getChat(activeChatId);
    if (!chat) {
      throw new Error(`Chat '${activeChatId}' was not found for lorebook import.`);
    }

    const lorebook: Lorebook = imported.lorebook;
    this.store.upsertLorebook(lorebook);
    this.store.replaceLoreEntries(lorebook.id, imported.entries);
    this.store.linkCharacterLorebook(chat.characterId, lorebook.id);

    return {
      activeChatId,
      snapshot: this.getSnapshot(activeChatId),
      imported: {
        kind: "lorebook",
        name: imported.lorebook.name,
        fileName: input.fileName,
        warningCount: imported.warnings.length,
        warnings: imported.warnings,
        attachedToCharacterName: this.resolver.getCharacter(chat.characterId).name,
      },
    };
  }

  listPromptPresets(): PromptPresetDto[] {
    return this.store.listPromptPresets().map((p) => ({
      id: p.id,
      name: p.name,
      bindModel: p.bindModel,
      system: p.system,
      jailbreak: p.jailbreak,
      summary: p.summary,
      tools: p.tools,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  createPromptPreset(input: {
    name: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    summary?: string;
    tools?: string;
  }): PromptPresetDto {
    const trimmed = (input.name ?? "").trim();
    if (!trimmed) {
      throw new Error("Preset name is required.");
    }
    const created = this.store.createPromptPreset({
      name: trimmed,
      bindModel: input.bindModel ?? "",
      system: input.system ?? "",
      jailbreak: input.jailbreak ?? "",
      summary: input.summary ?? "",
      tools: input.tools ?? "",
    });
    return { ...created };
  }

  updatePromptPreset(presetId: string, patch: {
    name?: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    summary?: string;
    tools?: string;
  }): PromptPresetDto {
    const next = this.store.updatePromptPreset(
      presetId as import("@rp-platform/domain").PromptPresetId,
      patch,
    );
    return { ...next };
  }

  deletePromptPreset(presetId: string): void {
    this.store.deletePromptPreset(presetId as import("@rp-platform/domain").PromptPresetId);
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
    this.persistPromptTrace(message.id, assembled.promptTraceDraft);
  }

  private resolvePromptVariableContext(chatId: ChatId) {
    const chat = this.store.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat '${chatId}' was not found.`);
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

  private resolveDefaultPersonaId(): import("@rp-platform/domain").PersonaId {
    const personas = this.store.listPersonas();
    const defaultPersona = personas.find((persona) => persona.defaultForNewChats) ?? personas[0];
    if (!defaultPersona) {
      throw new Error("No persona is available for new chats.");
    }
    return defaultPersona.id;
  }

  private resolveDefaultPromptPresetId(): PromptPresetId {
    const presets = this.store.listPromptPresets();
    const globalPreset = presets.find((preset) => preset.bindModel.trim() === "") ?? presets[0];
    if (!globalPreset) {
      throw new Error("No prompt preset is available for new chats.");
    }
    return globalPreset.id;
  }

  private ensureDefaultReferences(): void {
    const defaultPersonaId = SYSTEM_RESOURCE_ID.defaultPersonaExplorer as import("@rp-platform/domain").PersonaId;
    if (!this.store.getPersona(defaultPersonaId)) {
      this.store.upsertPersona({
        id: defaultPersonaId,
        name: "Explorer",
        description: "Curious, observant, and willing to follow the scene deeper instead of trying to dominate it.",
        pronouns: null,
        avatarAssetId: null,
        defaultForNewChats: true,
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      });
    }

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
    const activeProfileForAssembly = this.resolveActiveProviderProfile();
    return this.promptService.assembleForChat({
      chatId,
      branchId,
      model: options?.model ?? SYSTEM_RESOURCE_ID.unresolvedModel,
      excludeMessageIds: options?.excludeMessageIds,
      contextBudget: activeProfileForAssembly?.contextBudget ?? null,
    });
  }

  private persistPromptTrace(
    messageId: Message["id"],
    draft: Omit<PromptTrace, "id" | "messageId" | "createdAt">,
  ): void {
    this.store.createPromptTrace({
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
