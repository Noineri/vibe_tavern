import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { type StoreContainer, type FileStore, STORAGE_FOLDERS } from "@vibe-tavern/db";
import type {
	ChatId,
	PersonaId,
	PromptPresetId,
} from "@vibe-tavern/domain";
import { brandId, type CharacterId } from "@vibe-tavern/domain";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import {
	importCharacterCardV3Json,
	parseSillyTavernChat,
	serializeSillyTavernChat,
} from "@vibe-tavern/import-export";
import type { ChatApplicationService } from "../domain/chat/chat-application-service.js";
import { notFound, validation } from "../errors.js";
import type { CharacterRecord } from "../domain/character/character-runtime.js";

export interface ImportExportResolver {
	getCharacter(characterId: string): Promise<CharacterRecord>;
	getPersona(
		personaId: string,
	): Promise<{ id: string; name: string; description: string } | null>;
}

export interface ImportExportModuleDeps {
	stores: StoreContainer;
	resolver: ImportExportResolver;
	chatApp: ChatApplicationService;
	chatOrder: IChatOrder;
	fileStore: FileStore;
	resolveDefaultPersonaId(): Promise<PersonaId>;
	resolveDefaultPromptPresetId(): Promise<PromptPresetId>;
	getSnapshot(chatId: ChatId): Promise<import("./session-runtime.js").SessionSnapshot>;
	seedImportedOpening(chatId: ChatId, firstMessage: string, alternateGreetings?: string[]): Promise<void>;
}

export interface ImportResult {
	activeChatId: ChatId;
	snapshot: import("./session-runtime.js").SessionSnapshot;
	imported: {
		kind: "character" | "lorebook" | "chat";
		name: string;
		fileName: string;
		warningCount: number;
		warnings: string[];
		attachedToCharacterName?: string;
	};
}

export async function exportCharacter(
	deps: ImportExportModuleDeps,
	characterId: string,
): Promise<Record<string, unknown>> {
	const character = await deps.stores.characters.getById(characterId);
	if (!character) {
		throw notFound("Character", `Character '${characterId}' was not found.`);
	}

	let characterRecord: CharacterRecord | null = null;
	try {
		characterRecord = await deps.resolver.getCharacter(characterId);
	} catch {}

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

	// Merge original unknown fields for lossless round-trip
	const original = await deps.stores.content.readEntity<Record<string, unknown>>(
		STORAGE_FOLDERS.characters,
		`${characterId}/original`,
	);
	if (original) {
		// Original wins for unknown fields, current data wins for known fields
		const origData = (original as Record<string, unknown>).data as Record<string, unknown> | undefined;
		const mergedData = { ...(origData ?? {}), ...data };
		return { ...(original as Record<string, unknown>), data: mergedData };
	}

	return {
		spec: "chara_card_v3",
		spec_version: "3.0",
		data,
	};
}

export async function exportChatJsonl(
	deps: ImportExportModuleDeps,
	chatId: string,
): Promise<string> {
	const chat = await deps.stores.chats.getById(chatId as ChatId);
	if (!chat) {
		throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}
	const messages = await deps.stores.chats.getMessages(chat.activeBranchId);

	const { characterName, userName } = await resolveChatNames(deps, chat.characterId, chat.personaId);

	return serializeSillyTavernChat({
		userName,
		characterName,
		messages: await Promise.all(messages.map(async (message) => {
			const variants = await deps.stores.chats.getVariants(message.id);
			const swipes = variants.length > 1 ? variants.map((v) => v.content) : undefined;
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
		})),
	});
}

