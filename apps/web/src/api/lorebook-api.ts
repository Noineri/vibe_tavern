import type { LoreEntryRecord, LorebookRecord, LorebookLinkRecord } from "./types.js";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { getGatewayBaseUrl, getMobileToken } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

// ─── Lorebook CRUD ──────────────────────────────────────────────────────

export async function listAllLorebooks(): Promise<LorebookRecord[]> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/lorebooks/all`));
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<LorebookRecord[]>;
}

export async function listLorebooks(scopeType: string, ownerId?: string): Promise<LorebookRecord[]> {
  const response = await client.api.lorebooks.$get({ query: { scopeType, ownerId } });
  return unwrapRpc<LorebookRecord[]>(response);
}

export async function createLorebook(body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string }): Promise<LorebookRecord> {
  const response = await client.api.lorebooks.$post({ json: body });
  return unwrapRpc<LorebookRecord>(response);
}

export async function updateLorebookMeta(lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }): Promise<LorebookRecord> {
  const response = await client.api.lorebooks[":lorebookId"].$patch({ param: { lorebookId }, json: body });
  return unwrapRpc<LorebookRecord>(response);
}

export async function deleteLorebook(lorebookId: string): Promise<void> {
  const response = await client.api.lorebooks[":lorebookId"].$delete({ param: { lorebookId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function duplicateLorebook(lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }): Promise<{ lorebook: LorebookRecord; links: LorebookLinkRecord[] }> {
  const response = await client.api.lorebooks[":lorebookId"].duplicate.$post({ param: { lorebookId }, json: overrides ?? {} });
  return unwrapRpc<{ lorebook: LorebookRecord; links: LorebookLinkRecord[] }>(response);
}

export async function exportLorebookSt(lorebookId: string): Promise<Record<string, unknown>> {
  const response = await client.api.lorebooks[":lorebookId"].export.$get({ param: { lorebookId } });
  return unwrapRpc<Record<string, unknown>>(response);
}

export async function getLorebookLinks(lorebookId: string): Promise<LorebookLinkRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].links.$get({ param: { lorebookId } });
  return unwrapRpc<LorebookLinkRecord[]>(response);
}

export async function setLorebookLinks(lorebookId: string, links: Array<{ targetType: "character" | "persona"; targetId: string }>): Promise<LorebookLinkRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].links.$put({ param: { lorebookId }, json: { links } });
  return unwrapRpc<LorebookLinkRecord[]>(response);
}

// ─── Lore Entries ───────────────────────────────────────────────────────

export async function listLoreEntries(lorebookId: string): Promise<LoreEntryRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].entries.$get({ param: { lorebookId } });
  return unwrapRpc<LoreEntryRecord[]>(response);
}

export async function createLoreEntry(lorebookId: string, entry: Partial<LoreEntryRecord>): Promise<LoreEntryRecord> {
  const response = await client.api.lorebooks[":lorebookId"].entries.$post({ param: { lorebookId }, json: entry });
  return unwrapRpc<LoreEntryRecord>(response);
}

export async function updateLoreEntry(lorebookId: string, entryId: string, entry: Partial<LoreEntryRecord>): Promise<LoreEntryRecord> {
  const response = await client.api.lorebooks[":lorebookId"].entries[":entryId"].$patch({ param: { lorebookId, entryId }, json: entry });
  return unwrapRpc<LoreEntryRecord>(response);
}

export async function deleteLoreEntry(lorebookId: string, entryId: string): Promise<void> {
  const response = await client.api.lorebooks[":lorebookId"].entries[":entryId"].$delete({ param: { lorebookId, entryId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function reorderLoreEntries(lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>): Promise<LoreEntryRecord[]> {
  const response = await client.api.lorebooks[":lorebookId"].entries.reorder.$patch({ param: { lorebookId }, json: { updates } });
  return unwrapRpc<LoreEntryRecord[]>(response);
}

export async function testLoreActivation(lorebookId: string, text: string): Promise<{ activatedIds: string[]; totalEntries: number }> {
  const response = await client.api.lorebooks[":lorebookId"]["test-activation"].$post({ param: { lorebookId }, json: { text } });
  return unwrapRpc<{ activatedIds: string[]; totalEntries: number }>(response);
}

export async function importLorebookEntries(lorebookId: string, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }): Promise<{ lorebookId?: string; imported: number; skipped: number; warnings: string[] }> {
  const response = await client.api.lorebooks[":lorebookId"].import.$post({ param: { lorebookId }, json: body as any });
  return unwrapRpc<{ lorebookId?: string; imported: number; skipped: number; warnings: string[] }>(response);
}
