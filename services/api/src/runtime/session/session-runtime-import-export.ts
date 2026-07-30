import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { type StoreContainer, type FileStore, STORAGE_FOLDERS, unpackMonolith } from "@vibe-tavern/db";
import type {
	ChatId,
	PersonaId,
	PromptPresetId,
} from "@vibe-tavern/domain";
import { brandId, type CharacterId } from "@vibe-tavern/domain";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import {
	flattenV2CompatFields,
	importCharacterCardV3Json,
	parseSillyTavernChat,
	serializeSillyTavernChat,
	vtfContentToImportedBundle,
	type ImportedCharacterCardBundle,
} from "@vibe-tavern/import-export";
import type { ChatApplicationService } from "../../domain/chat/chat-application-service.js";
import { notFound, validation } from "../../shared/errors.js";
import type { CharacterRecord } from "../../domain/character/character-runtime.js";

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
	seedImportedOpening(
		chatId: ChatId,
		firstMessage: string,
		alternateGreetings?: string[],
		opts?: { withTrace?: boolean },
	): Promise<void>;
}

export interface ImportResult {
	activeChatId: ChatId;
	// Optional under the lean mass-import path (skip O(N²) getSnapshot).
	// Full single-card import always returns a snapshot.
	snapshot?: import("./session-runtime.js").SessionSnapshot;
	// Set on the lean path so the frontend can resolve the avatar upload
	// without the snapshot. Absent on the full path (use snapshot.character.id).
	characterId?: CharacterId;
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
	} catch { /* character may be missing (deleted/unsaved); leave characterRecord null and fall back to card.name below */ }

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
	const originalFolder = await deps.stores.characters.resolveFolderName(characterId);
	const original = await deps.stores.content.readEntity<Record<string, unknown>>(
		STORAGE_FOLDERS.characters,
		`${originalFolder}/original`,
	);
	if (original) {
		// Original wins for unknown fields, current data wins for known fields
		const origData = (original as Record<string, unknown>).data as Record<string, unknown> | undefined;
		const mergedData = { ...(origData ?? {}), ...data };
		const merged = { ...(original as Record<string, unknown>), data: mergedData };
		// Flatten V2 compat fields to the top level so strict V2 parsers
		// (janitor.ai et al.) can read the card. `data` stays canonical.
		return flattenV2CompatFields(merged);
	}

	return flattenV2CompatFields({ data });
}

