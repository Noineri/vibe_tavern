/**
 * SillyTavern directory scanner — walks a ST data folder and imports
 * characters, chats, and lorebooks into the RP Platform database.
 *
 * Expected ST folder structure (data/default-user/):
 *   characters/   ← .png, .json (character cards)
 *   chats/        ← {characterName}/*.jsonl
 *   worlds/       ← .json (lorebooks)
 *   OpenAI Settings/ ← .json (prompt presets, optional)
 */

import { readdir, mkdir } from "node:fs/promises";
import { join, extname, basename, resolve } from "node:path";
import {
	importCharacterCardV3Json,
	importStLorebookJson,
	parseSillyTavernChat,
} from "@vibe-tavern/import-export";
import type { ImportExportModuleDeps, ImportResult } from "../session/session-runtime-import-export.js";
import { STORAGE_FOLDERS } from "@vibe-tavern/db";
import type { CharacterId, ChatId } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StDirectoryScanResult {
	characters: StScannedCharacter[];
	chats: StScannedChat[];
	lorebooks: StScannedLorebook[];
	errors: StScanError[];
}

export interface StScannedCharacter {
	fileName: string;
	name: string;
	characterId: string | null;
	chatId: string | null;
	imported: boolean;
	warnings: string[];
}

export interface StScannedChat {
	fileName: string;
	characterName: string;
	messageCount: number;
	chatId: string | null;
	imported: boolean;
}

export interface StScannedLorebook {
	fileName: string;
	name: string;
	imported: boolean;
	warnings: string[];
}

export interface StScanError {
	file: string;
	stage: "read" | "parse" | "import";
	message: string;
}

// ─── Scanning (read-only preview) ───────────────────────────────────────────

/**
 * Scan a SillyTavern data directory and return a preview of what would be imported.
 * Does NOT modify the database — safe to call multiple times.
 */
