import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatSessionStore } from "@rp-platform/db";
import { brandId, SYSTEM_RESOURCE_ID } from "@rp-platform/domain";
import type {
  CharacterId,
  ChatId,
  Lorebook,
  PersonaId,
  PromptPresetId,
  PromptTraceId,
  ToolProfileId,
} from "@rp-platform/domain";
import {
  importCharacterCardV3Json,
  importStLorebookJson,
} from "../../../packages/import-export/src/index.js";
import { serializeSillyTavernChat } from "../../../packages/import-export/src/chats/st-chat.js";
import { createFileStore, STORAGE_FOLDERS } from "@rp-platform/db";
import {
  mapPromptTraceRecord,
} from "./session-runtime-dto.js";
import { ChatApplicationService } from "./chat-application-service.js";
import type { CharacterRecord } from "./session-runtime-character.js";

export interface ImportExportResolver {
  getCharacter(characterId: string): CharacterRecord;
  getPersona(personaId: string): { id: string; name: string; description: string } | null;
}

export interface ImportExportModuleDeps {
  store: ChatSessionStore;
  resolver: ImportExportResolver;
  chatApp: ChatApplicationService;
  chatOrder: ChatId[];
  fileStore: ReturnType<typeof createFileStore>;
  resolveDefaultPersonaId(): PersonaId;
  resolveDefaultPromptPresetId(): PromptPresetId;
  getSnapshot(chatId: ChatId): import("./session-runtime.js").SessionSnapshot;
  seedImportedOpening(chatId: ChatId, firstMessage: string): void;
}

export interface ImportResult {
  activeChatId: ChatId;
  snapshot: import("./session-runtime.js").SessionSnapshot;
  imported: {
    kind: "character" | "lorebook";
    name: string;
    fileName: string;
    warningCount: number;
    warnings: string[];
    attachedToCharacterName?: string;
  };
}

export function exportCharacter(deps: ImportExportModuleDeps, characterId: string): Record<string, unknown> {
  const character = deps.store.listCharacters().find((c) => c.id === characterId);
  if (!character) {
    throw new Error(`Character '${characterId}' was not found.`);
  }
  const version = deps.store.getLatestCharacterVersion(characterId as CharacterId);
  const definition = version?.definition;
  let characterRecord: CharacterRecord | null = null;
  try {
    characterRecord = deps.resolver.getCharacter(characterId);
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

export function exportChatJsonl(deps: ImportExportModuleDeps, chatId: string): string {
  const chat = deps.store.getChat(chatId as ChatId);
  if (!chat) {
    throw new Error(`Chat '${chatId}' was not found.`);
  }
  const branchState = deps.store.getBranchState(chat.id, chat.activeBranchId);
  if (!branchState) {
    throw new Error(`Branch '${chat.activeBranchId}' was not found for chat '${chatId}'.`);
  }

  let characterName = "Assistant";
  try {
    characterName = deps.resolver.getCharacter(chat.characterId).name;
  } catch {}
  const persona = deps.resolver.getPersona(chat.personaId ?? deps.resolveDefaultPersonaId());
  const userName = persona?.name ?? "User";

  return serializeSillyTavernChat({
    userName,
    characterName,
    messages: branchState.messages.map((message) => {
      const variants = deps.store.listMessageVariants(message.id);
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

export function exportPromptTrace(deps: ImportExportModuleDeps, traceId: string): import("@rp-platform/domain").PromptTraceRecordDto {
  const trace = deps.store.getPromptTrace(traceId as PromptTraceId);
  if (!trace) {
    throw new Error(`Prompt trace '${traceId}' was not found.`);
  }
  return mapPromptTraceRecord(trace);
}

export function mirrorChatTranscript(deps: ImportExportModuleDeps, chatId: string): string[] {
  const chat = deps.store.getChat(chatId as ChatId);
  if (!chat) {
    throw new Error(`Chat '${chatId}' was not found.`);
  }

  const branches = deps.store.listBranches(chat.id);
  let characterName = "Assistant";
  try {
    characterName = deps.resolver.getCharacter(chat.characterId).name;
  } catch {}
  const persona = deps.resolver.getPersona(chat.personaId ?? deps.resolveDefaultPersonaId());
  const userName = persona?.name ?? "User";

  const writtenPaths: string[] = [];
  for (const branch of branches) {
    const branchState = deps.store.getBranchState(chat.id, branch.id);
    if (!branchState) continue;

    const jsonl = serializeSillyTavernChat({
      userName,
      characterName,
      messages: branchState.messages.map((message) => {
        const variants = deps.store.listMessageVariants(message.id);
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

    const filePath = deps.fileStore.resolvePath(
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

export function mirrorPromptTrace(deps: ImportExportModuleDeps, traceId: string): string {
  const trace = deps.store.getPromptTrace(traceId as PromptTraceId);
  if (!trace) {
    throw new Error(`Prompt trace '${traceId}' was not found.`);
  }
  const date = trace.createdAt.split("T")[0];
  const filePath = deps.fileStore.resolvePath(
    STORAGE_FOLDERS.traces,
    `${date}/${traceId}.json`,
  );
  deps.fileStore.writeJson(filePath, trace);
  return filePath;
}

export async function importJson(
  deps: ImportExportModuleDeps,
  input: {
    fileName: string;
    jsonText: string;
    chatId?: string;
  },
): Promise<ImportResult> {
  const trimmed = input.jsonText.trim();
  if (!trimmed) {
    throw new Error("Import payload is empty.");
  }

  const parsed = JSON.parse(trimmed) as Record<string, unknown>;

  if (parsed.spec === "chara_card_v3") {
    const imported = importCharacterCardV3Json(parsed);
    await deps.store.upsertCharacter(imported.character);
    await deps.store.upsertCharacterVersion(imported.version);

    const created = deps.chatApp.createChat({
      characterId: imported.character.id,
      personaId: deps.resolveDefaultPersonaId(),
      title: imported.character.name,
      promptPresetId: deps.resolveDefaultPromptPresetId(),
      toolProfileId: brandId<ToolProfileId>(SYSTEM_RESOURCE_ID.toolsDisabled),
    });

    deps.chatOrder.unshift(created.id);
    deps.seedImportedOpening(created.id, imported.normalized.firstMessage);

    return {
      activeChatId: created.id,
      snapshot: deps.getSnapshot(created.id),
      imported: {
        kind: "character",
        name: imported.character.name,
        fileName: input.fileName,
        warningCount: imported.warnings.length,
        warnings: imported.warnings,
      },
    };
  }

  const rawActiveChatId = input.chatId ?? deps.chatOrder[0];
  if (!rawActiveChatId) {
    throw new Error("Import a character card first, then attach a lorebook to its chat.");
  }
  const activeChatId = brandId<ChatId>(rawActiveChatId);

  const imported = importStLorebookJson(parsed);
  const chat = deps.store.getChat(activeChatId);
  if (!chat) {
    throw new Error(`Chat '${activeChatId}' was not found for lorebook import.`);
  }

  const lorebook: Lorebook = imported.lorebook;
  deps.store.upsertLorebook(lorebook);
  deps.store.replaceLoreEntries(lorebook.id, imported.entries);
  deps.store.linkCharacterLorebook(chat.characterId, lorebook.id);

  return {
    activeChatId,
    snapshot: deps.getSnapshot(activeChatId),
    imported: {
      kind: "lorebook",
      name: imported.lorebook.name,
      fileName: input.fileName,
      warningCount: imported.warnings.length,
      warnings: imported.warnings,
      attachedToCharacterName: deps.resolver.getCharacter(chat.characterId).name,
    },
  };
}
