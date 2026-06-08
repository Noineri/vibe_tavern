import type { Character, CharacterVersion, CharacterId, ChatId, PersonaId, PromptPresetId } from "@vibe-tavern/domain";
import type { ChatStore, CharacterStore, StoreContainer } from "@vibe-tavern/db";
import type { ChatApplicationService } from "../chat/chat-application-service.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import type { SessionSnapshot, ImportResult } from "./session-runtime.js";
import { notFound, validation } from "../errors.js";
import { brandId } from "@vibe-tavern/domain";

export type CharacterRecord = {
  id: string;
  name: string;
  description: string;
  scenario: string;
  systemPrompt: string;
  personality: string | null;
  personalitySummary: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  characterBook: Record<string, unknown> | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  extensions: Record<string, unknown>;
  tags: string[];
  subtitle: string;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
};

export type PersonaRecord = {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
};

export function toCharacterRecord(
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
    "";

  return {
    id: character.id,
    name: character.name,
    description: character.description,
    scenario: character.defaultScenario ?? "",
    systemPrompt: character.systemPrompt ?? ((data.system_prompt as string) || ""),
    personality: character.personalitySummary ?? ((data.personality as string) || null),
    personalitySummary: character.personalitySummary ?? ((data.personality as string) || null),
    firstMessage: character.firstMessage,
    mesExample: character.mesExample,
    mesExampleMode: character.mesExampleMode,
    mesExampleDepth: character.mesExampleDepth,
    alternateGreetings: character.alternateGreetings,
    postHistoryInstructions: character.postHistoryInstructions,
    creatorNotes: character.creatorNotes,
    characterBook: character.characterBook,
    depthPrompt: character.depthPrompt,
    depthPromptDepth: character.depthPromptDepth,
    depthPromptRole: character.depthPromptRole,
    extensions: character.extensions,
    tags: character.tags,
    subtitle: subtitleCandidate,
    avatarAssetId: character.avatarAssetId,
    avatarFullAssetId: character.avatarFullAssetId,
    avatarCropJson: character.avatarCropJson,
  };
}

