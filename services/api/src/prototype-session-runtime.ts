import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AssemblePromptResponse, PromptTraceRecordDto } from "@rp-platform/api-contracts";
import {
  InMemoryChatSessionStore,
  NodeSqliteDatabaseAdapter,
  SqliteChatSessionStore,
  applySqliteMigrations,
  type ChatSessionStore,
} from "@rp-platform/db";
import type {
  Chat,
  ChatBranch,
  ChatBranchId,
  ChatId,
  Character,
  CharacterId,
  CharacterVersion,
  GenerationPreset,
  GenerationRule,
  LoreEntry,
  Message,
  MessageId,
  MessageVariant,
  Persona,
  PromptTrace,
  RetrievedMemoryHit,
  Lorebook,
  ToolProfile,
} from "@rp-platform/domain";
import {
  importCharacterCardV3Json,
  importStLorebookJson,
} from "../../../packages/import-export/src/index.js";
import { ChatApplicationService } from "./chat-application-service.js";
import { PromptAssemblyService, type PromptAssemblyResolver } from "./prompt-assembly-service.js";

type CharacterRecord = {
  id: string;
  name: string;
  description: string;
  scenario: string;
  systemPrompt: string;
  subtitle: string;
};

type PersonaRecord = {
  id: string;
  name: string;
  description: string;
};

type PresetRecord = {
  id: string;
  text: string;
};

export interface PrototypeChatListItem {
  id: ChatId;
  title: string;
  characterName: string;
  subtitle: string;
  activeBranchLabel: string;
  messageCount: number;
}

export interface PrototypeSnapshot {
  chats: PrototypeChatListItem[];
  activeChat: Chat;
  activeBranch: ChatBranch;
  branches: ChatBranch[];
  messages: PrototypeMessageDto[];
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

export interface PrototypeMessageDto extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
}

export interface PreparedLiveTurn {
  prompt: AssemblePromptResponse;
  snapshot: PrototypeSnapshot;
}

export interface PrototypeBootstrapState {
  initialChatId: ChatId | null;
  snapshot: PrototypeSnapshot | null;
}

interface PendingPromptTraceTurn {
  branchId: ChatBranchId;
  draft: Omit<PromptTrace, "id" | "messageId" | "createdAt">;
}

interface StoredProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ClientProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  defaultModel?: string | null;
  contextBudget?: number | null;
  createdAt?: string;
  updatedAt?: string;
  hasStoredApiKey: boolean;
}