export async function exportPromptTrace(
	deps: ImportExportModuleDeps,
	traceId: string,
): Promise<import("@vibe-tavern/domain").PromptTraceRecordDto> {
	const trace = await deps.stores.chats.getTrace(traceId);
	if (!trace) {
		throw notFound("PromptTrace", `Prompt trace '${traceId}' was not found.`);
	}
	return {
		id: trace.id,
		chatId: trace.chatId as import("@vibe-tavern/domain").ChatId,
		branchId: trace.branchId as import("@vibe-tavern/domain").ChatBranchId,
		messageId: trace.messageId as import("@vibe-tavern/domain").MessageId,
		model: trace.model,
		presetName: trace.presetName,
		latencyMs: trace.latencyMs,
		createdAt: trace.createdAt,
		layers: trace.assembledLayers as import("@vibe-tavern/domain").PromptTraceRecordDto["layers"],
		tokenAccounting: trace.tokenAccounting,
		activatedLoreEntries: trace.activatedLoreEntries as string[],
		scriptInjections: trace.scriptInjections as import("@vibe-tavern/domain").PromptTraceRecordDto["scriptInjections"],
		retrievedMemories: trace.retrievedMemories as Array<Record<string, unknown>>,
		finalPayload: trace.finalPayload,
		compactionSummary: trace.compactionSummary ?? null,
		sentConfig: trace.sentConfig ?? undefined,
	};
}

export async function mirrorChatTranscript(
	deps: ImportExportModuleDeps,
	chatId: string,
): Promise<string[]> {
	const chat = await deps.stores.chats.getById(chatId as ChatId);
	if (!chat) {
		throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}

	const branches = await deps.stores.chats.getBranches(chat.id);
	const { characterName, userName } = await resolveChatNames(deps, chat.characterId, chat.personaId);

	const writtenPaths: string[] = [];
	for (const branch of branches) {
		const messages = await deps.stores.chats.getMessages(branch.id);

		const jsonl = serializeSillyTavernChat({
			userName,
			characterName,
			messages: await Promise.all(messages.map(async (message) => {
				const variants = await deps.stores.chats.getVariants(message.id);
				const swipes = variants.length > 1 ? variants.map((v) => v.content) : undefined;
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
			})),
		});

		const filePath = deps.fileStore.resolvePath(
			STORAGE_FOLDERS.chatMirrors,
			`${chatId}/branches/${branch.id}.jsonl`,
		);
		const dir = resolve(filePath, "..");
		await mkdir(dir, { recursive: true });
		await Bun.write(filePath, jsonl);
		writtenPaths.push(filePath);
	}

	return writtenPaths;
}

export async function mirrorPromptTrace(
	deps: ImportExportModuleDeps,
	traceId: string,
): Promise<string> {
	const trace = await deps.stores.chats.getTrace(traceId);
	if (!trace) {
		throw notFound("PromptTrace", `Prompt trace '${traceId}' was not found.`);
	}
	const date = trace.createdAt.split("T")[0];
	const filePath = deps.fileStore.resolvePath(
		STORAGE_FOLDERS.traces,
		`${date}/${traceId}.json`,
	);
		await deps.fileStore.writeJson(filePath, trace);
	return filePath;
}

