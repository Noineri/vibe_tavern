import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { CharacterStore, ChatStore } from "@rp-platform/db";
import { type createFileStore, STORAGE_FOLDERS } from "@rp-platform/db";
import type {
	ChatId,
	PersonaId,
	PromptPresetId,
} from "@rp-platform/domain";
import { brandId } from "@rp-platform/domain";
import { serializeSillyTavernChat } from "../../../packages/import-export/src/chats/st-chat.js";
import {
	importCharacterCardV3Json,
} from "../../../packages/import-export/src/index.js";
import type { ChatApplicationService } from "./chat-application-service.js";
import { notFound, validation } from "./errors.js";
import type { CharacterRecord } from "./session-runtime-character.js";

export interface ImportExportResolver {
	getCharacter(characterId: string): CharacterRecord;
	getPersona(
		personaId: string,
	): { id: string; name: string; description: string } | null;
}

export interface ImportExportModuleDeps {
	characters: CharacterStore;
	chats: ChatStore;
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

export async function exportCharacter(
	deps: ImportExportModuleDeps,
	characterId: string,
): Promise<Record<string, unknown>> {
	const character = await deps.characters.getById(characterId);
	if (!character) {
		throw notFound("Character", `Character '${characterId}' was not found.`);
	}

	// Phase 1: no character versions. Export from store fields directly.
	let characterRecord: CharacterRecord | null = null;
	try {
		characterRecord = deps.resolver.getCharacter(characterId);
	} catch {}

	const data: Record<string, unknown> = {
		name: character.name,
		description: character.description,
		personality: character.personalitySummary ?? "",
		scenario: character.defaultScenario ?? "",
		first_mes: character.firstMessage ?? "",
		mes_example: character.mesExample ?? "",
		creator_notes: character.creatorNotes ?? "",
		system_prompt:
			character.systemPrompt ?? characterRecord?.systemPrompt ?? "",
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
	const chat = await deps.chats.getById(chatId as ChatId);
	if (!chat) {
		throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}
	const messages = await deps.chats.getMessages(chat.activeBranchId);

	let characterName = "Assistant";
	try {
		characterName = deps.resolver.getCharacter(chat.characterId).name;
	} catch {}
	const persona = deps.resolver.getPersona(
		chat.personaId ?? deps.resolveDefaultPersonaId(),
	);
	const userName = persona?.name ?? "User";

	return serializeSillyTavernChat({
		userName,
		characterName,
		messages: await Promise.all(messages.map(async (message) => {
			const variants = await deps.chats.getVariants(message.id);
			const swipes =
				variants.length > 1 ? variants.map((v) => v.content) : undefined;
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
	const trace = await deps.chats.getTrace(traceId);
	if (!trace) {
		throw notFound("PromptTrace", `Prompt trace '${traceId}' was not found.`);
	}
	return {
		id: trace.id,
		chatId: trace.chatId,
		branchId: trace.branchId,
		messageId: trace.messageId,
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
	const chat = await deps.chats.getById(chatId as ChatId);
	if (!chat) {
		throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}

	const branches = await deps.chats.getBranches(chat.id);
	let characterName = "Assistant";
	try {
		characterName = deps.resolver.getCharacter(chat.characterId).name;
	} catch {}
	const persona = deps.resolver.getPersona(
		chat.personaId ?? deps.resolveDefaultPersonaId(),
	);
	const userName = persona?.name ?? "User";

	const writtenPaths: string[] = [];
	for (const branch of branches) {
		const messages = await deps.chats.getMessages(branch.id);

		const jsonl = serializeSillyTavernChat({
			userName,
			characterName,
			messages: await Promise.all(messages.map(async (message) => {
				const variants = await deps.chats.getVariants(message.id);
				const swipes =
					variants.length > 1 ? variants.map((v) => v.content) : undefined;
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
	const trace = await deps.chats.getTrace(traceId);
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
		const existing = await deps.characters.getById(imported.character.id);
		if (existing) {
			await deps.characters.update(imported.character.id, {
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
			await deps.characters.create({
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
		}

		const created = deps.chatApp.createChat({
			characterId: imported.character.id,
			personaId: deps.resolveDefaultPersonaId(),
			title: imported.character.name,
			promptPresetId: deps.resolveDefaultPromptPresetId(),
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

	// Lorebook import — phase 2
	throw validation("Lorebook import is not supported in phase 1.");
}
