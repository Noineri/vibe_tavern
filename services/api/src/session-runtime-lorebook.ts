import type { LoreEntry } from "@rp-platform/domain";

const NOT_IMPLEMENTED = () => { throw new Error("Not implemented: lorebooks are phase 2"); };

export interface LorebookModuleDeps {}

export function createLoreEntry(): LoreEntry { NOT_IMPLEMENTED(); }
export function updateLoreEntry(): LoreEntry { NOT_IMPLEMENTED(); }
export function deleteLoreEntry(): void { NOT_IMPLEMENTED(); }
export function listLoreEntries(): LoreEntry[] { NOT_IMPLEMENTED(); }
export function testLoreActivation(): { activatedIds: string[]; totalEntries: number } { NOT_IMPLEMENTED(); }
