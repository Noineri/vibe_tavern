import type { StoreContainer } from "@vibe-tavern/db";
import type { LoreScopeType } from "@vibe-tavern/domain";
import type { StWorldInfoGlobalOptions } from "@vibe-tavern/import-export";

export interface LorebookImportResult {
	lorebookId: string;
	imported: number;
	skipped: number;
	warnings: string[];
}

/**
 * Pick the right parser for `data`.
 *
 * Routing priority:
 *   1. Explicit `format: "janitor"` → Janitor parser.
 *   2. Explicit `format: "st"` → ST parser.
 *   3. Shape-based auto-detect: a bare top-level array → Janitor; an object
 *      (with or without `entries`) → ST (the ST parser handles missing
 *      entries gracefully by returning an empty list).
 * This safety net catches Janitor files uploaded while the format defaulted
 * to "st" — the most common path since the frontend auto-detects too, but
 * a direct API caller may not set it.
 */
type CharacterFilterAvatarResolver = (avatarFilename: string) => { id: string; name: string } | null;

function normalizeAvatarFilename(value: string): string {
	const fileName = value.trim().split(/[\\/]/).pop() ?? "";
	const extensionStart = fileName.lastIndexOf(".");
	return (extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName).toLowerCase();
}

function buildCharacterFilterAvatarResolver(
	characters: ReadonlyArray<{ id: string; name: string; slug: string }>,
): CharacterFilterAvatarResolver {
	const charactersByAvatarStem = new Map<string, { id: string; name: string }>();
	for (const character of characters) {
		for (const alias of [character.name, character.slug]) {
			const stem = normalizeAvatarFilename(alias);
			if (stem && !charactersByAvatarStem.has(stem)) {
				charactersByAvatarStem.set(stem, { id: character.id, name: character.name });
			}
		}
	}
	return (avatarFilename) => charactersByAvatarStem.get(normalizeAvatarFilename(avatarFilename)) ?? null;
}

async function parseLorebook(
	format: string,
	data: unknown,
	options: StWorldInfoGlobalOptions & {
		scopeType?: LoreScopeType;
		fallbackName?: string;
		characterFilterAvatarResolver?: CharacterFilterAvatarResolver;
	},
) {
	const { importCharacterBookJson, importStLorebookJson, importJanitorLorebookJson, isJanitorLorebookArray } = await import(
		"@vibe-tavern/import-export"
	);

	if (format === "character_book") {
		return importCharacterBookJson(data, {
			scopeType: options.scopeType,
			fallbackName: options.fallbackName,
			...options,
			characterFilterAvatarResolver: options.characterFilterAvatarResolver,
		});
	}
	if (format === "janitor" || isJanitorLorebookArray(data)) {
		return importJanitorLorebookJson(Array.isArray(data) ? data : (data as unknown[]), {
			scopeType: options.scopeType,
			fallbackName: options.fallbackName,
		});
	}
	return importStLorebookJson(data as Record<string, unknown>, {
		scopeType: options.scopeType,
		fallbackName: options.fallbackName,
		...options,
		characterFilterAvatarResolver: options.characterFilterAvatarResolver,
	});
}

