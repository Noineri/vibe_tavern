/**
 * Characterization + regression tests for the lorebook create-body builder.
 *
 * These pin the contract of `buildLorebookCreateBody`: the active list-filter
 * `scope` (which includes `"all"`) is translated into a valid create body whose
 * `scopeType` is NEVER `"all"`. This is the pure logic that `handleAddLorebook`
 * delegates to; the regression it guards is "creating a lorebook from the `all`
 * filter must produce a concrete-scoped body (default `entity`), not `all`
 * and not a no-op" — the exact failure mode the scope/list-filter separation
 * fixed (see vibe_tavern_plan/reports/LOREBOOK_SCOPE_SEPARATION.md).
 *
 * LORE_SCRIPT_OWNERS_AS_LINKS step 2: no owner is derived from the context —
 * an entity body carries NO owner fields; owners are explicit links chosen by
 * the caller (creation-row picker is step 3).
 *
 * Mirrors `scopeBody()` in ScriptEditor.tsx (same `effectiveScope` coercion);
 * if that sibling is ever shared, these tests cover the unified helper too.
 */
import { describe, it, expect } from "bun:test";
import { buildLorebookCreateBody } from "./lorebook-create-body.js";
import type { Scope } from "./LorebookAccordion.js";

describe("buildLorebookCreateBody", () => {
	it("coerces the `all` filter to an `entity` scopeType (the regression)", () => {
		const body = buildLorebookCreateBody("all", "chat_1", "New lorebook");
		// The whole point of the fix: "all" is a display filter, never a scopeType.
		expect(body.scopeType).not.toBe("all");
		expect(body.scopeType).toBe("entity");
		// No owner is derived from the context: the body has no owner fields
		// at all (owners are explicit links; step 3 adds the picker).
		expect("characterId" in body).toBe(false);
		expect("personaId" in body).toBe(false);
		expect("links" in body).toBe(false);
		expect(body.chatId).toBeUndefined();
		expect(body.name).toBe("New lorebook");
	});

	it("builds an entity body with NO derived owner regardless of persona context", () => {
		// Before LORE_SCRIPT_OWNERS_AS_LINKS step 2 a persona context silently
		// homed the book to that persona; now nothing is derived.
		const body = buildLorebookCreateBody("entity", "chat_1", "n");
		expect(body.scopeType).toBe("entity");
		expect("characterId" in body).toBe(false);
		expect("personaId" in body).toBe(false);
		expect(body.chatId).toBeUndefined();
	});

	it("builds a global-scoped body with no owner ids for the `global` filter", () => {
		const body = buildLorebookCreateBody("global", "chat_1", "n");
		expect(body.scopeType).toBe("global");
		expect("characterId" in body).toBe(false);
		expect("personaId" in body).toBe(false);
		expect(body.chatId).toBeUndefined();
	});

	it("builds a chat-scoped body when chatId is present", () => {
		const body = buildLorebookCreateBody("chat", "chat_1", "n");
		expect(body.scopeType).toBe("chat");
		expect(body.chatId).toBe("chat_1");
		expect("characterId" in body).toBe(false);
		expect("personaId" in body).toBe(false);
	});

	it("omits chatId when chatId is null", () => {
		const body = buildLorebookCreateBody("chat", null, "n");
		expect(body.scopeType).toBe("chat");
		expect(body.chatId).toBeUndefined();
	});

	it("never returns scopeType `all` for any filter value (exhaustive guard)", () => {
		const allScopes: Scope[] = ["all", "current", "global", "entity", "chat"];
		for (const scope of allScopes) {
			const body = buildLorebookCreateBody(scope, "chat_1", "n");
			expect(body.scopeType).not.toBe("all");
		}
	});
});