export interface PrototypeImportResult {
  activeChatId: ChatId;
  snapshot: PrototypeSnapshot;
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
    private readonly characters: Map<string, CharacterRecord>,
    private readonly personas: Map<string, PersonaRecord>,
    private readonly presets: Map<string, PresetRecord>,
    private readonly importedLoreEntriesByCharacter: Map<CharacterId, LoreEntry[]>,
  ) {}

  getCharacter(characterId: string) {
    const character = this.characters.get(characterId);
    if (!character) {
      throw new Error(`Character '${characterId}' was not found.`);
    }
    return {
      id: character.id,
      name: character.name,
      description: character.description,
      scenario: character.scenario,
      systemPrompt: character.systemPrompt,
      subtitle: character.subtitle,
    };
  }

  getPersona(personaId: string) {
    return this.personas.get(personaId) ?? null;
  }

  getGenerationPreset(presetId: string) {
    return this.presets.get(presetId) ?? null;
  }

  listGenerationRules(chatId: ChatId): GenerationRule[] {
    return [
      {
        id: `rule_scene_${chatId}`,
        scopeType: "chat",
        scopeId: chatId,
        title: "Scene Discipline",
        content: "Do not speak for the user. Advance the scene with concrete sensory detail.",
        enabled: true,
        priority: 30,
      },
      {
        id: `rule_tone_${chatId}`,
        scopeType: "chat",
        scopeId: chatId,
        title: "Tone",
        content: "Keep the reply readable, grounded, and aimed at long-form roleplay.",
        enabled: true,
        priority: 20,
      },
    ];
  }

  listActiveLoreEntries(input: { chatId: ChatId; branchId: ChatBranchId; recentText: string }): LoreEntry[] {
    const lower = input.recentText.toLowerCase();
    const chat = this.store.getChat(input.chatId);
    const importedEntries = chat
      ? this.importedLoreEntriesByCharacter.get(chat.characterId) ?? []
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

export class PrototypeSessionRuntime {
  private readonly store: ChatSessionStore;
  private readonly characters = new Map<string, CharacterRecord>();
  private readonly personas = new Map<string, PersonaRecord>([
    [
      "persona_explorer",
      {
        id: "persona_explorer",
        name: "Explorer",
        description:
          "Curious, observant, and willing to follow the scene deeper instead of trying to dominate it.",
      },
    ],
  ]);
  private readonly presets = new Map<string, PresetRecord>([
    [
      "preset_default",
      {
        id: "preset_default",
        text: "Write immersive fictional roleplay. Stay inside the scene. Do not narrate for the user.",
      },
    ],
  ]);
  private readonly importedLoreEntriesByCharacter = new Map<CharacterId, LoreEntry[]>();
  private readonly defaultPersona: Persona = {
    id: "persona_explorer",
    name: "Explorer",
    description:
      "Curious, observant, and willing to follow the scene deeper instead of trying to dominate it.",
    pronouns: null,
    avatarAssetId: null,
    defaultForNewChats: true,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
  };
  private readonly defaultPreset: GenerationPreset = {
    id: "preset_default",
    name: "Default RP",
    temperature: 0.85,
    topP: null,
    topK: null,
    presencePenalty: null,
    frequencyPenalty: null,
    maxOutputTokens: null,
    systemStyleNote: "Write immersive fictional roleplay. Stay inside the scene. Do not narrate for the user.",
    metadata: {},
  };
  private readonly defaultToolProfile: ToolProfile = {
    id: "tools_disabled",
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

  constructor(store: ChatSessionStore = createDefaultPrototypeStore()) {
    this.store = store;
    this.ensurePrototypeReferences();
    this.restoreImportedDataFromStore();
    this.resolver = new StaticPromptResolver(
      this.store,
      this.characters,
      this.personas,
      this.presets,
      this.importedLoreEntriesByCharacter,
    );
    this.chatApp = new ChatApplicationService(this.store);
    this.promptService = new PromptAssemblyService(this.store, this.resolver);
    this.seed();
  }

  getBootstrapState(): PrototypeBootstrapState {
    const initialChatId = this.chatOrder[0] ?? null;
    return {
      initialChatId,
      snapshot: initialChatId ? this.getSnapshot(initialChatId) : null,
    };
  }

  getSnapshot(chatId: ChatId): PrototypeSnapshot {
    const { chat, branchState } = this.chatApp.getChatState(chatId);
    const branches = this.store.listBranches(chat.id);
    const character = this.resolver.getCharacter(chat.characterId);
    const persona = this.resolver.getPersona(chat.personaId);
    const promptTraceHistory = this.getPromptTraceHistory(chat.id, branchState.branch.id);

    return {
      chats: this.chatOrder.map((id) => this.toChatListItem(id)),
      activeChat: chat,
      activeBranch: branchState.branch,
      branches,
      messages: branchState.messages.map((message) =>
        mapPrototypeMessage(message, this.store.listMessageVariants(message.id)),
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

  getLatestPromptTrace(chatId: ChatId, branchId?: ChatBranchId): PromptTraceRecordDto | null {
    const trace = this.store.getLatestPromptTrace(chatId, branchId);
    return trace ? mapPromptTraceRecord(trace) : null;
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

  switchChat(chatId: ChatId): PrototypeSnapshot {
    return this.getSnapshot(chatId);
  }

  sendMessage(chatId: ChatId, content: string): PrototypeSnapshot {
    const trimmed = content.trim();
    if (!trimmed) {
      return this.getSnapshot(chatId);
    }

    this.chatApp.appendUserMessage(chatId, {
      content: trimmed,
      mode: "reply",
    });

    const assembled = this.assemblePrompt(chatId);
    const chat = this.store.getChat(chatId)!;
    const reply = synthesizeAssistantReply({
      characterName: this.resolver.getCharacter(chat.characterId).name,
      userText: trimmed,
      prompt: assembled.prompt,
    });

    const assistantMessage = this.store.appendMessage({
      chatId,
      branchId: chat.activeBranchId,
      role: "assistant",
      authorType: "assistant",
      content: reply,
    });

    this.pendingPromptTraceByChat.delete(chatId);
    this.persistPromptTrace(assistantMessage.id, assembled.promptTraceDraft);
    return this.getSnapshot(chatId);
  }

  prepareLiveTurn(chatId: ChatId, content: string): PreparedLiveTurn {
    const trimmed = content.trim();
    if (!trimmed) {
      const assembled = this.assemblePrompt(chatId);
      return {
        prompt: assembled.prompt,
        snapshot: this.getSnapshot(chatId),
      };
    }

    this.chatApp.appendUserMessage(chatId, {
      content: trimmed,
      mode: "reply",
    });

    const assembled = this.assemblePrompt(chatId);
    this.pendingPromptTraceByChat.set(chatId, {
      branchId: assembled.branchId,
      draft: assembled.promptTraceDraft,
    });

    return {
      prompt: assembled.prompt,
      snapshot: this.getSnapshot(chatId),
    };
  }

  appendAssistantReply(chatId: ChatId, content: string): PrototypeSnapshot {
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
    this.persistPromptTrace(assistantMessage.id, pending?.draft ?? fallbackDraft);
    return this.getSnapshot(chatId);
  }

  appendMessageVariant(
    chatId: ChatId,
    messageId: MessageId,
    input: { content: string; finishReason?: string | null },
  ): PrototypeSnapshot {
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
    this.persistPromptTrace(messageId, pending?.draft ?? fallbackDraft);
    return this.getSnapshot(chatId);
  }

  selectMessageVariant(chatId: ChatId, messageId: MessageId, variantIndex: number): PrototypeSnapshot {
    this.store.selectMessageVariant(messageId, variantIndex);
    return this.getSnapshot(chatId);
  }

  editMessage(chatId: ChatId, messageId: string, content: string): PrototypeSnapshot {
    this.chatApp.editMessage(messageId, content);
    return this.getSnapshot(chatId);
  }

  deleteMessage(chatId: ChatId, messageId: string): PrototypeSnapshot {
    this.chatApp.deleteMessage(messageId);
    return this.getSnapshot(chatId);
  }

  forkBranch(chatId: ChatId): PrototypeSnapshot {
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

  activateBranch(chatId: ChatId, branchId: ChatBranchId): PrototypeSnapshot {
    this.chatApp.activateBranch(chatId, branchId);
    this.pendingPromptTraceByChat.delete(chatId);
    return this.getSnapshot(chatId);
  }

  listProviderProfiles(): ClientProviderProfileRecord[] {
    return this.store
      .listProviderProfiles()
      .map((profile) => this.toClientProviderProfile(profile as StoredProviderProfileRecord));
  }

  async saveProviderProfile(profile: any): Promise<ClientProviderProfileRecord> {
    const existing = profile.id
      ? (this.store.getProviderProfile(profile.id) as StoredProviderProfileRecord | null)
      : null;
    const resolvedId =
      profile.id ||
      existing?.id ||
      `provider_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const hasApiKeyInput = Object.prototype.hasOwnProperty.call(profile, "apiKey");
    const apiKey = hasApiKeyInput
      ? this.resolveStoredApiKey(profile.apiKey, existing?.apiKey ?? null)
      : (existing?.apiKey ?? null);

    const toSave = {
      ...existing,
      ...profile,
      id: resolvedId,
      apiKey,
    };

    this.store.upsertProviderProfile(toSave);
    return this.toClientProviderProfile(toSave as StoredProviderProfileRecord);
  }

  deleteProviderProfile(id: string): void {
    this.store.deleteProviderProfile(id);
  }

  getProviderProfile(id: string): StoredProviderProfileRecord | null {
    return this.store.getProviderProfile(id) as StoredProviderProfileRecord | null;
  }

  getProviderProfileForClient(id: string): ClientProviderProfileRecord | null {
    const profile = this.getProviderProfile(id);
    return profile ? this.toClientProviderProfile(profile) : null;
  }

  updateCharacter(
    characterId: CharacterId,
    input: {
      chatId?: ChatId;
      name?: string;
      description?: string;
      scenario?: string;
    },
  ): PrototypeSnapshot {
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
    const nextScenario = input.scenario ?? currentCharacter.defaultScenario ?? "";
    const updatedCharacter: Character = {
      ...currentCharacter,
      name: nextName,
      description: nextDescription,
      defaultScenario: nextScenario || null,
      updatedAt: now,
    };

    const currentVersion = this.store.getLatestCharacterVersion(characterId);
    const updatedVersion = currentVersion
      ? {
          ...currentVersion,
          definition: applyCharacterEditsToDefinition(currentVersion.definition, {
            name: nextName,
            description: nextDescription,
            scenario: nextScenario,
          }),
        }
      : null;

    this.store.upsertCharacter(updatedCharacter);
    if (updatedVersion) {
      this.store.upsertCharacterVersion(updatedVersion);
    }

    this.characters.set(characterId, toCharacterRecord(updatedCharacter, updatedVersion ?? currentVersion));

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

  sleepBranch(chatId: ChatId): PrototypeSnapshot {
    const { branchState } = this.chatApp.getChatState(chatId);
    const lastMessage = branchState.messages[branchState.messages.length - 1];
    if (!lastMessage) {
      return this.getSnapshot(chatId);
    }

    this.chatApp.sleepBranch(chatId, {
      branchId: branchState.branch.id,
      kind: "scene",
      summary: summarizeBranch(branchState.messages),
      coversThroughMessageId: lastMessage.id,
    });

    return this.getSnapshot(chatId);
  }

  refreshPrompt(chatId: ChatId): PrototypeSnapshot {
    this.assemblePrompt(chatId);
    return this.getSnapshot(chatId);
  }

  assemblePromptPreview(
    chatId: ChatId,
    options?: { excludeMessageId?: MessageId },
  ): AssemblePromptResponse {
    const assembled = this.assemblePrompt(chatId, undefined, {
      excludeMessageIds: options?.excludeMessageId ? [options.excludeMessageId] : [],
    });
    if (options?.excludeMessageId) {
      this.pendingPromptTraceByChat.set(chatId, {
        branchId: assembled.branchId,
        draft: assembled.promptTraceDraft,
      });
    }
    return assembled.prompt;
  }

  importJson(input: {
    fileName: string;
    jsonText: string;
    chatId?: string;
  }): PrototypeImportResult {
    const trimmed = input.jsonText.trim();
    if (!trimmed) {
      throw new Error("Import payload is empty.");
    }

    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (parsed.spec === "chara_card_v3") {
      const imported = importCharacterCardV3Json(parsed);
      this.store.upsertCharacter(imported.character);
      this.store.upsertCharacterVersion(imported.version);
      this.characters.set(
        imported.character.id,
        toCharacterRecord(imported.character, imported.version),
      );

      const created = this.chatApp.createChat({
        characterId: imported.character.id,
        personaId: "persona_explorer",
        title: imported.character.name,
        generationPresetId: "preset_default",
        toolProfileId: "tools_disabled",
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
    this.importedLoreEntriesByCharacter.set(
      chat.characterId,
      this.store.listLoreEntriesForCharacter(chat.characterId),
    );

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

  private seed(): void {
    const existingChats = this.store
      .listChats()
      .filter((chat) => this.characters.has(chat.characterId));
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
      content: trimmed,
    });
    this.persistPromptTrace(message.id, assembled.promptTraceDraft);
  }

  private ensurePrototypeReferences(): void {
    this.store.upsertPersona(this.defaultPersona);
    this.store.upsertGenerationPreset(this.defaultPreset);
    this.store.upsertToolProfile(this.defaultToolProfile);
  }

  private restoreImportedDataFromStore(): void {
    for (const character of this.store.listCharacters()) {
      const version = this.store.getLatestCharacterVersion(character.id);
      this.characters.set(character.id, toCharacterRecord(character, version));
      this.importedLoreEntriesByCharacter.set(
        character.id,
        this.store.listLoreEntriesForCharacter(character.id),
      );
    }
  }

  private assemblePrompt(
    chatId: ChatId,
    branchId?: ChatBranchId,
    options?: { excludeMessageIds?: MessageId[] },
  ) {
    return this.promptService.assembleForChat({
      chatId,
      branchId,
      outputConstraints: "Reply in 1-3 paragraphs.",
      excludeMessageIds: options?.excludeMessageIds,
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

  private toChatListItem(chatId: ChatId): PrototypeChatListItem {
    const chat = this.store.getChat(chatId)!;
    const branchState = this.store.getBranchState(chat.id, chat.activeBranchId)!;
    const character = this.resolver.getCharacter(chat.characterId);
    return {
      id: chat.id,
      title: chat.title,
      characterName: character.name,
      subtitle: character.subtitle,
      activeBranchLabel: branchState.branch.label,
      messageCount: branchState.messages.length,
    };
  }

  private toClientProviderProfile(profile: StoredProviderProfileRecord): ClientProviderProfileRecord {
    return {
      id: profile.id,
      name: profile.name,
      type: profile.type,
      endpoint: profile.endpoint,
      defaultModel: profile.defaultModel ?? null,
      contextBudget: profile.contextBudget ?? null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      hasStoredApiKey: Boolean(profile.apiKey),
    };
  }

  private resolveStoredApiKey(input: unknown, fallback: string | null): string | null {
    if (input === null) {
      return null;
    }

    if (typeof input === "string") {
      const trimmed = input.trim();
      return trimmed || fallback;
    }

    return fallback;
  }
}

function summarizeBranch(messages: Message[]): string {
  const slice = messages.slice(-4);
  const parts = slice.map((message) => {
    const speaker = message.role === "user" ? "User" : "Character";
    return `${speaker}: ${message.content.replace(/\s+/g, " ").trim()}`;
  });
  return parts.join(" ");
}

function synthesizeAssistantReply(input: {
  characterName: string;
  userText: string;
  prompt: AssemblePromptResponse;
}): string {
  const firstLore = input.prompt.activatedLoreEntries[0];
  const retrieval = input.prompt.retrievedMemories[0] as
    | { sourceType?: string; score?: number }
    | undefined;

  const loreSentence = firstLore
    ? `${input.characterName} responds with the active scene context still pressing at the edges.`
    : `${input.characterName} answers without breaking the current scene.`;
  const memorySentence = retrieval?.sourceType
    ? `The reply is shaped by ${retrieval.sourceType} recall rather than generic filler.`
    : "The reply stays close to the immediate exchange.";

  return `${loreSentence}\n\nShe studies your words: "${input.userText}". ${memorySentence} The next beat lands a little closer, a little more precise, as if the room itself is listening for what you say next.`;
}

function createDefaultPrototypeStore(): ChatSessionStore {
  const storeMode = (process.env.RP_PLATFORM_CHAT_STORE ?? "sqlite").toLowerCase();
  if (storeMode === "memory" || storeMode === "in-memory") {
    return new InMemoryChatSessionStore();
  }

  try {
    const dbPath = resolve(process.cwd(), process.env.RP_PLATFORM_DB_PATH ?? "data/prototype.sqlite");
    mkdirSync(dirname(dbPath), {
      recursive: true,
    });

    const adapter = new NodeSqliteDatabaseAdapter(dbPath);
    applySqliteMigrations(adapter);
    return new SqliteChatSessionStore(adapter);
  } catch (error) {
    console.warn(
      `Falling back to in-memory chat store because SQLite initialization failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return new InMemoryChatSessionStore();
  }
}

function mapPromptTraceRecord(trace: PromptTrace): PromptTraceRecordDto {
  return {
    id: trace.id,
    chatId: trace.chatId,
    branchId: trace.branchId,
    messageId: trace.messageId,
    model: trace.model,
    presetName: trace.presetName,
    latencyMs: trace.latencyMs,
    createdAt: trace.createdAt,
    layers: trace.assembledLayers as PromptTraceRecordDto["layers"],
    tokenAccounting: trace.tokenAccounting,
    activatedLoreEntries: trace.activatedLoreEntries,
    retrievedMemories: trace.retrievedMemories,
    finalPayload: trace.finalPayload,
  };
}

function entryMatchesRecentText(entry: LoreEntry, lowerText: string): boolean {
  if (!entry.enabled) {
    return false;
  }

  const primaryMatched =
    entry.keys.length === 0
      ? Boolean((entry.metadata.stConstant as boolean | undefined) ?? false)
      : entry.keys.some((key) => lowerText.includes(key.toLowerCase()));

  if (!primaryMatched) {
    return false;
  }

  if (entry.secondaryKeys.length === 0) {
    return true;
  }

  const matchedSecondary = entry.secondaryKeys.filter((key) =>
    lowerText.includes(key.toLowerCase()),
  );

  switch (entry.logic) {
    case "and_all":
      return matchedSecondary.length === entry.secondaryKeys.length;
    case "not_all":
      return matchedSecondary.length < entry.secondaryKeys.length;
    case "not_any":
      return matchedSecondary.length === 0;
    case "and_any":
    default:
      return matchedSecondary.length > 0;
  }
}

function toCharacterRecord(
  character: Character,
  version: CharacterVersion | null,
): CharacterRecord {
  const definition = version?.definition ?? {};
  const data =
    definition && typeof definition.data === "object" && definition.data !== null
      ? (definition.data as Record<string, unknown>)
      : definition;
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const subtitleCandidate =
    (typeof data.character_version === "string" && data.character_version.trim()) ||
    tags[0] ||
    version?.title ||
    "Imported character";

  return {
    id: character.id,
    name: character.name,
    description: character.description,
    scenario: character.defaultScenario ?? "",
    systemPrompt: (data.system_prompt as string) || "",
    subtitle: subtitleCandidate,
  };
}

function applyCharacterEditsToDefinition(
  definition: Record<string, unknown>,
  input: {
    name: string;
    description: string;
    scenario: string;
  },
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
  const nestedData = cloned.data;
  const target =
    typeof nestedData === "object" && nestedData !== null && !Array.isArray(nestedData)
      ? (nestedData as Record<string, unknown>)
      : cloned;

  cloned.name = input.name;
  cloned.description = input.description;
  cloned.scenario = input.scenario;
  target.name = input.name;
  target.description = input.description;
  target.scenario = input.scenario;
  return cloned;
}

function mapPrototypeMessage(message: Message, variants: MessageVariant[]): PrototypeMessageDto {
  const selectedVariant = variants.find((variant) => variant.isSelected) ?? null;
  return {
    ...message,
    content: selectedVariant?.content ?? message.content,
    variants,
    selectedVariantIndex: selectedVariant?.variantIndex ?? null,
  };
}
