/**
 * Pure create-body builder for lorebooks.
 *
 * Extracted from LorebookEditor so the scope→body translation is testable
 * without dragging in the component's module graph (RPC client, stores, DOM).
 * Mirrors `lore-entry-reorder.ts` — same "pure helper colocated next to the
 * component that uses it" pattern.
 *
 * `scope` is the LIST FILTER and includes `"all"` and `"current"` (the
 * overview and participating-chat view). Neither is a valid scopeType for a
 * real lorebook, so either is coerced to the editor's primary context
 * (`"entity"`). The create flow opens the inline edit form immediately
 * after, where the scope picker lets the user change it — so a fixed,
 * predictable default is correct, independent of the active filter.
 *
 * LORE_SCRIPT_OWNERS_AS_LINKS step 3: an entity-scoped book explicitly links
 * the current character at creation. The inline owner picker makes that link
 * visible and lets the user change or clear it. Only `chatId` rides along for
 * chat scope.
 *
 * Mirrors `scopeBody()` in ScriptEditor.tsx (same `effectiveScope` coercion);
 * if that sibling is ever shared, this is the natural home for the unified
 * helper.
 */
import type { Scope } from "./LorebookAccordion.js";

export type LorebookCreateBody = {
	name: string;
	scopeType: string;
	links?: Array<{ targetType: "character"; targetId: string }>;
	chatId?: string;
};

export function buildLorebookCreateBody(
	scope: Scope,
	chatId: string | null,
	characterId: string,
	name: string,
): LorebookCreateBody {
	const effectiveScope: Exclude<Scope, "all" | "current"> =
		scope === "all" || scope === "current" ? "entity" : scope;
	const body: LorebookCreateBody = {
		name,
		scopeType: effectiveScope,
	};
	if (effectiveScope === "entity") {
		body.links = [{ targetType: "character", targetId: characterId }];
	}
	if (effectiveScope === "chat" && chatId) body.chatId = chatId;
	return body;
}