export async function importJson(
	deps: ImportExportModuleDeps,
	input: {
		fileName: string;
		jsonText: string;
		chatId?: string;
		skipExisting?: boolean;
	},
): Promise<ImportResult> {
	const trimmed = input.jsonText.trim();
	if (!trimmed) {
		throw validation("Import payload is empty.");
	}

	if (input.fileName.toLowerCase().endsWith(".jsonl")) {
		return importSillyTavernChat(deps, input.fileName, trimmed, input.chatId);
	}

	const parsed = JSON.parse(trimmed) as Record<string, unknown>;

	const isCharacterCard = parsed.spec === "chara_card_v3" || parsed.spec === "chara_card_v2" || (parsed.name && !parsed.spec);

	if (isCharacterCard) {
		const imported = importCharacterCardV3Json(parsed);

		// Upsert character via new CharacterStore
		const existing = await deps.stores.characters.getById(imported.character.id);
		let characterId: string;

		if (existing && input.skipExisting) {
			// Character already imported — skip, return existing snapshot
			const existingChats = await deps.stores.chats.listByCharacter(imported.character.id);
			const lastChat = existingChats[existingChats.length - 1];
			const chatId = lastChat?.id ?? (await deps.chatApp.createChat({
				characterId: imported.character.id as CharacterId,
				personaId: await deps.resolveDefaultPersonaId(),
				title: imported.character.name,
				promptPresetId: await deps.resolveDefaultPromptPresetId(),
			})).id as ChatId;

			// Update character data in case card was updated
			await deps.stores.characters.update(imported.character.id, {
				name: imported.character.name,
				description: imported.character.description,
				personalitySummary: imported.character.personalitySummary,
				defaultScenario: imported.character.defaultScenario,
				firstMessage: imported.character.firstMessage,
				mesExample: imported.character.mesExample,
				alternateGreetings: imported.character.alternateGreetings,
				postHistoryInstructions: imported.character.postHistoryInstructions,
				creatorNotes: imported.character.creatorNotes,
				characterBook: imported.character.characterBook,
				depthPrompt: imported.character.depthPrompt,
				depthPromptDepth: imported.character.depthPromptDepth,
				depthPromptRole: imported.character.depthPromptRole,
				extensions: imported.character.extensions,
				systemPrompt: imported.character.systemPrompt,
				tags: imported.character.tags,
			});
			// Save original JSON for lossless round-trip
			await deps.stores.content.writeEntity(STORAGE_FOLDERS.characters, `${imported.character.id}/original`, parsed);

			return {
				activeChatId: chatId as ChatId,
				snapshot: await deps.getSnapshot(chatId as ChatId),
				imported: {
					kind: "character",
					name: imported.character.name,
					fileName: input.fileName,
					warningCount: imported.warnings.length,
					warnings: imported.warnings,
				},
			};
		}

		if (existing) {
			characterId = imported.character.id;
			await deps.stores.characters.update(imported.character.id, {
				name: imported.character.name,
				description: imported.character.description,
				personalitySummary: imported.character.personalitySummary,
				defaultScenario: imported.character.defaultScenario,
				firstMessage: imported.character.firstMessage,
				mesExample: imported.character.mesExample,
				alternateGreetings: imported.character.alternateGreetings,
				postHistoryInstructions: imported.character.postHistoryInstructions,
				creatorNotes: imported.character.creatorNotes,
				characterBook: imported.character.characterBook,
				depthPrompt: imported.character.depthPrompt,
				depthPromptDepth: imported.character.depthPromptDepth,
				depthPromptRole: imported.character.depthPromptRole,
				extensions: imported.character.extensions,
				systemPrompt: imported.character.systemPrompt,
				tags: imported.character.tags,
			});
			// Save original JSON for lossless round-trip
			await deps.stores.content.writeEntity(STORAGE_FOLDERS.characters, `${characterId}/original`, parsed);
			} else {
			const created = await deps.stores.characters.create({
				name: imported.character.name,
				description: imported.character.description,
				personalitySummary: imported.character.personalitySummary,
				defaultScenario: imported.character.defaultScenario,
				firstMessage: imported.character.firstMessage,
				mesExample: imported.character.mesExample,
				alternateGreetings: imported.character.alternateGreetings,
				postHistoryInstructions: imported.character.postHistoryInstructions,
				creatorNotes: imported.character.creatorNotes,
				characterBook: imported.character.characterBook,
				depthPrompt: imported.character.depthPrompt,
				depthPromptDepth: imported.character.depthPromptDepth,
				depthPromptRole: imported.character.depthPromptRole,
				extensions: imported.character.extensions,
				systemPrompt: imported.character.systemPrompt,
				tags: imported.character.tags,
			});
			characterId = created.id;
			// Save original JSON for lossless round-trip
			await deps.stores.content.writeEntity(STORAGE_FOLDERS.characters, `${characterId}/original`, parsed);
			}

		const chat = await deps.chatApp.createChat({
			characterId: characterId as CharacterId,
			personaId: await deps.resolveDefaultPersonaId(),
			title: imported.character.name,
			promptPresetId: await deps.resolveDefaultPromptPresetId(),
		});

		const createdId = chat.id as ChatId;
		deps.chatOrder.add(createdId);
		await deps.seedImportedOpening(createdId, imported.normalized.firstMessage, imported.normalized.alternateGreetings);

		return {
			activeChatId: createdId,
			snapshot: await deps.getSnapshot(createdId),
			imported: {
				kind: "character",
				name: imported.character.name,
				fileName: input.fileName,
				warningCount: imported.warnings.length,
				warnings: imported.warnings,
			},
		};
	}

	// Lorebook import — phase 2
	throw validation("Lorebook import is not supported in phase 1.");
}

