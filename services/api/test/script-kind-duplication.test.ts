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
		// Seed one prompt-kind and one dice-kind character-scoped script.
		await stores.scripts.create({ name: "char-prompt", scopeType: "character", characterId, scriptKind: "prompt", enabled: true });
		await stores.scripts.create({ name: "char-dice", scopeType: "character", characterId, scriptKind: "dice", enabled: true });

		const dup = await runtime.character.duplicate(characterId as never);
		// The duplicate's new character id is reachable via its seeded chat snapshot.
		const dupSnapshot = await runtime.getSnapshot(dup.activeChatId);
		const newCharacterId = dupSnapshot.character!.id;
		expect(newCharacterId).not.toBe(characterId);

		const copied = await stores.scripts.listByScope("character", newCharacterId);
		const byName = new Map(copied.map((s) => [s.name, s]));
		expect(byName.has("char-prompt")).toBe(true);
		expect(byName.has("char-dice")).toBe(true);
		// CRITICAL: kinds are preserved — the dice script is NOT collapsed to prompt.
		expect(byName.get("char-prompt")!.scriptKind).toBe("prompt");
		expect(byName.get("char-dice")!.scriptKind).toBe("dice");
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

		await stores.scripts.create({ name: "persona-prompt", scopeType: "persona", personaId, scriptKind: "prompt", enabled: true });
		await stores.scripts.create({ name: "persona-dice", scopeType: "persona", personaId, scriptKind: "dice", enabled: true });

		const dup = await runtime.persona.duplicate(personaId);
		// PersonaRuntime.duplicate returns the new persona record.
		const copied = await stores.scripts.listByScope("persona", dup.id);
		const byName = new Map(copied.map((s) => [s.name, s]));
		expect(byName.has("persona-prompt")).toBe(true);
		expect(byName.has("persona-dice")).toBe(true);
		expect(byName.get("persona-prompt")!.scriptKind).toBe("prompt");
		expect(byName.get("persona-dice")!.scriptKind).toBe("dice");
	});
});
