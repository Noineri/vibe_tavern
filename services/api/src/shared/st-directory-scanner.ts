/**
 * SillyTavern directory scanner — walks a ST data folder and imports
 * characters, chats, and lorebooks into the RP Platform database.
 *
 * Expected ST folder structure (data/default-user/):
 *   characters/      ← .png, .json (character cards)
 *   chats/           ← {characterName}/*.jsonl
 *   worlds/          ← .json (lorebooks)
 *   OpenAI Settings/ ← .json (prompt presets, optional)
 *   settings.json    ← persona descriptions (optional)
 *   User Avatars/    ← persona avatar PNGs (optional)
 */

import { readdir, mkdir } from "node:fs/promises";
import { join, extname, basename, resolve } from "node:path";
import {
	importCharacterCardV3Json,
	parseStPreset,
	parseStPersonas,
	parseSillyTavernChat,
	stBlockToCanvasEntry,
	synthesizeCanvasEntry,
} from "@vibe-tavern/import-export";
import type { ImportExportModuleDeps, ImportResult } from "../runtime/session/session-runtime-import-export.js";
import { createPromptPreset } from "../runtime/session/session-runtime-presets.js";
import { importLorebook } from "../domain/lorebook/lorebook-import-service.js";
import { STORAGE_FOLDERS } from "@vibe-tavern/db";
import type { CharacterId, ChatId, CustomInjection, PromptOrderEntry } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StDirectoryScanResult {
	characters: StScannedCharacter[];
	chats: StScannedChat[];
	lorebooks: StScannedLorebook[];
	presets: StScannedPreset[];
	persona: StScannedPersona | null;
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

export interface StScannedPreset {
	fileName: string;
	name: string;
	imported: boolean;
}

export interface StScannedPersona {
	/** Number of persona entries detected in settings.json. */
	count: number;
	imported: boolean;
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
		presets: [],
		persona: null,
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
			const raw = (await readCharacterFile(filePath)).raw;
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

	// ── Scan OpenAI Settings/ (prompt presets) ──
	const presetsDir = join(resolved, "OpenAI Settings");
	const presetFiles = await safeReaddir(presetsDir);
	for (const fileName of presetFiles) {
		if (!fileName.toLowerCase().endsWith(".json")) continue;

		const filePath = join(presetsDir, fileName);
		try {
			const content = await Bun.file(filePath).text();
			const parsed: unknown = JSON.parse(content);
			// An ST preset must carry a prompts[] array (the field parseStPreset
			// requires). Non-preset JSON in this folder is skipped silently.
			const hasPrompts =
				parsed && typeof parsed === "object" &&
				Array.isArray((parsed as Record<string, unknown>).prompts);
			if (!hasPrompts) continue;
			const name =
				(typeof (parsed as Record<string, unknown>).name === "string"
					&& (parsed as Record<string, unknown>).name) ||
				basename(fileName, ".json");
			result.presets.push({ fileName, name: name as string, imported: false });
		} catch (err) {
			result.errors.push({
				file: filePath,
				stage: "parse",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ── Scan settings.json (personas) ──
	const settingsPath = join(resolved, "settings.json");
	const settingsStat = await Bun.file(settingsPath).stat().catch(() => null);
	if (settingsStat?.isFile()) {
		try {
			const content = await Bun.file(settingsPath).text();
			const parsed: unknown = JSON.parse(content);
			const personaCount = parseStPersonas(parsed).length;
			if (personaCount > 0) {
				result.persona = { count: personaCount, imported: false };
			}
		} catch (err) {
			result.errors.push({
				file: settingsPath,
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
	presets: number;
	personas: number;
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
		presets: 0,
		personas: 0,
		errors: [],
		lastActiveChatId: null,
	};

	// Resolve once — both are called per-character and per-chat; caching avoids
	// O(N) listAll() queries (ensureDefaultPresetId calls listAll every time).
	const defaultPersonaId = await deps.resolveDefaultPersonaId();
	const defaultPresetId = await deps.resolveDefaultPromptPresetId();

	const T0 = performance.now();
	const ti = () => `[st-import +${((performance.now() - T0) / 1000).toFixed(2)}s]`;
	console.log(`${ti()} START — dir=${resolved}`);

	// ── Import characters ──
	const charsPhaseStart = performance.now();
	const charsDir = join(resolved, "characters");
	const charsFiles = await safeReaddir(charsDir);
	const nameToCharacterId = new Map<string, CharacterId>();

	// Body extracted so the loop can run with bounded concurrency: PNG
	// reads (Bun.file) and NTFS writes (writeBinary × 2) parallelize across
	// cards, which is the main win at 1000+ card scale (AV-scan per file write
	// dominates on Windows). DB ops serialize through SQLite's single writer
	// lock regardless, so raising concurrency past ~8 gives diminishing returns.
	// Returns a discriminated outcome so the collect pass stays deterministic
	// (file order preserved for lastActiveChatId / name map).
	type CharImportOutcome =
		| { kind: "ok"; nameLower: string; slug: string; characterId: string; chatId: ChatId }
		| { kind: "skipped" }
		| { kind: "error"; file: string; message: string };

	const importOneCharacter = async (fileName: string, ext: string): Promise<CharImportOutcome> => {
		const filePath = join(charsDir, fileName);
		try {
			// pngBuffer is reused below for the avatar write — no second read.
			const { raw, pngBuffer } = await readCharacterFile(filePath);
			if (!raw) return { kind: "skipped" };

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

			// Save the avatar. ST card PNGs are uncropped by definition (ST does
			// not crop on import), so the same bytes serve both slots:
			//   1. {id}/avatar.png      — display avatar (gallery slots, chat
			//                            bubbles, sidebar). Paired with
			//                            setFolderAvatar() so avatarExt is set;
			//                            without it the character renders with
			//                            no portrait (the STN-1D bug).
			//   2. {id}/avatar-full.png — the uncropped source. Paired with
			//                            setFolderAvatarFull() so avatarFullExt
			//                            is set, wiring the ST-imported card into
			//                            the existing crop-confirm flow: the user
			//                            can later re-crop the original art from
			//                            {id}/avatar-full.png without needing the
			//                            original PNG file. Mirrors the browser
			//                            uploadCharacterAvatar(crop, full) shape.
			// Browser ST-import calls uploadCharacterAvatar(file, file) — both
			// slots — so it preserves the uncropped source too. AssetService
			// lives in the HTTP adapter layer (unreachable from shared/), so we
			// go through content + store directly.
			if (ext === ".png" && pngBuffer) {
				try {
					await deps.stores.content.writeBinary(
						STORAGE_FOLDERS.characters, characterId, "avatar.png", pngBuffer,
					);
					await deps.stores.content.writeBinary(
						STORAGE_FOLDERS.characters, characterId, "avatar-full.png", pngBuffer,
					);
					await deps.stores.characters.setFolderAvatar(characterId, "png");
					await deps.stores.characters.setFolderAvatarFull(characterId, "png");
				} catch {
					// Avatar write failure is non-critical — the character is already
					// in the DB; it just renders without a portrait.
				}
			}

			// Create a chat for the character and seed first message
			const chat = await deps.chatApp.createChat({
				characterId: characterId as CharacterId,
				personaId: defaultPersonaId,
				title: imported.character.name,
				promptPresetId: defaultPresetId,
			});

			const nameLower = imported.character.name.toLowerCase();
			const slug = nameLower.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

			// withTrace:false — MASS_IMPORT Wave 3. assemblePrompt (and the
			// lore-activation-engine) is only needed to seed a trace nobody reads
			// at import time; it can blow up to tens of seconds per card on a
			// pathological global-lorebook regex. The trace rebuilds on the first
			// real turn. Mirrors the browser path's importJson → seedImportedOpening.
			await deps.seedImportedOpening(
				chat.id as ChatId,
				imported.normalized.firstMessage,
				imported.normalized.alternateGreetings,
				{ withTrace: false },
			);
			deps.chatOrder.add(chat.id as ChatId);

			return { kind: "ok", nameLower, slug, characterId, chatId: chat.id as ChatId };
		} catch (err) {
			return {
				kind: "error",
				file: filePath,
				message: err instanceof Error ? err.message : String(err),
			};
		}
	};

	// Filter to character files, preserving readdir order for determinism.
	const charTargets = charsFiles
		.map(fileName => ({ fileName, ext: extname(fileName).toLowerCase() }))
		.filter(f => f.ext === ".png" || f.ext === ".json");

	const outcomes: CharImportOutcome[] = new Array(charTargets.length);
	let cursor = 0;
	const CHAR_CONCURRENCY = 8;
	const worker = async () => {
		while (cursor < charTargets.length) {
			const idx = cursor++;
			const { fileName, ext } = charTargets[idx]!;
			outcomes[idx] = await importOneCharacter(fileName, ext);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(CHAR_CONCURRENCY, charTargets.length) }, worker),
	);

	// Collect in original file order so lastActiveChatId is the last card by
	// readdir order that successfully imported (matches pre-parallel behavior).
	for (const o of outcomes) {
		if (o.kind === "ok") {
			result.characters++;
			nameToCharacterId.set(o.nameLower, o.characterId as CharacterId);
			nameToCharacterId.set(o.slug, o.characterId as CharacterId);
			result.lastActiveChatId = o.chatId;
		} else if (o.kind === "error") {
			result.errors.push({ file: o.file, stage: "import", message: o.message });
		}
	}
	console.log(`${ti()} characters: ${((performance.now() - charsPhaseStart) / 1000).toFixed(2)}s (${result.characters} imported)`);

	// ── Import chats ──
	const chatsPhaseStart = performance.now();
	let chatCreateMs = 0;
	let chatMsgMs = 0;
	let chatMsgCount = 0;
	let chatVarCount = 0;
	const chatsDir = join(resolved, "chats");
	const chatSubdirs = await safeReaddir(chatsDir);

	for (const sub of chatSubdirs) {
		const subPath = join(chatsDir, sub);
		const subStat = await Bun.file(subPath).stat().catch(() => null);
		if (!subStat?.isDirectory()) continue;

		// Match folder name to a character (case-insensitive).
		// nameToCharacterId is populated only from successfully-imported characters,
		// so a missing key means the character failed — skip. No need to re-fetch
		// from DB; the characterId is sufficient for createChat.
		const characterId = nameToCharacterId.get(sub.toLowerCase());
		if (!characterId) continue;

		const jsonlFiles = await safeReaddir(subPath);
		for (const fileName of jsonlFiles) {
			if (!fileName.toLowerCase().endsWith(".jsonl")) continue;

			const filePath = join(subPath, fileName);
			try {
				const tChat0 = performance.now();
				const content = await Bun.file(filePath).text();
				const parsed = parseSillyTavernChat(content);
				const importedMessages = parsed.messages.filter((m) => m.content.trim());
				if (importedMessages.length === 0) continue;

				const title = fileName.replace(/\.jsonl$/i, "") || sub;
				const chat = await deps.chatApp.createChat({
					characterId,
					personaId: defaultPersonaId,
					title,
					promptPresetId: defaultPresetId,
				});
				chatCreateMs += performance.now() - tChat0;

				// Bulk-insert all messages + variants in ONE transaction (one fsync per
				// chat) instead of O(N) per-message transactions. addMessagesBatch
				// preserves per-variant reasoning + isSelected, so this is a pure
				// performance refactor — no behavior change vs the old addMessage +
				// addVariant + selectVariant per-message loop.
				const batchItems = importedMessages.map((imported) => ({
					chatId: chat.id as ChatId,
					branchId: chat.activeBranchId,
					role: imported.role,
					authorType: imported.role === "user" ? "user" : imported.role === "system" ? "system" : "assistant",
					variants: imported.variants.length > 0
						? imported.variants.map((v) => ({ content: v.content, reasoning: v.reasoning, isSelected: v.isSelected }))
						: [{ content: imported.content, isSelected: true }],
				}));
				const tMsg0 = performance.now();
				await deps.stores.messages.addMessagesBatch(batchItems);
				chatMsgMs += performance.now() - tMsg0;
				chatMsgCount += batchItems.length;
				chatVarCount += batchItems.reduce((sum, it) => sum + it.variants.length - 1, 0);

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
	console.log(`${ti()} chats: ${((performance.now() - chatsPhaseStart) / 1000).toFixed(2)}s`
+ ` (${result.chats} chats, ${chatMsgCount} msgs, ${chatVarCount} variants)`
+ ` | createChat=${(chatCreateMs / 1000).toFixed(2)}s messages=${(chatMsgMs / 1000).toFixed(2)}s`
+ ` avg/msg=${chatMsgCount > 0 ? (chatMsgMs / chatMsgCount).toFixed(1) : 0}ms`);

	// ── Import lorebooks (worlds/) ──
	const lorePhaseStart = performance.now();
	const worldsDir = join(resolved, "worlds");
	const worldsFiles = await safeReaddir(worldsDir);

	for (const fileName of worldsFiles) {
		if (!fileName.toLowerCase().endsWith(".json")) continue;

		const filePath = join(worldsDir, fileName);
		try {
			const content = await Bun.file(filePath).text();
			const parsed: unknown = JSON.parse(content);
			const fallbackName = basename(fileName, ".json");
			// STN-1D: REAL lorebook write (was a TODO no-op that just counted).
			// Mass-imported worlds are global scope. importLorebook parses +
			// creates the lorebook + bulk-inserts entries in one call.
			await importLorebook(deps.stores, null, {
				format: "st",
				data: parsed,
				mode: "new",
				scopeType: "global",
				fallbackName,
			});
			result.lorebooks++;
		} catch (err) {
			result.errors.push({
				file: filePath,
				stage: "import",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
	console.log(`${ti()} lorebooks: ${((performance.now() - lorePhaseStart) / 1000).toFixed(2)}s (${result.lorebooks} imported)`);

	// ── Import presets (OpenAI Settings/) ──
	const presetsPhaseStart = performance.now();
	// Field mapping mirrors browser Phase 3 (ImportModals.tsx): main→system,
	// jailbreak→jailbreak, non-builtin blocks→customInjections, prompt_order→
	// canvas with synthesized entries for custom blocks absent from ST order.
	const presetsDir = join(resolved, "OpenAI Settings");
	const presetFiles = await safeReaddir(presetsDir);
	for (const fileName of presetFiles) {
		if (!fileName.toLowerCase().endsWith(".json")) continue;

		const filePath = join(presetsDir, fileName);
		try {
			const text = await Bun.file(filePath).text();
			const stPreset = parseStPreset(text);
			const presetName = fileName.replace(/\.json$/i, "");

			const { blocks, promptOrder } = stPreset;
			const mainBlock = blocks.find((b) => b.identifier === "main");
			const jailbreakBlock = blocks.find((b) => b.identifier === "jailbreak");

			// Built-in identifiers whose content goes into named preset fields
			// (not custom injections). Matches the browser exclusion set exactly.
			const excluded = new Set([
				"main", "jailbreak", "nsfw", "enhanceDefinitions",
				"worldInfoBefore", "worldInfoAfter",
			]);
			const customBlocks = blocks.filter((b) => !excluded.has(b.identifier) && b.content.trim());
			const customInjections: CustomInjection[] = customBlocks.map((b) => ({
				identifier: b.identifier,
				name: b.name || b.identifier,
				content: b.content,
				role: b.role,
			}));

			// COMPLETE canvas: preserve all ST prompt_order entries + synthesize
			// entries for custom blocks absent from ST prompt_order.
			const canvas: PromptOrderEntry[] = promptOrder.map(stBlockToCanvasEntry);
			const canvasIds = new Set(canvas.map((e) => e.identifier));
			for (const b of customBlocks) {
				if (!canvasIds.has(b.identifier)) {
					canvas.push(synthesizeCanvasEntry(b));
					canvasIds.add(b.identifier);
				}
			}

			await createPromptPreset(
				{ presets: deps.stores.presets, chats: deps.stores.chats },
				{
					name: presetName,
					system: mainBlock?.content || "",
					jailbreak: jailbreakBlock?.content || "",
					prefill: "",
					customInjections: customInjections.length > 0 ? customInjections : undefined,
					promptOrder: canvas.length > 0 ? canvas : undefined,
				},
			);
			result.presets++;
		} catch (err) {
			result.errors.push({
				file: filePath,
				stage: "import",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
	console.log(`${ti()} presets: ${((performance.now() - presetsPhaseStart) / 1000).toFixed(2)}s (${result.presets} imported)`);

	// ── Import personas (settings.json + User Avatars/) ──
	const personasPhaseStart = performance.now();
	// Mirrors browser Phase 0: parseStPersonas → create each, best-effort avatar.
	const settingsPath = join(resolved, "settings.json");
	const settingsStat = await Bun.file(settingsPath).stat().catch(() => null);
	if (settingsStat?.isFile()) {
		try {
			const content = await Bun.file(settingsPath).text();
			const parsed: unknown = JSON.parse(content);
			const personaEntries = parseStPersonas(parsed);
			for (const pe of personaEntries) {
				try {
					const created = await deps.stores.personas.create({
						name: pe.name,
						description: pe.description,
						pronouns: null,
						pronounForms: null,
						defaultForNewChats: pe.isDefault,
					});
					result.personas++;

					// Best-effort avatar upload from User Avatars/<key>. ST avatars are
					// PNG by convention and uncropped, so the same bytes are written to
					// both avatar.png (display) and avatar-full.png (uncropped source
					// for the crop-confirm flow), mirroring the character-avatar write
					// above and the browser uploadPersonaAvatar(crop, full) shape.
					// AssetService lives in the HTTP adapter layer (unreachable from
					// shared/), so we go through content + store directly.
					if (pe.avatarRelativePath) {
						const avatarFile = join(resolved, pe.avatarRelativePath);
						const avatarStat = await Bun.file(avatarFile).stat().catch(() => null);
						if (avatarStat?.isFile()) {
							try {
								const avatarBuffer = new Uint8Array(await Bun.file(avatarFile).arrayBuffer());
								await deps.stores.content.writeBinary(
									STORAGE_FOLDERS.personas, created.id, "avatar.png", avatarBuffer,
								);
								await deps.stores.content.writeBinary(
									STORAGE_FOLDERS.personas, created.id, "avatar-full.png", avatarBuffer,
								);
								await deps.stores.personas.setFolderAvatar(created.id, "png");
								await deps.stores.personas.setFolderAvatarFull(created.id, "png");
							} catch {
								// Avatar failure is non-critical — persona is already created.
							}
						}
					}
				} catch (err) {
					result.errors.push({
						file: `persona: ${pe.name}`,
						stage: "import",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			}
		} catch (err) {
			result.errors.push({
				file: settingsPath,
				stage: "import",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
	console.log(`${ti()} personas: ${((performance.now() - personasPhaseStart) / 1000).toFixed(2)}s (${result.personas} imported)`);

	console.log(
		`${ti()} DONE — total ${((performance.now() - T0) / 1000).toFixed(2)}s |`
		+ ` chars=${result.characters} chats=${result.chats} lore=${result.lorebooks}`
		+ ` presets=${result.presets} personas=${result.personas}`
		+ ` errors=${result.errors.length}`,
	);

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
async function readCharacterFile(filePath: string): Promise<{ raw: Record<string, unknown> | null; pngBuffer?: Uint8Array }> {
	const ext = extname(filePath).toLowerCase();

	if (ext === ".json") {
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content);
		if (parsed && typeof parsed === "object") {
			return { raw: parsed as Record<string, unknown> };
		}
		return { raw: null };
	}

	if (ext === ".png") {
		// Read the PNG bytes ONCE and parse from the in-memory buffer. The
		// caller (import loop) reuses the same bytes for the avatar write,
		// avoiding a second Bun.file().arrayBuffer() per card (matters at
		// 1000+ card scale). PNG decode for tEXt chunks is cheap relative to
		// the fs read + AV scan, so doing it inline is essentially free.
		const pngBuffer = new Uint8Array(await Bun.file(filePath).arrayBuffer());
		return { raw: parsePngCharacterCard(pngBuffer), pngBuffer };
	}

	return { raw: null };
}

/**
 * Extract character JSON from PNG tEXt/iTXt chunks.
 * Mirrors the frontend png-reader.ts logic but runs server-side with Bun.
 * Takes the already-read PNG bytes so callers can reuse the buffer (e.g.
 * the import loop writes avatar.png/avatar-full.png from the same bytes).
 */
function parsePngCharacterCard(uint8: Uint8Array): Record<string, unknown> | null {
	const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);

	// Check PNG signature
	if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
		return null;
	}

	let offset = 8;
	while (offset < uint8.byteLength) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...uint8.slice(offset + 4, offset + 8));
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;

		if (dataEnd > uint8.byteLength) break;

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
	} catch { /* not base64-encoded JSON — try raw JSON below */ }

	// Try raw JSON
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object") return parsed;
	} catch { /* not valid JSON either — caller falls back to null */ }

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
