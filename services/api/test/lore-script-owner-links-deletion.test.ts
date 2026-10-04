/**
 * LORE_SCRIPT_OWNERS_AS_LINKS step 2 — owner deletion pinned at the real
 * boundary.
 *
 * Deleting a character or persona must delete its lorebook and script LINK
 * ROWS (the RegexStore.deleteLinksForTarget pattern — the junction's
 * polymorphic `target_id` has no FK, so cleanup can only be app-level) while
 * the BOOKS and SCRIPTS themselves survive for their other owners. Before
 * step 2 nothing cleaned these link rows: a deleted owner left ghost link
 * rows the bindings UI rendered as nameless rows (and before migration 0107
 * the home-FK cascade had deleted the whole book).
 *
 * This drives the REAL SessionRuntime (route → adapter →
 * sessionRuntime.character.delete / persona.delete → store
 * deleteLinksForTarget) on a temp SQLite — same pattern as
 * character-delete-regex-links.test.ts, no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";

let env: Awaited<ReturnType<typeof createEnv>>;

async function createEnv() {
	const tmpDir = resolve(tmpdir(), "vt-lore-owner-del-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	return {
		runtime,
		stores,
		tmpDir,
		cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} },
	};
}

describe("owner delete → lorebook/script link rows (LORE_SCRIPT_OWNERS_AS_LINKS step 2)", () => {
	beforeAll(async () => {
		setTokenCountFn((text: string) => text.length);
		env = await createEnv();
	});

	afterAll(async () => { if (env) await env.cleanup(); });

	it("character deletion removes its lorebook/script link rows; books and scripts survive with their other links", async () => {
		const doomed = await env.stores.characters.create({ name: "Doomed" });
		const other = await env.stores.characters.create({ name: "Other" });

		// Book linked to BOTH characters + book linked to the doomed one only.
		const shared = await env.stores.lorebooks.createLorebook({
			name: "shared-book",
			scopeType: "entity",
			links: [
				{ targetType: "character", targetId: doomed.id },
				{ targetType: "character", targetId: other.id },
			],
		});
		const doomedOnly = await env.stores.lorebooks.createLorebook({
			name: "doomed-only-book",
			scopeType: "entity",
			links: [{ targetType: "character", targetId: doomed.id }],
		});
		// Same pair of shapes on the script side.
		const sharedScript = await env.stores.scripts.create({
			name: "shared-script",
			scopeType: "entity",
			links: [
				{ targetType: "character", targetId: doomed.id },
				{ targetType: "character", targetId: other.id },
			],
		});
		const doomedOnlyScript = await env.stores.scripts.create({
			name: "doomed-only-script",
			scopeType: "entity",
			links: [{ targetType: "character", targetId: doomed.id }],
		});

		// The production route path: adapter → sessionRuntime.character.delete.
		await env.runtime.character.delete(doomed.id);

		expect(await env.stores.characters.getById(doomed.id)).toBeNull();
		// NO cascade: the books and scripts themselves survive…
		expect((await env.stores.lorebooks.getLorebook(shared.id))?.name).toBe("shared-book");
		expect((await env.stores.lorebooks.getLorebook(doomedOnly.id))?.name).toBe("doomed-only-book");
		expect((await env.stores.scripts.getById(sharedScript.id))?.name).toBe("shared-script");
		expect((await env.stores.scripts.getById(doomedOnlyScript.id))?.name).toBe("doomed-only-script");
		// …only the deleted character's LINK ROWS die; other links survive.
		expect((await env.stores.lorebooks.getLinks(shared.id)).map((l) => l.targetId)).toEqual([other.id]);
		expect(await env.stores.lorebooks.getLinks(doomedOnly.id)).toEqual([]);
		expect((await env.stores.scripts.getLinks(sharedScript.id)).map((l) => l.targetId)).toEqual([other.id]);
		expect(await env.stores.scripts.getLinks(doomedOnlyScript.id)).toEqual([]);
		// The orphaned book can be re-bound by hand.
		await env.stores.lorebooks.addLink(doomedOnly.id, "character", other.id);
		expect((await env.stores.lorebooks.getLinks(doomedOnly.id))[0]!.targetId).toBe(other.id);
	});

	it("persona deletion removes its lorebook/script link rows; books and scripts survive with their other links", async () => {
		const doomedPersona = await env.stores.personas.create({ name: "Doomed persona" });
		const otherPersona = await env.stores.personas.create({ name: "Other persona" });

		const shared = await env.stores.lorebooks.createLorebook({
			name: "persona-shared-book",
			scopeType: "entity",
			links: [
				{ targetType: "persona", targetId: doomedPersona.id },
				{ targetType: "persona", targetId: otherPersona.id },
			],
		});
		const doomedOnly = await env.stores.lorebooks.createLorebook({
			name: "persona-doomed-only-book",
			scopeType: "entity",
			links: [{ targetType: "persona", targetId: doomedPersona.id }],
		});
		const sharedScript = await env.stores.scripts.create({
			name: "persona-shared-script",
			scopeType: "entity",
			links: [
				{ targetType: "persona", targetId: doomedPersona.id },
				{ targetType: "persona", targetId: otherPersona.id },
			],
		});
		const doomedOnlyScript = await env.stores.scripts.create({
			name: "persona-doomed-only-script",
			scopeType: "entity",
			links: [{ targetType: "persona", targetId: doomedPersona.id }],
		});

		// The production route path: adapter → sessionRuntime.persona.delete.
		await env.runtime.persona.delete(doomedPersona.id);

		// NO cascade: everything survives; only the persona's link rows die.
		expect((await env.stores.lorebooks.getLorebook(shared.id))?.name).toBe("persona-shared-book");
		expect((await env.stores.lorebooks.getLorebook(doomedOnly.id))?.name).toBe("persona-doomed-only-book");
		expect((await env.stores.scripts.getById(sharedScript.id))?.name).toBe("persona-shared-script");
		expect((await env.stores.scripts.getById(doomedOnlyScript.id))?.name).toBe("persona-doomed-only-script");
		expect((await env.stores.lorebooks.getLinks(shared.id)).map((l) => l.targetId)).toEqual([otherPersona.id]);
		expect(await env.stores.lorebooks.getLinks(doomedOnly.id)).toEqual([]);
		expect((await env.stores.scripts.getLinks(sharedScript.id)).map((l) => l.targetId)).toEqual([otherPersona.id]);
		expect(await env.stores.scripts.getLinks(doomedOnlyScript.id)).toEqual([]);
	});
});