export async function importLorebook(
	stores: StoreContainer,
	lorebookId: string | null,
	body: StWorldInfoGlobalOptions & {
		format: string;
		data: unknown;
		mode: string;
		scopeType?: string;
		characterId?: string;
		personaId?: string;
		chatId?: string;
		fallbackName?: string;
		enabled?: boolean;
	},
): Promise<LorebookImportResult> {
	// ST stores character-filter names as avatar filenames. The import service
	// owns the character inventory, so it binds a filename stem to a local
	// character ID when a name or slug matches; unresolved filenames remain
	// ghosts in the pure importer and therefore match nobody by accident.
	const characterFilterAvatarResolver = buildCharacterFilterAvatarResolver(await stores.characters.listAll());
	const parsed = await parseLorebook(body.format, body.data, {
		...body,
		scopeType: (body.scopeType as LoreScopeType | undefined) ?? "entity",
		fallbackName: body.fallbackName,
		characterFilterAvatarResolver,
	});

	let targetId = lorebookId;

	if (body.mode === "new" || !targetId) {
		const created = await stores.lorebooks.createLorebook({
			name: parsed.lorebook.name,
			description: parsed.lorebook.description,
			scopeType: (body.scopeType as LoreScopeType) ?? "entity",
			scanDepth: parsed.lorebook.scanDepth,
			tokenBudget: parsed.lorebook.tokenBudget,
			tokenBudgetPercent: parsed.lorebook.tokenBudgetPercent,
			tokenBudgetCap: parsed.lorebook.tokenBudgetCap,
			recursiveScanning: parsed.lorebook.recursiveScanning,
			useGroupScoring: parsed.lorebook.useGroupScoring,
			caseSensitive: parsed.lorebook.caseSensitive,
			matchWholeWords: parsed.lorebook.matchWholeWords,
			maxRecursionSteps: parsed.lorebook.maxRecursionSteps,
			includeNames: parsed.lorebook.includeNames,
			minActivations: parsed.lorebook.minActivations,
			minActivationsDepthMax: parsed.lorebook.minActivationsDepthMax,
			overflowAlert: parsed.lorebook.overflowAlert,
			characterStrategy: parsed.lorebook.characterStrategy,
			sortOrder: parsed.lorebook.sortOrder,
			chatId: body.chatId ?? null,
			extensions: parsed.lorebook.extensions,
			// Absent → store default (enabled). Merge/replace into an existing
			// book never reach this branch, so the flag only affects creation.
			enabled: body.enabled ?? true,
		});
		targetId = created.id;
		// Owners are links (migration 0107, LORE_SCRIPT_OWNERS_AS_LINKS step 1):
		// the create API's deprecated home-owner inputs no longer bind anything,
		// so THIS seam binds the requested owner itself. The callers are exactly
		// the contexts where the owner is unambiguous (the import modal's owner
		// pick, a card import's embedded book → the imported character, the ST
		// directory scanner → the owners it already resolves) — per the report's
		// Verdict they bind without asking. Idempotent: an existing link row is
		// left untouched (onConflictDoNothing).
		if ((body.scopeType ?? "entity") === "entity") {
			if (body.characterId) await stores.lorebooks.addLink(targetId, "character", body.characterId);
			if (body.personaId) await stores.lorebooks.addLink(targetId, "persona", body.personaId);
		}
	} else {
		const lorebook = await stores.lorebooks.getLorebook(targetId);
		if (!lorebook) throw new Error(`Lorebook not found: ${targetId}`);
		if (body.mode === "replace") {
			await stores.lorebooks.deleteAllEntries(targetId);
		}
	}

	const entryData = parsed.entries.map((entry) => ({
		title: entry.title,
		content: entry.content,
		keys: entry.keys,
		secondaryKeys: entry.secondaryKeys,
		logic: entry.logic,
		position: entry.position,
		depth: entry.depth,
		priority: entry.priority,
		stickyWindow: entry.stickyWindow,
		cooldownWindow: entry.cooldownWindow,
		minChatMessages: entry.minChatMessages,
		constant: entry.constant,
		probability: entry.probability,
		role: entry.role,
		groupName: entry.groupName,
		groupWeight: entry.groupWeight,
		prioritizeInclusion: entry.prioritizeInclusion,
		excludeRecursion: entry.excludeRecursion,
		preventRecursion: entry.preventRecursion,
		delayUntilRecursion: entry.delayUntilRecursion,
		recursionLevel: entry.recursionLevel,
		scanDepthOverride: entry.scanDepthOverride,
		caseSensitive: entry.caseSensitive,
		matchWholeWords: entry.matchWholeWords,
		characterFilter: entry.characterFilter,
		characterFilterExclude: entry.characterFilterExclude,
		matchSources: entry.matchSources,
		enabled: entry.enabled,
		sortOrder: entry.sortOrder,
		metadata: entry.metadata,
	}));

	const imported = await stores.lorebooks.bulkCreateEntries(targetId, entryData);
	return { lorebookId: targetId, imported, skipped: parsed.entries.length - imported, warnings: parsed.warnings };
}
