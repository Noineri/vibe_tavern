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
 * Mirrors `scopeBody()` in ScriptEditor.tsx (same `effectiveScope` coercion);
 * if that sibling is ever shared, these tests cover the unified helper too.
 */
import { describe, it, expect } from "bun:test";
import { buildLorebookCreateBody } from "./lorebook-create-body.js";
import type { Scope } from "./LorebookAccordion.js";

const IDS = {
	characterId: "char_1",
	personaId: "persona_1",
	chatId: "chat_1",
};

const IDS_NO_PERSONA = {
	characterId: "char_1",
	personaId: null,
	chatId: "chat_1",
};

const IDS_NO_CHAT = {
	characterId: "char_1",
	personaId: "persona_1",
	chatId: null,
};

describe("buildLorebookCreateBody", () => {
	it("coerces the `all` filter to an `entity` scopeType (the regression)", () => {
		const body = buildLorebookCreateBody("all", IDS_NO_PERSONA, "New lorebook");
		// The whole point of the fix: "all" is a display filter, never a scopeType.
		expect(body.scopeType).not.toBe("all");
		expect(body.scopeType).toBe("entity");
		// An entity home always carries exactly one typed owner FK.
		expect(body.characterId).toBe("char_1");
		expect(body.personaId).toBeUndefined();
		expect(body.chatId).toBeUndefined();
		expect(body.name).toBe("New lorebook");
	});

	it("builds an entity body homed to the character when no persona context is active", () => {
		const body = buildLorebookCreateBody("entity", IDS_NO_PERSONA, "n");
		expect(body.scopeType).toBe("entity");
		expect(body.characterId).toBe("char_1");
		expect(body.personaId).toBeUndefined();
		expect(body.chatId).toBeUndefined();
	});

	it("builds an entity body homed to the persona when a persona context is active", () => {
		const body = buildLorebookCreateBody("entity", IDS, "n");
		expect(body.scopeType).toBe("entity");
		expect(body.personaId).toBe("persona_1");
		// Exactly one typed owner FK — the character FK must stay empty.
		expect(body.characterId).toBeUndefined();
		expect(body.chatId).toBeUndefined();
	});

	it("builds a global-scoped body with no owner ids for the `global` filter", () => {
		const body = buildLorebookCreateBody("global", IDS, "n");
		expect(body.scopeType).toBe("global");
		expect(body.characterId).toBeUndefined();
		expect(body.personaId).toBeUndefined();
		expect(body.chatId).toBeUndefined();
	});

	it("builds a chat-scoped body when chatId is present", () => {
		const body = buildLorebookCreateBody("chat", IDS, "n");
		expect(body.scopeType).toBe("chat");
		expect(body.chatId).toBe("chat_1");
		expect(body.characterId).toBeUndefined();
		expect(body.personaId).toBeUndefined();
	});

	it("omits chatId when chatId is null", () => {
		const body = buildLorebookCreateBody("chat", IDS_NO_CHAT, "n");
		expect(body.scopeType).toBe("chat");
		expect(body.chatId).toBeUndefined();
	});

	it("never returns scopeType `all` for any filter value (exhaustive guard)", () => {
		const allScopes: Scope[] = ["all", "global", "entity", "chat"];
		for (const scope of allScopes) {
			const body = buildLorebookCreateBody(scope, IDS, "n");
			expect(body.scopeType).not.toBe("all");
		}
	});
});
