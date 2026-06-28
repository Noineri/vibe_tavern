/**
 * Pure create-body builder for lorebooks.
 *
 * Extracted from LorebookEditor so the scope→body translation is testable
 * without dragging in the component's module graph (RPC client, stores, DOM).
 * Mirrors `lore-entry-reorder.ts` — same "pure helper colocated next to the
 * component that uses it" pattern.
 *
 * `scope` is the LIST FILTER and includes `"all"` (the overview). `"all"` is
 * NOT a valid scopeType for a real lorebook, so it is coerced to the editor's
 * primary context (`"character"`, which always has a characterId). The create
 * flow opens the inline edit form immediately after, where the scope picker
 * lets the user change it — so a fixed, predictable default is correct,
 * independent of the active filter.
 *
 * Mirrors `scopeBody()` in ScriptEditor.tsx (same `effectiveScope` coercion);
 * if that sibling is ever shared, this is the natural home for the unified
 * helper.
 */
import type { Scope } from "./LorebookAccordion.js";

export type LorebookCreateBody = {
	name: string;
	scopeType: string;
	characterId?: string;
	personaId?: string;
	chatId?: string;
};

export function buildLorebookCreateBody(
	scope: Scope,
	ids: { characterId: string; personaId: string | null; chatId: string | null },
	name: string,
): LorebookCreateBody {
	const effectiveScope: Exclude<Scope, "all"> = scope === "all" ? "character" : scope;
	const body: LorebookCreateBody = {
		name,
		scopeType: effectiveScope,
	};
	if (effectiveScope === "character") body.characterId = ids.characterId;
	if (effectiveScope === "persona" && ids.personaId) body.personaId = ids.personaId;
	if (effectiveScope === "chat" && ids.chatId) body.chatId = ids.chatId;
	return body;
}
