import type { LoreEntry } from "@vibe-tavern/domain";

const NOT_IMPLEMENTED = () => { throw new Error("Not implemented: lorebooks are phase 2"); };

export interface LorebookModuleDeps {}

export function createLoreEntry(): LoreEntry { return NOT_IMPLEMENTED(); }
export function updateLoreEntry(): LoreEntry { return NOT_IMPLEMENTED(); }
export function deleteLoreEntry(): void { NOT_IMPLEMENTED(); }
export function listLoreEntries(): LoreEntry[] { return NOT_IMPLEMENTED(); }
export function testLoreActivation(): { activatedIds: string[]; totalEntries: number } { return NOT_IMPLEMENTED(); }