export async function exportChatJsonl(
	deps: ImportExportModuleDeps,
	chatId: string,
): Promise<string> {
	const chat = await deps.stores.chats.getById(chatId as ChatId);
	if (!chat) {
		throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}
	const messages = await deps.stores.messages.getMessages(chat.activeBranchId);

	const { characterName, userName } = await resolveChatNames(deps, chat.characterId, chat.personaId);

	return serializeSillyTavernChat({
		userName,
		characterName,
		messages: await Promise.all(messages.map(async (message) => {
			const variants = await deps.stores.messages.getVariants(message.id);
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
	const trace = await deps.stores.traces.getTrace(traceId);
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
		activatedLoreDetail: trace.activatedLoreDetail ?? [],
		scriptInjections: trace.scriptInjections as import("@vibe-tavern/domain").PromptTraceRecordDto["scriptInjections"],
		retrievedMemories: trace.retrievedMemories as Array<Record<string, unknown>>,
		finalPayload: trace.finalPayload,
		compactionSummary: trace.compactionSummary ?? null,
		sentConfig: trace.sentConfig ?? undefined,
		providerResponse: trace.providerResponse ?? undefined,
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
		const messages = await deps.stores.messages.getMessages(branch.id);

		const jsonl = serializeSillyTavernChat({
			userName,
			characterName,
			messages: await Promise.all(messages.map(async (message) => {
				const variants = await deps.stores.messages.getVariants(message.id);
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
	const trace = await deps.stores.traces.getTrace(traceId);
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
		jsonText?: string;
		monolithText?: string;
		chatId?: string;
		skipExisting?: boolean;
		lean?: boolean;
	},
): Promise<ImportResult> {
	const jsonText = input.jsonText?.trim() ?? "";
	const monolithText = input.monolithText?.trim() ?? "";
	if (!jsonText && !monolithText) {
		throw validation("Import payload is empty.");
	}

	// JSONL chat import is JSON-text only (there is no monolith equivalent).
	if (jsonText && input.fileName.toLowerCase().endsWith(".jsonl")) {
		return importSillyTavernChat(deps, input.fileName, jsonText, input.chatId, input.lean);
	}

	// Build the bundle from whichever native source is present. A VTF monolith
	// (a standalone `.md` file or a PNG `vtmd` chunk) wins when supplied — it is
	// the lossless native representation; ST V2/V3 JSON stays the fallback.
	// `parsed` is the original JSON card on the JSON path (persisted as
	// `original.json` for the lossless ST round-trip) and null on the monolith
	// path — no original to keep there, since the field set is already lossless
	// and a non-JSON `original.*` would break `exportCharacter`'s JSON merge.
	let parsed: Record<string, unknown> | null = null;
	let imported: ImportedCharacterCardBundle;
	if (monolithText) {
		imported = vtfContentToImportedBundle(unpackMonolith(monolithText), monolithText);
	} else {
		parsed = JSON.parse(jsonText) as Record<string, unknown>;
		const isCharacterCard = parsed.spec === "chara_card_v3" || parsed.spec === "chara_card_v2" || (!!parsed.name && !parsed.spec);
		if (!isCharacterCard) throw validation("Lorebook import is not supported in phase 1.");
		imported = importCharacterCardV3Json(parsed);
	}
	{
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
				mesExampleMode: imported.character.mesExampleMode,
				mesExampleDepth: imported.character.mesExampleDepth,
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
			if (parsed) {
				const of = await deps.stores.characters.resolveFolderName(imported.character.id);
				await deps.stores.content.writeEntity(STORAGE_FOLDERS.characters, `${of}/original`, parsed);
			}

			return {
				activeChatId: chatId as ChatId,
				snapshot: input.lean ? undefined : await deps.getSnapshot(chatId as ChatId),
				characterId: imported.character.id as CharacterId,
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
				mesExampleMode: imported.character.mesExampleMode,
				mesExampleDepth: imported.character.mesExampleDepth,
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
			if (parsed) {
				const of = await deps.stores.characters.resolveFolderName(characterId);
				await deps.stores.content.writeEntity(STORAGE_FOLDERS.characters, `${of}/original`, parsed);
			}
			} else {
			const created = await deps.stores.characters.create({
				name: imported.character.name,
				description: imported.character.description,
				personalitySummary: imported.character.personalitySummary,
				defaultScenario: imported.character.defaultScenario,
				firstMessage: imported.character.firstMessage,
				mesExample: imported.character.mesExample,
				mesExampleMode: imported.character.mesExampleMode,
				mesExampleDepth: imported.character.mesExampleDepth,
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
			if (parsed) {
				const of = await deps.stores.characters.resolveFolderName(characterId);
				await deps.stores.content.writeEntity(STORAGE_FOLDERS.characters, `${of}/original`, parsed);
			}
			}

		const chat = await deps.chatApp.createChat({
			characterId: characterId as CharacterId,
			personaId: await deps.resolveDefaultPersonaId(),
			title: imported.character.name,
			promptPresetId: await deps.resolveDefaultPromptPresetId(),
		});

		const createdId = chat.id as ChatId;
		deps.chatOrder.add(createdId);
		await deps.seedImportedOpening(
			createdId,
			imported.normalized.firstMessage,
			imported.normalized.alternateGreetings,
			// Mass-import doesn't need a trace — the user hasn't opened the chat
			// yet. assemblePrompt (called inside seedImportedOpening to build the
			// trace) runs the full lore-activation engine on the greeting text,
			// which is O(entries × message × keys) and can blow up to tens of
			// seconds on a single card when a global lorebook has a pathological
			// regex key (observed: 68s on one card). Skipping it collapses the
			// whole import from ~38s to seconds. The trace rebuilds on the first
			// real turn, same as a freshly-created chat.
			{ withTrace: false },
		);

		return {
			activeChatId: createdId,
			snapshot: input.lean ? undefined : await deps.getSnapshot(createdId),
			characterId: characterId as CharacterId,
			imported: {
				kind: "character",
				name: imported.character.name,
				fileName: input.fileName,
				warningCount: imported.warnings.length,
				warnings: imported.warnings,
			},
		};
	}
}

export interface BatchImportItem {
	fileName: string;
	jsonText?: string;
	monolithText?: string;
	chatId?: string;
	skipExisting?: boolean;
}

export interface BatchImportResult {
	results: Array<{
		fileName: string;
		characterId?: CharacterId;
		activeChatId?: ChatId;
		error?: string;
	}>;
}

/**
 * Mass-import batch: process N character cards in one request. Loops the
 * existing {@link importJson} per item with per-item try/catch — a failed item
 * is collected into `results[].error` rather than aborting the batch (one bad
 * card must not roll back the others). Defaults to `lean: true` because the
 * only mass-import caller reads nothing but the ids.
 *
 * No cross-store transaction wraps the loop: each store owns its connection
 * and existing per-method transactions are intentional (see persistence.ts).
 * The server is already ~8ms/card after Wave 1 (bench #4), so sequential
 * per-item processing here is not a bottleneck — the win is eliminating N
 * HTTP roundtrips and letting the frontend parallelize.
 */
export async function importJsonBatch(
	deps: ImportExportModuleDeps,
	input: { items: BatchImportItem[]; lean?: boolean },
): Promise<BatchImportResult> {
	const lean = input.lean ?? true;
	const results: BatchImportResult["results"] = [];
	const batchStart = (typeof Bun !== "undefined" ? Bun.nanoseconds() : Date.now() * 1e6);
	const slowCards: string[] = [];
	for (const item of input.items) {
		const cardStart = (typeof Bun !== "undefined" ? Bun.nanoseconds() : Date.now() * 1e6);
		try {
			const r = await importJson(deps, { ...item, lean });
			const cardMs = ((typeof Bun !== "undefined" ? Bun.nanoseconds() : Date.now() * 1e6) - cardStart) / 1e6;
			if (cardMs > 50) slowCards.push(`${item.fileName}=${cardMs.toFixed(0)}ms`);
			results.push({
				fileName: item.fileName,
				characterId: r.characterId,
				activeChatId: r.activeChatId,
			});
		} catch (err) {
			const cardMs = ((typeof Bun !== "undefined" ? Bun.nanoseconds() : Date.now() * 1e6) - cardStart) / 1e6;
			slowCards.push(`${item.fileName}=ERR${cardMs.toFixed(0)}ms`);
			results.push({
				fileName: item.fileName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	const batchMs = ((typeof Bun !== "undefined" ? Bun.nanoseconds() : Date.now() * 1e6) - batchStart) / 1e6;
	console.log(
		`[import-batch] ${input.items.length} cards in ${batchMs.toFixed(0)}ms (avg ${(batchMs / input.items.length).toFixed(1)}ms/card)` +
			(slowCards.length ? ` | slow: ${slowCards.join(", ")}` : ""),
	);
	return { results };
}

async function importSillyTavernChat(
	deps: ImportExportModuleDeps,
	fileName: string,
	jsonlContent: string,
	sourceChatId?: string,
	lean?: boolean,
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
		const message = await deps.stores.messages.addMessage({
			chatId: createdId,
			branchId: chat.activeBranchId,
			role: imported.role,
			authorType: imported.role === "user" ? "user" : imported.role === "system" ? "system" : "assistant",
			content: variants[0]?.content ?? imported.content,
		});
		for (const variant of variants.slice(1)) {
			await deps.stores.messages.addVariant(message.id, variant.content, undefined, variant.reasoning);
		}
		const selectedIndex = variants.findIndex((variant) => variant.content === selectedVariant?.content);
		if (selectedIndex > 0) {
			await deps.stores.messages.selectVariant(message.id, selectedIndex);
		}
	}

	return {
		activeChatId: createdId,
		snapshot: lean ? undefined : await deps.getSnapshot(createdId),
		characterId: sourceChat.characterId as CharacterId,
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
	} catch { /* character may have been deleted; keep the default "Assistant" name */ }
	const persona = await deps.resolver.getPersona(
		personaId ?? (await deps.resolveDefaultPersonaId()) as string,
	);
	const userName = persona?.name ?? "User";
	return { characterName, userName };
}
