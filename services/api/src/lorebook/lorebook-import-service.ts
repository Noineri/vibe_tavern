import type { StoreContainer } from "@vibe-tavern/db";
import type { LoreScopeType } from "@vibe-tavern/domain";

export interface LorebookImportResult {
	lorebookId: string;
	imported: number;
	skipped: number;
	warnings: string[];
}

export async function importLorebook(
	stores: StoreContainer,
	lorebookId: string | null,
	body: {
		format: string;
		data: unknown;
		mode: string;
		scopeType?: string;
		characterId?: string;
		personaId?: string;
		chatId?: string;
		fallbackName?: string;
	},
): Promise<LorebookImportResult> {
	const { importStLorebookJson } = await import("@vibe-tavern/import-export");
	const parsed = importStLorebookJson(body.data as Record<string, unknown>, {
		scopeType: (body.scopeType as LoreScopeType | undefined) ?? "character",
		fallbackName: body.fallbackName,
	});

	let targetId = lorebookId;

	if (body.mode === "new" || !targetId) {
		const created = await stores.lorebooks.createLorebook({
			name: parsed.lorebook.name,
			description: parsed.lorebook.description,
			scopeType: (body.scopeType as LoreScopeType) ?? "character",
			scanDepth: parsed.lorebook.scanDepth,
			tokenBudget: parsed.lorebook.tokenBudget,
			recursiveScanning: parsed.lorebook.recursiveScanning,
			characterId: body.characterId ?? null,
			personaId: body.personaId ?? null,
			chatId: body.chatId ?? null,
			extensions: parsed.lorebook.extensions,
		});
		targetId = created.id;
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
		delayWindow: entry.delayWindow,
		constant: entry.constant,
		probability: entry.probability,
		role: entry.role,
		group: entry.group,
		groupName: entry.group,
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
		triggers: entry.triggers,
		matchSources: entry.matchSources,
		enabled: entry.enabled,
		sortOrder: entry.sortOrder,
		metadata: entry.metadata,
	}));

	const imported = await stores.lorebooks.bulkCreateEntries(targetId, entryData);
	return { lorebookId: targetId, imported, skipped: parsed.entries.length - imported, warnings: parsed.warnings };
}
