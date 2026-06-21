import type { LorebookRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer, CreateLoreEntryData, UpdateLoreEntryData } from "@vibe-tavern/db";
import { importLorebook } from "../../domain/lorebook/lorebook-import-service.js";

export class LorebookAdapter implements LorebookRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	// ─── Lorebook CRUD ──────────────────────────────────────────────────

	listAllLorebooks = () => this.stores.lorebooks.listAllLorebooks();

	listLorebooks = (scopeType: string, ownerId?: string) =>
		this.stores.lorebooks.listLorebooksByScope(scopeType, ownerId);

	createLorebook = (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; tokenBudgetPercent?: number | null; recursiveScanning?: boolean }) =>
		this.stores.lorebooks.createLorebook(body);

	updateLorebookMeta = (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; tokenBudgetPercent?: number | null; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) =>
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
		this.stores.lorebooks.createEntry(lorebookId, body as CreateLoreEntryData);

	updateLoreEntry = (_lorebookId: string, entryId: string, body: Record<string, unknown>) =>
		this.stores.lorebooks.updateEntry(entryId, body as UpdateLoreEntryData);

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

	importLorebook = (lorebookId: string | null, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }) =>
		importLorebook(this.stores, lorebookId, body);
}
