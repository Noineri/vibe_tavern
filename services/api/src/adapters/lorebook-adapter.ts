import type { LorebookRuntimeApi } from "../routes/types.js";
import type { StoreContainer, CreateLoreEntryData, UpdateLoreEntryData } from "@vibe-tavern/db";
import type { LoreScopeType } from "@vibe-tavern/domain";
import type { SessionRuntime } from "../session/session-runtime.js";

export class LorebookAdapter implements LorebookRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		private readonly sessionRuntime: SessionRuntime,
	) {}

	// ─── Lorebook CRUD ──────────────────────────────────────────────────

	listAllLorebooks = () => this.stores.lorebooks.listAllLorebooks();

	listLorebooks = (scopeType: string, ownerId?: string) =>
		this.stores.lorebooks.listLorebooksByScope(scopeType, ownerId);

	createLorebook = (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) =>
		this.stores.lorebooks.createLorebook(body);

	updateLorebookMeta = (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) =>
		this.stores.lorebooks.updateLorebook(lorebookId, body);

	deleteLorebook = async (lorebookId: string) => {
		await this.stores.lorebooks.deleteLorebook(lorebookId);
	};

	duplicateLorebook = (lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }) =>
		this.stores.lorebooks.duplicateLorebook(lorebookId, overrides);

	exportLorebook = (lorebookId: string) =>
		this.stores.lorebooks.exportToStFormat(lorebookId);

	getLorebookLinks = (lorebookId: string) =>
		this.stores.lorebooks.getLinks(lorebookId);

	setLorebookLinks = (lorebookId: string, links: Array<{ targetType: string; targetId: string }>) =>
		this.stores.lorebooks.setLinks(lorebookId, links);

	// ─── Lore entries ───────────────────────────────────────────────────

	createLoreEntry = (lorebookId: string, body: Record<string, unknown>) =>
		this.stores.lorebooks.createEntry(lorebookId, body as unknown as CreateLoreEntryData);

	updateLoreEntry = (_lorebookId: string, entryId: string, body: Record<string, unknown>) =>
		this.stores.lorebooks.updateEntry(entryId, body as unknown as UpdateLoreEntryData);

	deleteLoreEntry = (_lorebookId: string, entryId: string) =>
		this.stores.lorebooks.deleteEntry(entryId);

	listLoreEntries = (lorebookId: string) =>
		this.stores.lorebooks.listEntries(lorebookId);

	reorderLoreEntries = (lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>) =>
		this.stores.lorebooks.reorderEntries(lorebookId, updates);

	testLoreActivation = async (lorebookId: string, body: { text: string }) => {
		const entries = await this.stores.lorebooks.listEntries(lorebookId);
		const activated = entries.filter(e =>
			e.enabled && e.keys.some(k => k && body.text.toLowerCase().includes(k.toLowerCase()))
		);
		return { activatedIds: activated.map(e => e.id), totalEntries: entries.length };
	};

	importLorebook = async (lorebookId: string | null, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }) => {
		const { importStLorebookJson } = await import("@vibe-tavern/import-export");
		const parsed = importStLorebookJson(body.data as Record<string, unknown>, {
			scopeType: (body.scopeType as LoreScopeType | undefined) ?? "character",
			fallbackName: body.fallbackName,
		});

		let targetId = lorebookId;

		if (body.mode === "new" || !targetId) {
			const created = await this.stores.lorebooks.createLorebook({
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
			const lorebook = await this.stores.lorebooks.getLorebook(targetId);
			if (!lorebook) throw new Error(`Lorebook not found: ${targetId}`);
			if (body.mode === "replace") {
				await this.stores.lorebooks.deleteAllEntries(targetId);
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

		const imported = await this.stores.lorebooks.bulkCreateEntries(targetId, entryData);
		return { lorebookId: targetId, imported, skipped: parsed.entries.length - imported, warnings: parsed.warnings };
	};
}
