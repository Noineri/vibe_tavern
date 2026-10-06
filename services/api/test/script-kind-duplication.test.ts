/**
 * DICE-B3 — script-kind preservation across character/persona duplication.
 *
 * The plan's B3 self-check requires "character/persona duplication round-trip
 * green": duplicating a character (or persona) that owns scripts of mixed
 * kinds must copy each script WITH its scriptKind intact, never silently
 * collapsing a dice script back to prompt. The duplication loops live in
 * CharacterRuntime.duplicate / PersonaRuntime.duplicate (the service layer);
 * this exercises them end-to-end against a real SessionRuntime on a temp DB —
 * the same boundary the production duplicate routes hit, not a store-only stub.
 *
 * Note on the plan's write scope: it listed `character-store.ts` /
 * `persona-store.ts`, but those pure DB stores never touch scripts. The actual
 * script-duplication sites are the runtime methods exercised here; the plan's
 * locator was stale (re-derived and edited in place — see the execution log).
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { brandId, type CharacterId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";

async function createTestRuntime(): Promise<{
	runtime: SessionRuntime;
	stores: StoreContainer;
	characterId: string;
	cleanup: () => Promise<void>;
}> {
	const tmpDir = resolve(tmpdir(), "vt-dice-b3-" + crypto.randomUUID().slice(0, 8));
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const created = await runtime.character.createFromScratch({
		name: "KindProbe",
		description: "owns mixed-kind scripts",
		firstMessage: "hi",
	});
	const characterId = (await runtime.getSnapshot(created.activeChatId)).character!.id;
	return {
		runtime,
		stores,
		characterId,
		cleanup: async () => {
			try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
		},
	};
}

describe("DICE-B3 — character duplication preserves scriptKind", () => {
	let runtime: SessionRuntime;
	let stores: StoreContainer;
	let characterId: string;
	let cleanup: () => Promise<void>;
	beforeAll(async () => {
		const ctx = await createTestRuntime();
		runtime = ctx.runtime;
		stores = ctx.stores;
		characterId = ctx.characterId;
		cleanup = ctx.cleanup;
	});
	afterAll(async () => { await cleanup(); });

	it("copies each character-scoped script with its kind intact (prompt + dice)", async () => {
		// Seed one prompt-kind and one dice-kind script bound to the character
		// by links (owners are links since migration 0107 — LORE_SCRIPT_OWNERS_AS_LINKS
		// step 1; the duplication loop binds the copies by links too).
		const charPrompt = await stores.scripts.create({ name: "char-prompt", scopeType: "entity", scriptKind: "prompt", enabled: true });
		await stores.scripts.addLink(charPrompt.id, "character", characterId);
		const charDice = await stores.scripts.create({ name: "char-dice", scopeType: "entity", scriptKind: "dice", enabled: true });
		await stores.scripts.addLink(charDice.id, "character", characterId);

		const dup = await runtime.character.duplicate(brandId<CharacterId>(characterId));
		// The duplicate's new character id is reachable via its seeded chat snapshot.
		const dupSnapshot = await runtime.getSnapshot(dup.activeChatId);
		const newCharacterId = dupSnapshot.character!.id;
		expect(newCharacterId).not.toBe(characterId);

		const copied = await stores.scripts.listByScope("entity", newCharacterId);
		const byName = new Map(copied.map((s) => [s.name, s]));
		expect(byName.has("char-prompt")).toBe(true);
		expect(byName.has("char-dice")).toBe(true);
		// CRITICAL: kinds are preserved — the dice script is NOT collapsed to prompt.
		expect(byName.get("char-prompt")!.scriptKind).toBe("prompt");
		expect(byName.get("char-dice")!.scriptKind).toBe("dice");
	});

	it("copies inherit origin without trust, and the response counts the turned-off imports (SS-4 decision 9 + owner count decision)", async () => {
		// Seed: a live trusted import, a never-enabled import, and a live in-app
		// script — only the first should arrive as a turned-off copy.
		const liveImport = await stores.scripts.create({ name: "live-import", scopeType: "entity", scriptKind: "prompt", origin: "imported", enabled: true });
		await stores.scripts.addLink(liveImport.id, "character", characterId);
		const neverEnabledImport = await stores.scripts.create({ name: "never-import", scopeType: "entity", scriptKind: "dice", origin: "imported", enabled: false });
		await stores.scripts.addLink(neverEnabledImport.id, "character", characterId);
		const ownScript = await stores.scripts.create({ name: "own-live", scopeType: "entity", scriptKind: "prompt", enabled: true });
		await stores.scripts.addLink(ownScript.id, "character", characterId);

		const dup = await runtime.character.duplicate(brandId<CharacterId>(characterId));
		// Only the ENABLED import was turned off by duplication — the count is the
		// notification payload for the web (SS-6), never silent.
		expect(dup.disabledImportedScripts).toBe(1);

		const dupSnapshot = await runtime.getSnapshot(dup.activeChatId);
		const newCharacterId = dupSnapshot.character!.id;
		const copies = await stores.scripts.listByScope("entity", newCharacterId);
		const byName = new Map(copies.map((s) => [s.name, s]));
		const copyImport = byName.get("live-import")!;
		expect(copyImport.origin).toBe("imported");
		expect(copyImport.enabled).toBe(false);
		expect(copyImport.firstEnabledAt).toBeNull();
		const copyNever = byName.get("never-import")!;
		expect(copyNever.origin).toBe("imported");
		expect(copyNever.enabled).toBe(false);
		const copyOwn = byName.get("own-live")!;
		expect(copyOwn.origin).toBe("in_app");
		expect(copyOwn.enabled).toBe(true);

		// The untrusted copy reaches trust only through its OWN first enable.
		const trusted = await stores.scripts.update(copyImport.id, { enabled: true });
		expect(trusted.enabled).toBe(true);
		expect(typeof trusted.firstEnabledAt).toBe("string");
	});

	it("an all-in-app character duplicates with a zero count (no turn-offs to surface)", async () => {
		// A FRESH character (this describe's shared one accumulated imported
		// scripts in the previous test) — duplicating it counts zero turn-offs.
		const fresh = await runtime.character.createFromScratch({
			name: "AllOwn",
			description: "no imported scripts",
			firstMessage: "hi",
		});
		const freshId = (await runtime.getSnapshot(fresh.activeChatId)).character!.id;
		const own = await stores.scripts.create({ name: "solo-own", scopeType: "entity", scriptKind: "prompt", enabled: true });
		await stores.scripts.addLink(own.id, "character", freshId);
		const dup = await runtime.character.duplicate(brandId<CharacterId>(freshId));
		expect(dup.disabledImportedScripts).toBe(0);
	});
});

	describe("DICE-B3 — persona duplication preserves scriptKind", () => {
	let runtime: SessionRuntime;
	let stores: StoreContainer;
	let cleanup: () => Promise<void>;

	beforeAll(async () => {
		const ctx = await createTestRuntime();
		runtime = ctx.runtime;
		stores = ctx.stores;
		cleanup = ctx.cleanup;
	});
	afterAll(async () => { await cleanup(); });

	it("copies each persona-scoped script with its kind intact (prompt + dice)", async () => {
		const persona = await stores.personas.getDefault();
		expect(persona).not.toBeNull();
		const personaId = persona!.id;

		const personaPrompt = await stores.scripts.create({ name: "persona-prompt", scopeType: "entity", scriptKind: "prompt", enabled: true });
		await stores.scripts.addLink(personaPrompt.id, "persona", personaId);
		const personaDice = await stores.scripts.create({ name: "persona-dice", scopeType: "entity", scriptKind: "dice", enabled: true });
		await stores.scripts.addLink(personaDice.id, "persona", personaId);

		const dup = await runtime.persona.duplicate(personaId);
		// PersonaRuntime.duplicate returns the new persona record.
		const copied = await stores.scripts.listByScope("entity", dup.id);
		const byName = new Map(copied.map((s) => [s.name, s]));
		expect(byName.has("persona-prompt")).toBe(true);
		expect(byName.has("persona-dice")).toBe(true);
		expect(byName.get("persona-prompt")!.scriptKind).toBe("prompt");
		expect(byName.get("persona-dice")!.scriptKind).toBe("dice");
	});

	it("persona copies inherit origin without trust, and the response counts the turned-off imports (SS-4 decision 9 + owner count decision)", async () => {
		const persona = await stores.personas.getDefault();
		expect(persona).not.toBeNull();
		const personaId = persona!.id;

		const liveImport = await stores.scripts.create({ name: "p-live-import", scopeType: "entity", scriptKind: "prompt", origin: "imported", enabled: true });
		await stores.scripts.addLink(liveImport.id, "persona", personaId);
		const neverEnabledImport = await stores.scripts.create({ name: "p-never-import", scopeType: "entity", scriptKind: "dice", origin: "imported", enabled: false });
		await stores.scripts.addLink(neverEnabledImport.id, "persona", personaId);

		const dup = await runtime.persona.duplicate(personaId);
		// Only the ENABLED import was turned off — the count rides the wire for SS-6.
		expect(dup.disabledImportedScripts).toBe(1);

		const copies = await stores.scripts.listByScope("entity", dup.id);
		const byName = new Map(copies.map((s) => [s.name, s]));
		const copyImport = byName.get("p-live-import")!;
		expect(copyImport.origin).toBe("imported");
		expect(copyImport.enabled).toBe(false);
		expect(copyImport.firstEnabledAt).toBeNull();
		const copyNever = byName.get("p-never-import")!;
		expect(copyNever.origin).toBe("imported");
		expect(copyNever.enabled).toBe(false);
		// The in-app scripts seeded by the kind test keep their enabled state.
		expect(byName.get("persona-prompt")!.origin).toBe("in_app");
		expect(byName.get("persona-prompt")!.enabled).toBe(true);
	});
});