export function applyCharacterEditsToDefinition(
  definition: Record<string, unknown>,
  input: {
    name: string;
    description: string;
    personalitySummary: string | null;
    scenario: string;
    systemPrompt: string;
    firstMessage: string | null;
    mesExample: string | null;
    mesExampleMode?: string;
    mesExampleDepth?: number;
    alternateGreetings: string[];
    postHistoryInstructions: string | null;
    creatorNotes: string | null;
    characterBook: Record<string, unknown> | null;
    depthPrompt: string | null;
    depthPromptDepth: number | null;
    depthPromptRole: string | null;
    extensions: Record<string, unknown>;
    tags: string[];
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
  cloned.personality = input.personalitySummary;
  cloned.scenario = input.scenario;
  cloned.system_prompt = input.systemPrompt;
  cloned.first_mes = input.firstMessage;
  cloned.mes_example = input.mesExample;
  if (input.mesExampleMode !== undefined) cloned.mes_example_mode = input.mesExampleMode;
  if (input.mesExampleDepth !== undefined) cloned.mes_example_depth = input.mesExampleDepth;
  cloned.alternate_greetings = input.alternateGreetings;
  cloned.post_history_instructions = input.postHistoryInstructions;
  cloned.creator_notes = input.creatorNotes;
  cloned.character_book = input.characterBook;
  cloned.depth_prompt = input.depthPrompt;
  cloned.depth_prompt_depth = input.depthPromptDepth;
  cloned.depth_prompt_role = input.depthPromptRole;
  cloned.extensions = input.extensions;
  cloned.tags = input.tags;
  target.name = input.name;
  target.description = input.description;
  target.personality = input.personalitySummary;
  target.scenario = input.scenario;
  target.system_prompt = input.systemPrompt;
  target.first_mes = input.firstMessage;
  target.mes_example = input.mesExample;
  if (input.mesExampleMode !== undefined) target.mes_example_mode = input.mesExampleMode;
  if (input.mesExampleDepth !== undefined) target.mes_example_depth = input.mesExampleDepth;
  target.alternate_greetings = input.alternateGreetings;
  target.post_history_instructions = input.postHistoryInstructions;
  target.creator_notes = input.creatorNotes;
  target.character_book = input.characterBook;
  target.depth_prompt = input.depthPrompt;
  target.depth_prompt_depth = input.depthPromptDepth;
  target.depth_prompt_role = input.depthPromptRole;
  target.extensions = input.extensions;
  target.tags = input.tags;
  return cloned;
}

export interface CharacterRuntimeDeps {
  stores: StoreContainer;
  chatApp: ChatApplicationService;
  chatOrder: IChatOrder;
  getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
  resolveDefaultPersonaId: () => Promise<PersonaId>;
  resolveDefaultPromptPresetId: () => Promise<PromptPresetId>;
  seedImportedOpening: (chatId: ChatId, firstMessage: string, alternateGreetings?: string[]) => Promise<void>;
  discardPendingPromptTrace: (chatId: ChatId) => void;
}

export class CharacterRuntime {
  private readonly deps: CharacterRuntimeDeps;

  constructor(deps: CharacterRuntimeDeps) {
    this.deps = deps;
  }

  async archive(characterId: string): Promise<{
    characterId: string;
    status: "archived";
  }> {
    const typedCharacterId = brandId<CharacterId>(characterId);
    await this.deps.stores.characters.archive(typedCharacterId);
    const chatIds = (await this.deps.stores.chats.listAll())
      .filter((c) => c.characterId === typedCharacterId)
      .map((c) => c.id as ChatId);
    for (const chatId of chatIds) {
      this.deps.chatOrder.remove(chatId);
    }
    return { characterId, status: "archived" };
  }

  async unarchive(characterId: string): Promise<{
    characterId: string;
    status: "active";
  }> {
    await this.deps.stores.characters.unarchive(brandId<CharacterId>(characterId));
    return { characterId, status: "active" };
  }

  async delete(characterId: string): Promise<void> {
    const typedCharacterId = brandId<CharacterId>(characterId);
    const chatIds = (await this.deps.stores.chats.listAll())
      .filter((c) => c.characterId === typedCharacterId)
      .map((c) => c.id as ChatId);
    for (const chatId of chatIds) {
      this.deps.chatOrder.remove(chatId);
      this.deps.discardPendingPromptTrace(chatId);
    }
    await this.deps.stores.characters.delete(typedCharacterId);
  }

  async createFromScratch(input: {
    name: string;
    description?: string;
    personalitySummary?: string | null;
    scenario?: string | null;
    firstMessage?: string;
    mesExample?: string | null;
    mesExampleMode?: string;
    mesExampleDepth?: number;
    alternateGreetings?: string[];
    postHistoryInstructions?: string | null;
    creatorNotes?: string | null;
    systemPrompt?: string | null;
    depthPrompt?: string | null;
    depthPromptDepth?: number | null;
    depthPromptRole?: string | null;
    tags?: string[];
  }): Promise<ImportResult> {
    const character = await this.deps.stores.characters.create({
      name: input.name,
      description: input.description,
      personalitySummary: input.personalitySummary,
      defaultScenario: input.scenario,
      firstMessage: input.firstMessage,
      mesExample: input.mesExample,
      mesExampleMode: input.mesExampleMode,
      mesExampleDepth: input.mesExampleDepth,
      alternateGreetings: input.alternateGreetings,
      postHistoryInstructions: input.postHistoryInstructions,
      creatorNotes: input.creatorNotes,
      systemPrompt: input.systemPrompt,
      depthPrompt: input.depthPrompt,
      depthPromptDepth: input.depthPromptDepth,
      depthPromptRole: input.depthPromptRole,
      tags: input.tags,
    });

    const characterId = character.id as CharacterId;

    const created = await this.deps.chatApp.createChat({
      characterId,
      personaId: await this.deps.resolveDefaultPersonaId(),
      title: input.name,
      promptPresetId: await this.deps.resolveDefaultPromptPresetId(),
    });

    const createdChatId = created.id;
    this.deps.chatOrder.add(createdChatId);

    if (input.firstMessage?.trim()) {
      await this.deps.seedImportedOpening(createdChatId, input.firstMessage, input.alternateGreetings ?? []);
    }

    return {
      activeChatId: createdChatId,
      snapshot: await this.deps.getSnapshot(createdChatId),
      imported: {
        kind: "character",
        name: input.name,
        fileName: "",
        warningCount: 0,
        warnings: [],
      },
    };
  }

  async update(
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
      mesExampleMode?: string;
      mesExampleDepth?: number;
      alternateGreetings?: string[];
      postHistoryInstructions?: string | null;
      creatorNotes?: string | null;
      characterBook?: Record<string, unknown> | null;
      depthPrompt?: string | null;
      depthPromptDepth?: number | null;
      depthPromptRole?: string | null;
      extensions?: Record<string, unknown>;
      tags?: string[];
      avatarAssetId?: string | null;
      avatarFullAssetId?: string | null;
      avatarCropJson?: string | null;
    },
    options?: {
      rebuildChatOrder: () => Promise<void>;
    },
  ): Promise<SessionSnapshot> {
    const currentCharacter = await this.deps.stores.characters.getById(characterId);
    if (!currentCharacter) {
      throw notFound("Character", `Character '${characterId}' was not found.`);
    }

    const nextName = (input.name ?? currentCharacter.name).trim();
    if (!nextName) {
      throw validation("Character name is required.");
    }

    await this.deps.stores.characters.update(characterId, {
      name: nextName,
      description: input.description ?? currentCharacter.description,
      personalitySummary: input.personalitySummary !== undefined
        ? input.personalitySummary
        : currentCharacter.personalitySummary,
      defaultScenario: input.scenario ?? currentCharacter.defaultScenario ?? "",
      firstMessage: input.firstMessage !== undefined
        ? input.firstMessage
        : currentCharacter.firstMessage,
      mesExample: input.mesExample !== undefined
        ? input.mesExample
        : currentCharacter.mesExample,
      mesExampleMode: input.mesExampleMode !== undefined
        ? input.mesExampleMode
        : currentCharacter.mesExampleMode,
      mesExampleDepth: input.mesExampleDepth !== undefined
        ? input.mesExampleDepth
        : currentCharacter.mesExampleDepth,
      alternateGreetings: input.alternateGreetings ?? currentCharacter.alternateGreetings,
      postHistoryInstructions: input.postHistoryInstructions !== undefined
        ? input.postHistoryInstructions
        : currentCharacter.postHistoryInstructions,
      creatorNotes: input.creatorNotes !== undefined
        ? input.creatorNotes
        : currentCharacter.creatorNotes,
      characterBook: input.characterBook !== undefined
        ? input.characterBook
        : currentCharacter.characterBook,
      depthPrompt: input.depthPrompt !== undefined
        ? input.depthPrompt
        : currentCharacter.depthPrompt,
      depthPromptDepth: input.depthPromptDepth !== undefined
        ? input.depthPromptDepth
        : currentCharacter.depthPromptDepth,
      depthPromptRole: input.depthPromptRole !== undefined
        ? input.depthPromptRole
        : currentCharacter.depthPromptRole,
      extensions: input.extensions ?? currentCharacter.extensions,
      systemPrompt: input.systemPrompt ?? currentCharacter.systemPrompt,
      tags: input.tags ?? currentCharacter.tags,
      avatarAssetId: input.avatarAssetId !== undefined
        ? input.avatarAssetId
        : currentCharacter.avatarAssetId,
      avatarFullAssetId: input.avatarFullAssetId !== undefined
        ? input.avatarFullAssetId
        : currentCharacter.avatarFullAssetId,
      avatarCropJson: input.avatarCropJson !== undefined
        ? input.avatarCropJson
        : currentCharacter.avatarCropJson,
    });

    // Promote system character to user character on first edit
    if (currentCharacter.isSystem) {
      await this.deps.stores.characters.updateIsSystem(characterId, false);
      // Re-bootstrap chat order so the character appears in sidebar
      await options?.rebuildChatOrder?.();
    }

    const preferredChat = input.chatId
      ? await this.deps.stores.chats.getById(input.chatId)
      : null;
    const targetChatId =
      ((preferredChat?.characterId === characterId ? preferredChat.id : null) ??
      (await this.deps.stores.chats.listAll()).find((chat) => chat.characterId === characterId)?.id ??
      this.deps.chatOrder.items[0]) as ChatId | undefined;

    if (!targetChatId) {
      throw notFound("Chat", "No chat is available for the updated character.");
    }

    return this.deps.getSnapshot(targetChatId);
  }

  async duplicate(characterId: CharacterId): Promise<ImportResult> {
    const source = await this.deps.stores.characters.getById(characterId);
    if (!source) {
      throw notFound("Character", `Character '${characterId}' was not found.`);
    }

    const character = await this.deps.stores.characters.create({
      name: source.name + " (copy)",
      description: source.description,
      personalitySummary: source.personalitySummary,
      defaultScenario: source.defaultScenario,
      firstMessage: source.firstMessage,
      mesExample: source.mesExample,
      mesExampleMode: source.mesExampleMode,
      mesExampleDepth: source.mesExampleDepth,
      alternateGreetings: source.alternateGreetings,
      postHistoryInstructions: source.postHistoryInstructions,
      creatorNotes: source.creatorNotes,
      characterBook: source.characterBook,
      depthPrompt: source.depthPrompt,
      depthPromptDepth: source.depthPromptDepth,
      depthPromptRole: source.depthPromptRole,
      extensions: source.extensions,
      systemPrompt: source.systemPrompt,
      tags: source.tags,
      avatarAssetId: source.avatarAssetId,
      avatarFullAssetId: source.avatarFullAssetId,
      avatarCropJson: source.avatarCropJson,
    });

    const newCharacterId = character.id as CharacterId;

    // Duplicate character-scoped lorebooks
    const sourceLorebooks = await this.deps.stores.lorebooks.listLorebooksByScope("character", characterId);
    for (const lb of sourceLorebooks) {
      const entries = await this.deps.stores.lorebooks.listEntries(lb.id);
      const newLb = await this.deps.stores.lorebooks.createLorebook({
        name: lb.name,
        description: lb.description,
        scopeType: "character",
        characterId: newCharacterId,
        scanDepth: lb.scanDepth,
        recursiveScanning: lb.recursiveScanning,
        enabled: lb.enabled,
      });
      await this.deps.stores.lorebooks.bulkCreateEntries(newLb.id, entries.map(e => ({
        keys: e.keys,
        secondaryKeys: e.secondaryKeys,
        content: e.content,
        logic: e.logic,
        position: e.position,
        depth: e.depth,
        priority: e.priority,
        probability: e.probability,
        constant: e.constant,
        enabled: e.enabled,
        groupName: e.group,
        groupWeight: e.groupWeight,
        cooldownWindow: e.cooldownWindow,
        delayWindow: e.delayWindow,
        stickyWindow: e.stickyWindow,
        scanDepthOverride: e.scanDepthOverride,
        matchWholeWords: e.matchWholeWords,
        matchSources: e.matchSources,
        triggers: e.triggers,
        characterFilter: e.characterFilter,
        excludeRecursion: e.excludeRecursion,
        preventRecursion: e.preventRecursion,
        caseSensitive: e.caseSensitive,
      })));
    }

    // Duplicate character-scoped scripts
    const sourceScripts = await this.deps.stores.scripts.listByScope("character", characterId);
    for (const sc of sourceScripts) {
      await this.deps.stores.scripts.create({
        name: sc.name,
        description: sc.description,
        code: sc.code,
        scopeType: "character",
        characterId: newCharacterId,
        enabled: sc.enabled,
        sortOrder: sc.sortOrder,
      });
    }

    const created = await this.deps.chatApp.createChat({
      characterId: newCharacterId,
      personaId: await this.deps.resolveDefaultPersonaId(),
      title: character.name,
      promptPresetId: await this.deps.resolveDefaultPromptPresetId(),
    });

    const createdChatId = created.id;
    this.deps.chatOrder.add(createdChatId);

    if (source.firstMessage?.trim()) {
      await this.deps.seedImportedOpening(createdChatId, source.firstMessage, source.alternateGreetings);
    }

    return {
      activeChatId: createdChatId,
      snapshot: await this.deps.getSnapshot(createdChatId),
      imported: {
        kind: "character",
        name: character.name,
        fileName: "",
        warningCount: 0,
        warnings: [],
      },
    };
  }
}