export async function scanSillyTavernDirectory(dirPath: string): Promise<StDirectoryScanResult> {
	const resolved = resolve(dirPath);

	// Validate the directory exists and looks like a ST data folder
	const dirStat = await Bun.file(resolved).stat().catch(() => null);
	if (!dirStat?.isDirectory()) {
		throw new Error(`"${resolved}" is not a directory.`);
	}

	const result: StDirectoryScanResult = {
		characters: [],
		chats: [],
		lorebooks: [],
		errors: [],
	};

	// ── Scan characters/ ──
	const charsDir = join(resolved, "characters");
	const charsFiles = await safeReaddir(charsDir);
	for (const fileName of charsFiles) {
		const ext = extname(fileName).toLowerCase();
		if (ext !== ".png" && ext !== ".json") continue;

		const filePath = join(charsDir, fileName);
		try {
			const raw = await readCharacterFile(filePath);
			if (!raw) continue;

			const preview = previewCharacterCard(raw, fileName);
			result.characters.push(preview);
		} catch (err) {
			result.errors.push({
				file: filePath,
				stage: "parse",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ── Scan chats/ ──
	const chatsDir = join(resolved, "chats");
	const chatSubdirs = await safeReaddir(chatsDir);
	for (const sub of chatSubdirs) {
		const subPath = join(chatsDir, sub);
		const subStat = await Bun.file(subPath).stat().catch(() => null);
		if (!subStat?.isDirectory()) continue;

		const jsonlFiles = await safeReaddir(subPath);
		for (const fileName of jsonlFiles) {
			if (!fileName.toLowerCase().endsWith(".jsonl")) continue;

			const filePath = join(subPath, fileName);
			try {
				const content = await Bun.file(filePath).text();
				const parsed = parseSillyTavernChat(content);
				const messages = parsed.messages.filter((m) => m.content.trim());
				result.chats.push({
					fileName,
					characterName: sub,
					messageCount: messages.length,
					chatId: null,
					imported: false,
				});
			} catch (err) {
				result.errors.push({
					file: filePath,
					stage: "parse",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// ── Scan worlds/ (lorebooks) ──
	const worldsDir = join(resolved, "worlds");
	const worldsFiles = await safeReaddir(worldsDir);
	for (const fileName of worldsFiles) {
		if (!fileName.toLowerCase().endsWith(".json")) continue;

		const filePath = join(worldsDir, fileName);
		try {
			const content = await Bun.file(filePath).text();
			const parsed = JSON.parse(content);
			const name = parsed.name || basename(fileName, ".json");
			result.lorebooks.push({
				fileName,
				name,
				imported: false,
				warnings: [],
			});
		} catch (err) {
			result.errors.push({
				file: filePath,
				stage: "parse",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}

// ─── Import (writes to DB) ──────────────────────────────────────────────────

export interface StDirectoryImportResult {
	characters: number;
	chats: number;
	lorebooks: number;
	errors: StScanError[];
	/** ID of the last imported character's chat — can be used to navigate UI. */
	lastActiveChatId: ChatId | null;
}

/**
 * Import everything from a SillyTavern directory into the RP Platform database.
 * Characters are imported first, then chats are matched by folder name → character name.
 */
export async function importSillyTavernDirectory(
	deps: ImportExportModuleDeps,
	dirPath: string,
): Promise<StDirectoryImportResult> {
	const resolved = resolve(dirPath);
	const result: StDirectoryImportResult = {
		characters: 0,
		chats: 0,
		lorebooks: 0,
		errors: [],
		lastActiveChatId: null,
	};

	// ── Import characters ──
	const charsDir = join(resolved, "characters");
	const charsFiles = await safeReaddir(charsDir);
	const nameToCharacterId = new Map<string, CharacterId>();

	for (const fileName of charsFiles) {
		const ext = extname(fileName).toLowerCase();
		if (ext !== ".png" && ext !== ".json") continue;

		const filePath = join(charsDir, fileName);
		try {
			const raw = await readCharacterFile(filePath);
			if (!raw) continue;

			const imported = importCharacterCardV3Json(raw);

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

			// Save original PNG bytes for lossless round-trip
			if (ext === ".png") {
				const pngBuffer = await Bun.file(filePath).arrayBuffer();
				const pngPath = deps.stores.content.fileStore.resolvePath(STORAGE_FOLDERS.characters, `${characterId}/original.png`);
				const dir = resolve(pngPath, "..");
				await mkdir(dir, { recursive: true });
				await Bun.write(pngPath, Buffer.from(pngBuffer));
			}

			// Create a chat for the character and seed first message
			const chat = await deps.chatApp.createChat({
				characterId: characterId as CharacterId,
				personaId: await deps.resolveDefaultPersonaId(),
				title: imported.character.name,
				promptPresetId: await deps.resolveDefaultPromptPresetId(),
			});

			nameToCharacterId.set(imported.character.name.toLowerCase(), characterId as CharacterId);
			// Also map by slug for matching chats
			const slug = imported.character.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
			nameToCharacterId.set(slug, characterId as CharacterId);

			await deps.seedImportedOpening(chat.id as ChatId, imported.normalized.firstMessage, imported.normalized.alternateGreetings);
			deps.chatOrder.add(chat.id as ChatId);
			result.lastActiveChatId = chat.id as ChatId;
			result.characters++;
		} catch (err) {
			result.errors.push({
				file: filePath,
				stage: "import",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ── Import chats ──
	const chatsDir = join(resolved, "chats");
	const chatSubdirs = await safeReaddir(chatsDir);

	for (const sub of chatSubdirs) {
		const subPath = join(chatsDir, sub);
		const subStat = await Bun.file(subPath).stat().catch(() => null);
		if (!subStat?.isDirectory()) continue;

		// Match folder name to a character (case-insensitive)
		const characterId = nameToCharacterId.get(sub.toLowerCase());
		if (!characterId) {
			// Skip chats for characters we couldn't import
			continue;
		}

		const character = await deps.stores.characters.getById(characterId);
		if (!character) continue;

		const jsonlFiles = await safeReaddir(subPath);
		for (const fileName of jsonlFiles) {
			if (!fileName.toLowerCase().endsWith(".jsonl")) continue;

			const filePath = join(subPath, fileName);
			try {
				const content = await Bun.file(filePath).text();
				const parsed = parseSillyTavernChat(content);
				const importedMessages = parsed.messages.filter((m) => m.content.trim());
				if (importedMessages.length === 0) continue;

				const title = fileName.replace(/\.jsonl$/i, "") || sub;
				const chat = await deps.chatApp.createChat({
					characterId,
					personaId: await deps.resolveDefaultPersonaId(),
					title,
					promptPresetId: await deps.resolveDefaultPromptPresetId(),
				});

				for (const imported of importedMessages) {
					const variants = imported.variants.length > 0
						? imported.variants
						: [{ content: imported.content, isSelected: true }];
					const message = await deps.stores.chats.addMessage({
						chatId: chat.id as ChatId,
						branchId: chat.activeBranchId,
						role: imported.role,
						authorType: imported.role === "user" ? "user" : imported.role === "system" ? "system" : "assistant",
						content: variants[0]?.content ?? imported.content,
					});
					for (const variant of variants.slice(1)) {
						await deps.stores.chats.addVariant(message.id, variant.content, undefined, variant.reasoning);
					}
					const selectedVariant = imported.variants.find((v) => v.isSelected) ?? imported.variants[0];
					const selectedIndex = variants.findIndex((v) => v.content === selectedVariant?.content);
					if (selectedIndex > 0) {
						await deps.stores.chats.selectVariant(message.id, selectedIndex);
					}
				}

				deps.chatOrder.add(chat.id as ChatId);
				result.lastActiveChatId = chat.id as ChatId;
				result.chats++;
			} catch (err) {
				result.errors.push({
					file: filePath,
					stage: "import",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// ── Import lorebooks (worlds/) ──
	const worldsDir = join(resolved, "worlds");
	const worldsFiles = await safeReaddir(worldsDir);

	for (const fileName of worldsFiles) {
		if (!fileName.toLowerCase().endsWith(".json")) continue;

		const filePath = join(worldsDir, fileName);
		try {
			const content = await Bun.file(filePath).text();
			const parsed = JSON.parse(content);
			const imported = importStLorebookJson(parsed);

			// TODO: Store lorebook + entries when lorebook DB tables are implemented
			// For now, just count as parsed successfully
			result.lorebooks++;
		} catch (err) {
			result.errors.push({
				file: filePath,
				stage: "import",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function safeReaddir(dirPath: string): Promise<string[]> {
	try {
		return await readdir(dirPath);
	} catch {
		return [];
	}
}

/**
 * Read a character card from a file (PNG or JSON).
 * PNG: extract chara/ccv3 chunk + decode base64.
 * JSON: parse directly.
 */
async function readCharacterFile(filePath: string): Promise<Record<string, unknown> | null> {
	const ext = extname(filePath).toLowerCase();

	if (ext === ".json") {
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, unknown>;
		}
		return null;
	}

	if (ext === ".png") {
		return readPngCharacterCard(filePath);
	}

	return null;
}

/**
 * Extract character JSON from PNG tEXt/iTXt chunks.
 * Mirrors the frontend png-reader.ts logic but runs server-side with Bun.
 */
async function readPngCharacterCard(filePath: string): Promise<Record<string, unknown> | null> {
	const buffer = await Bun.file(filePath).arrayBuffer();
	const view = new DataView(buffer);
	const uint8 = new Uint8Array(buffer);

	// Check PNG signature
	if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
		return null;
	}

	let offset = 8;
	while (offset < buffer.byteLength) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...uint8.slice(offset + 4, offset + 8));
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;

		if (dataEnd > buffer.byteLength) break;

		if (type === "tEXt") {
			const chunkData = uint8.slice(dataStart, dataEnd);
			const nullIndex = chunkData.indexOf(0);
			if (nullIndex !== -1) {
				const keyword = new TextDecoder().decode(chunkData.slice(0, nullIndex));
				if (keyword === "ccv3" || keyword === "chara") {
					const text = new TextDecoder().decode(chunkData.slice(nullIndex + 1));
					return decodeCardText(text);
				}
			}
		}

		if (type === "IEND") break;
		offset = dataEnd + 4;
	}

	return null;
}

/**
 * Decode base64-encoded character card JSON (ST standard) or raw JSON.
 */
function decodeCardText(text: string): Record<string, unknown> | null {
	// Try base64 first
	try {
		const raw = atob(text);
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
		const decoded = JSON.parse(new TextDecoder().decode(bytes));
		if (decoded && typeof decoded === "object") return decoded;
	} catch {}

	// Try raw JSON
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object") return parsed;
	} catch {}

	return null;
}

/**
 * Preview a character card without importing — extract name for display.
 */
function previewCharacterCard(
	raw: Record<string, unknown>,
	fileName: string,
): StScannedCharacter {
	try {
		const imported = importCharacterCardV3Json(raw);
		return {
			fileName,
			name: imported.character.name,
			characterId: imported.character.id,
			chatId: null,
			imported: false,
			warnings: imported.warnings,
		};
	} catch (err) {
		// Couldn't parse as v3 — try to extract name manually
		const nestedData = typeof raw.data === 'object' && raw.data !== null ? raw.data as Record<string, unknown> : raw;
		const name = typeof nestedData.name === "string" ? nestedData.name : basename(fileName, extname(fileName));
		return {
			fileName,
			name,
			characterId: null,
			chatId: null,
			imported: false,
			warnings: [err instanceof Error ? err.message : "Failed to parse card"],
		};
	}
}
