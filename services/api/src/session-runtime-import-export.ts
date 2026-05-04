import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { type StoreContainer, type createFileStore, STORAGE_FOLDERS } from "@rp-platform/db";
import type {
	ChatId,
	PersonaId,
	PromptPresetId,
} from "@rp-platform/domain";
import { brandId, type CharacterId } from "@rp-platform/domain";
import { serializeSillyTavernChat } from "../../../packages/import-export/src/chats/st-chat.js";
import {
	importCharacterCardV3Json,
} from "../../../packages/import-export/src/index.js";
import type { ChatApplicationService } from "./chat-application-service.js";
import { notFound, validation } from "./errors.js";
import type { CharacterRecord } from "./session-runtime-character.js";

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
	chatOrder: ChatId[];
	fileStore: ReturnType<typeof createFileStore>;
	resolveDefaultPersonaId(): Promise<PersonaId>;
	resolveDefaultPromptPresetId(): Promise<PromptPresetId>;
	getSnapshot(chatId: ChatId): Promise<import("./session-runtime.js").SessionSnapshot>;
	seedImportedOpening(chatId: ChatId, firstMessage: string): Promise<void>;
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
): Promise<import("@rp-platform/domain").PromptTraceRecordDto> {
	const trace = await deps.stores.chats.getTrace(traceId);
	if (!trace) {
		throw notFound("PromptTrace", `Prompt trace '${traceId}' was not found.`);
	}
	return {
		id: trace.id,
		chatId: trace.chatId as import("@rp-platform/domain").ChatId,
		branchId: trace.branchId as import("@rp-platform/domain").ChatBranchId,
		messageId: trace.messageId as import("@rp-platform/domain").MessageId,
		model: trace.model,
		presetName: trace.presetName,
		latencyMs: trace.latencyMs,
		createdAt: trace.createdAt,
		layers: trace.assembledLayers as import("@rp-platform/domain").PromptTraceRecordDto["layers"],
		tokenAccounting: trace.tokenAccounting,
		activatedLoreEntries: [],
		retrievedMemories: [],
		finalPayload: trace.finalPayload,
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
		throw validation("Import payload is empty.");
	}

	const parsed = JSON.parse(trimmed) as Record<string, unknown>;

	if (parsed.spec === "chara_card_v3") {
		const imported = importCharacterCardV3Json(parsed);

		// Upsert character via new CharacterStore
		const existing = await deps.stores.characters.getById(imported.character.id);
		let characterId: string;
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
			}

		const chat = await deps.chatApp.createChat({
			characterId: characterId as CharacterId,
			personaId: await deps.resolveDefaultPersonaId(),
			title: imported.character.name,
			promptPresetId: await deps.resolveDefaultPromptPresetId(),
		});

		const createdId = chat.id as ChatId;
		deps.chatOrder.unshift(createdId);
		await deps.seedImportedOpening(createdId, imported.normalized.firstMessage);

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
