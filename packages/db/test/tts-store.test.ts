import { describe, expect, test } from "bun:test";

import { TTS_BACKEND, TTS_TARGET_TYPE } from "@vibe-tavern/domain";

import { createDb } from "../src/db-connection.js";
import { ttsProfiles } from "../src/db-schema.js";
import { TtsStore } from "../src/stores/tts-store.js";
import type { CreateTtsProfileData } from "../src/stores/tts-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-08-27T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const db = await createDb(":memory:");
	const store = new TtsStore(db, { clock: fixedClock, idGenerator: idGen });
	return { store, db };
}

let inputCounter = 0;
function baseInput(overrides: Partial<CreateTtsProfileData> = {}): CreateTtsProfileData {
	inputCounter += 1;
	return {
		name: `tts_${inputCounter}`,
		backend: TTS_BACKEND.Kokoro,
		config: {},
		voiceId: "af_heart",
		lang: "en",
		sortOrder: 0,
		isDefault: false,
		...overrides,
	};
}

describe("TtsStore CRUD", () => {
	test("create → getById round-trips the config bag and booleans", async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({
				name: "Gemini — Kore",
				backend: TTS_BACKEND.Gemini,
				config: { apiKeyRef: "key_1", model: "gemini-2.5-flash-preview-tts", style: "Speak warmly" },
				voiceId: "Kore",
				lang: "en",
				isDefault: true,
				sortOrder: 3,
			}),
		);

		expect(created.id).toStartWith("tts_profile_");
		expect(created.createdAt).toBe(fixedClock.now());
		expect(created.updatedAt).toBe(fixedClock.now());
		expect(created.config).toEqual({
			apiKeyRef: "key_1",
			model: "gemini-2.5-flash-preview-tts",
			style: "Speak warmly",
		});

		const loaded = await store.getById(created.id);
		expect(loaded).toEqual(created);
	});

	test("create claiming default clears the previous default pointer", async () => {
		const { store } = await setup();
		const first = await store.create(baseInput({ isDefault: true }));
		const second = await store.create(baseInput({ isDefault: true }));

		const reloadedFirst = await store.getById(first.id);
		expect(reloadedFirst?.isDefault).toBe(false);
		expect((await store.getById(second.id))?.isDefault).toBe(true);

		const def = await store.getDefault();
		expect(def?.id).toBe(second.id);
	});

	test("getDefault returns null when no profile is default", async () => {
		const { store } = await setup();
		await store.create(baseInput({ isDefault: false }));
		expect(await store.getDefault()).toBeNull();
	});

	test("update patches fields, serializes config, bumps updatedAt; unknown id → null", async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ sortOrder: 1 }));

		const updated = await store.update(created.id, {
			name: "Kokoro — Bella",
			voiceId: "af_bella",
			config: { speed: 1.2 },
		});
		expect(updated?.name).toBe("Kokoro — Bella");
		expect(updated?.voiceId).toBe("af_bella");
		expect(updated?.config).toEqual({ speed: 1.2 });
		expect(updated?.createdAt).toBe(created.createdAt);
		expect(updated?.updatedAt).toBe(fixedClock.now());

		expect(await store.update("tts_profile_missing", { name: "x" })).toBeNull();
	});

	test("setDefault moves the pointer atomically; unknown id → null", async () => {
		const { store } = await setup();
		const first = await store.create(baseInput({ isDefault: true }));
		const second = await store.create(baseInput());

		const moved = await store.setDefault(second.id);
		expect(moved?.isDefault).toBe(true);
		expect((await store.getById(first.id))?.isDefault).toBe(false);
		expect((await store.getDefault())?.id).toBe(second.id);

		expect(await store.setDefault("tts_profile_missing")).toBeNull();
	});

	test("deleting the default leaves no auto-promoted default", async () => {
		const { store } = await setup();
		const first = await store.create(baseInput({ isDefault: true }));
		await store.create(baseInput());

		await store.delete(first.id);
		expect(await store.getDefault()).toBeNull();
	});

	test("listAll orders by sortOrder then name", async () => {
		const { store } = await setup();
		await store.create(baseInput({ name: "zeta", sortOrder: 1 }));
		await store.create(baseInput({ name: "alpha", sortOrder: 1 }));
		await store.create(baseInput({ name: "mid", sortOrder: 0 }));

		const names = (await store.listAll()).map((p) => p.name);
		expect(names).toEqual(["mid", "alpha", "zeta"]);
	});
});

