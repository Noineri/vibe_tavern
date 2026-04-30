import type { ChatSessionStore } from "@rp-platform/db";
import { ENTITY_ID_NAMESPACE } from "@rp-platform/domain";
import type { LoreEntry, Lorebook } from "@rp-platform/domain";
import {
  activateLoreEntries,
  type ActivatableLoreEntry,
} from "@rp-platform/prompt-pipeline";

export interface LorebookModuleDeps {
  store: ChatSessionStore;
}

export function createLoreEntry(deps: LorebookModuleDeps, lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry {
  let resolvedLorebookId = lorebookId;
  const existing = deps.store.listLoreEntriesForCharacter(lorebookId);
  if (existing.length > 0 && existing[0].lorebookId) {
    resolvedLorebookId = existing[0].lorebookId;
  } else {
    const lorebook: Lorebook = {
      id: `${ENTITY_ID_NAMESPACE.lorebook}_${Date.now()}`,
      name: `${lorebookId} lorebook`,
      scopeType: "character",
      description: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    deps.store.upsertLorebook(lorebook);
    deps.store.linkCharacterLorebook(lorebookId, lorebook.id);
    resolvedLorebookId = lorebook.id;
  }
  return deps.store.createLoreEntry(resolvedLorebookId, input);
}

export function updateLoreEntry(deps: LorebookModuleDeps, _lorebookId: string, entryId: string, input: Partial<Omit<LoreEntry, "id" | "lorebookId">>): LoreEntry {
  return deps.store.updateLoreEntry(entryId, input);
}

export function deleteLoreEntry(deps: LorebookModuleDeps, _lorebookId: string, entryId: string): void {
  deps.store.deleteLoreEntry(entryId);
}

export function listLoreEntries(deps: LorebookModuleDeps, lorebookId: string): LoreEntry[] {
  return deps.store.listLoreEntriesForCharacter(lorebookId);
}

export function testLoreActivation(
  deps: LorebookModuleDeps,
  lorebookId: string,
  text: string,
): { activatedIds: string[]; totalEntries: number } {
  const entries = listLoreEntries(deps, lorebookId);
  const activatable: ActivatableLoreEntry[] = entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    content: entry.content,
    keys: entry.keys,
    secondaryKeys: entry.secondaryKeys,
    logic: entry.logic,
    position: entry.position,
    priority: entry.priority,
    enabled: entry.enabled,
  }));
  const activated = activateLoreEntries(activatable, {
    recentMessagesText: text,
  });
  return {
    activatedIds: activated.map((entry) => entry.id),
    totalEntries: entries.length,
  };
}