async function importSillyTavernChat(
	deps: ImportExportModuleDeps,
	fileName: string,
	jsonlContent: string,
	sourceChatId?: string,
): Promise<ImportResult> {
	if (!sourceChatId) {
		throw validation("Select a character/chat before importing a SillyTavern JSONL chat.");
	}

	const sourceChat = await deps.stores.chats.getById(sourceChatId as ChatId);
	if (!sourceChat) {
		throw notFound("Chat", `Chat '${sourceChatId}' was not found.`);
	}

	const parsed = parseSillyTavernChat(jsonlContent);
	const importedMessages = parsed.messages.filter((message) => message.content.trim());
	if (importedMessages.length === 0) {
		throw validation("No messages were found in the SillyTavern JSONL file.");
	}

	const title = fileName.replace(/\.jsonl$/i, "") || parsed.metadata.characterName || sourceChat.title;
	const chat = await deps.chatApp.createChat({
		characterId: sourceChat.characterId as CharacterId,
		personaId: (sourceChat.personaId as PersonaId | null) ?? await deps.resolveDefaultPersonaId(),
		title,
		promptPresetId: sourceChat.promptPresetId as PromptPresetId,
	});
	const createdId = chat.id as ChatId;
	deps.chatOrder.add(createdId);

	for (const imported of importedMessages) {
		const selectedVariant = imported.variants.find((variant) => variant.isSelected) ?? imported.variants[0];
		const variants = imported.variants.length > 0 ? imported.variants : [{ content: imported.content, isSelected: true }];
		const message = await deps.stores.chats.addMessage({
			chatId: createdId,
			branchId: chat.activeBranchId,
			role: imported.role,
			authorType: imported.role === "user" ? "user" : imported.role === "system" ? "system" : "assistant",
			content: variants[0]?.content ?? imported.content,
		});
		for (const variant of variants.slice(1)) {
			await deps.stores.chats.addVariant(message.id, variant.content, undefined, variant.reasoning);
		}
		const selectedIndex = variants.findIndex((variant) => variant.content === selectedVariant?.content);
		if (selectedIndex > 0) {
			await deps.stores.chats.selectVariant(message.id, selectedIndex);
		}
	}

	return {
		activeChatId: createdId,
		snapshot: await deps.getSnapshot(createdId),
		imported: {
			kind: "chat",
			name: title,
			fileName,
			warningCount: 0,
			warnings: [],
			attachedToCharacterName: parsed.metadata.characterName,
		},
	};
}

async function resolveChatNames(
	deps: ImportExportModuleDeps,
	characterId: string,
	personaId: string | null,
): Promise<{ characterName: string; userName: string }> {
	let characterName = "Assistant";
	try {
		characterName = (await deps.resolver.getCharacter(characterId)).name;
	} catch {}
	const persona = await deps.resolver.getPersona(
		personaId ?? (await deps.resolveDefaultPersonaId()) as string,
	);
	const userName = persona?.name ?? "User";
	return { characterName, userName };
}