describe("TtsStore links (voice map)", () => {
	test("addLink is idempotent; getLinks returns branded bindings; removeLink deletes one", async () => {
		const { store } = await setup();
		const profile = await store.create(baseInput());

		await store.addLink(profile.id, TTS_TARGET_TYPE.Character, "char_1");
		await store.addLink(profile.id, TTS_TARGET_TYPE.Character, "char_1"); // duplicate: composite PK ignores
		await store.addLink(profile.id, TTS_TARGET_TYPE.Persona, "persona_1");

		let links = await store.getLinks(profile.id);
		expect(links).toHaveLength(2);
		expect(links.map((l) => `${l.targetType}:${l.targetId}`).sort()).toEqual([
			"character:char_1",
			"persona:persona_1",
		]);

		await store.removeLink(profile.id, TTS_TARGET_TYPE.Character, "char_1");
		links = await store.getLinks(profile.id);
		expect(links).toHaveLength(1);
		expect(links[0]?.targetType).toBe(TTS_TARGET_TYPE.Persona);
	});

	test("setLinks replaces the whole set and dedups before delete", async () => {
		const { store } = await setup();
		const profile = await store.create(baseInput());

		await store.addLink(profile.id, TTS_TARGET_TYPE.Character, "char_old");
		const links = await store.setLinks(profile.id, [
			{ targetType: TTS_TARGET_TYPE.Character, targetId: "char_1" },
			{ targetType: TTS_TARGET_TYPE.Character, targetId: "char_1" }, // dedup
			{ targetType: TTS_TARGET_TYPE.Persona, targetId: "persona_1" },
		]);

		expect(links).toHaveLength(2);
		const ids = links.map((l) => `${l.targetType}:${l.targetId}`).sort();
		expect(ids).toEqual(["character:char_1", "persona:persona_1"]);
		// Links written without an explicit mode default to voice.
		expect(links.every((l) => l.mode === "voice")).toBe(true);
	});

	test("setLinks persists mode; disabled links survive the round-trip (TS-9a-foundation)", async () => {
		const { store } = await setup();
		const profile = await store.create(baseInput());

		const links = await store.setLinks(profile.id, [
			{ targetType: TTS_TARGET_TYPE.Character, targetId: "char_voiced" },
			{ targetType: TTS_TARGET_TYPE.Character, targetId: "char_muted", mode: "disabled" },
			{ targetType: TTS_TARGET_TYPE.Persona, targetId: "persona_1", mode: "voice" },
		]);

		expect(links).toHaveLength(3);
		const byId = new Map(links.map((l) => [l.targetId, l]));
		expect(byId.get("char_voiced")?.mode).toBe("voice");
		expect(byId.get("char_muted")?.mode).toBe("disabled");
		expect(byId.get("persona_1")?.mode).toBe("voice");

		// addLink carries mode too and stays idempotent.
		await store.addLink(profile.id, TTS_TARGET_TYPE.Persona, "persona_2", "disabled");
		const after = await store.getLinks(profile.id);
		expect(after.find((l) => l.targetId === "persona_2")?.mode).toBe("disabled");
	});

	test("deleteLinksForTarget removes only links targeting that entity", async () => {
		const { store } = await setup();
		const a = await store.create(baseInput());
		const b = await store.create(baseInput());

		await store.addLink(a.id, TTS_TARGET_TYPE.Character, "char_dead");
		await store.addLink(b.id, TTS_TARGET_TYPE.Character, "char_dead");
		await store.addLink(b.id, TTS_TARGET_TYPE.Persona, "persona_alive");

		await store.deleteLinksForTarget(TTS_TARGET_TYPE.Character, "char_dead");

		expect(await store.getLinks(a.id)).toHaveLength(0);
		const bLinks = await store.getLinks(b.id);
		expect(bLinks).toHaveLength(1);
		expect(bLinks[0]?.targetId).toBe("persona_alive");
	});

	test("deleting a profile cascades its links away via the FK", async () => {
		const { store } = await setup();
		const profile = await store.create(baseInput());
		await store.addLink(profile.id, TTS_TARGET_TYPE.Character, "char_1");

		await store.delete(profile.id);
		expect(await store.getLinks(profile.id)).toHaveLength(0);
	});

	test("listAllLinks returns links across all profiles with modes; empty table → []", async () => {
		const { store } = await setup();
		let empty = await store.listAllLinks();
		expect(empty).toEqual([]);

		const a = await store.create(baseInput());
		const b = await store.create(baseInput());
		await store.addLink(a.id, TTS_TARGET_TYPE.Character, "char_1");
		await store.setLinks(b.id, [
			{ targetType: TTS_TARGET_TYPE.Character, targetId: "char_2", mode: "voice" },
			{ targetType: TTS_TARGET_TYPE.Persona, targetId: "persona_1", mode: "disabled" },
		]);

		const all = await store.listAllLinks();
		expect(all).toHaveLength(3);
		const modes = new Map(all.map((l) => [`${l.targetType}:${l.targetId}`, l.mode]));
		expect(modes.get("character:char_1")).toBe("voice");
		expect(modes.get("character:char_2")).toBe("voice");
		expect(modes.get("persona:persona_1")).toBe("disabled");
	});
});

describe("TtsStore JSON hygiene", () => {
	test("malformed configJson and unknown backend slugs degrade instead of throwing", async () => {
		const { store, db } = await setup();
		const profile = await store.create(baseInput());
		// Simulate hand-edited / forward-versioned rows.
		await db.run(
			"UPDATE tts_profiles SET config_json = '{broken', backend = 'minimax' WHERE id = ?",
			profile.id,
		);

		const loaded = await store.getById(profile.id);
		expect(loaded?.config).toEqual({});
		// Unknown future slug degrades to the zero-setup default backend so the
		// row stays visible/editable in the list (house pattern: reads never
		// crash on forward-compatible data).
		expect(loaded?.backend).toBe(TTS_BACKEND.Kokoro);
	});

	test("fresh :memory: db applies the tts migration (tables exist)", async () => {
		const { db } = await setup();
		const row = db.select().from(ttsProfiles).all();
		expect(row).toEqual([]);
	});
});
