import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

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
		narratorVoiceId: null,
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

describe("TtsStore narratorVoiceId (TE2-4)", () => {
	test("create with narratorVoiceId round-trips", async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ narratorVoiceId: "af_bella" }));
		expect(created.narratorVoiceId).toBe("af_bella");
		const loaded = await store.getById(created.id);
		expect(loaded?.narratorVoiceId).toBe("af_bella");
	});

	test("create without narratorVoiceId defaults to null", async () => {
		const { store } = await setup();
		const created = await store.create(baseInput());
		expect(created.narratorVoiceId).toBeNull();
		const loaded = await store.getById(created.id);
		expect(loaded?.narratorVoiceId).toBeNull();
	});

	test("update changes narratorVoiceId and can clear to null", async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ narratorVoiceId: "af_heart" }));
		const updated = await store.update(created.id, { narratorVoiceId: "af_bella" });
		expect(updated?.narratorVoiceId).toBe("af_bella");
		const cleared = await store.update(created.id, { narratorVoiceId: null });
		expect(cleared?.narratorVoiceId).toBeNull();
		const loaded = await store.getById(created.id);
		expect(loaded?.narratorVoiceId).toBeNull();
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

describe("TtsStore typed key columns (TE2-16)", () => {
	test("create round-trips apiKey + providerRef; the config bag never carries them", async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({
				backend: TTS_BACKEND.OpenAiCompatible,
				config: { endpoint: "https://api.example.com/v1", apiKey: "smuggled", providerRef: "smuggled-too" },
				apiKey: "sk-real",
				providerRef: "provider_1",
			}),
		);
		expect(created.apiKey).toBe("sk-real");
		expect(created.providerRef).toBe("provider_1");
		// Strip-on-write: bag-sent secrets are dropped, not persisted.
		expect(created.config).toEqual({ endpoint: "https://api.example.com/v1" });
	});

	test("update tri-state: undefined keeps, empty clears, value replaces", async () => {
		const { store } = await setup();
		const p = await store.create(baseInput({ backend: TTS_BACKEND.Gemini, apiKey: "sk-1" }));
		const kept = await store.update(p.id, { name: "renamed" });
		expect(kept?.apiKey).toBe("sk-1");
		const replaced = await store.update(p.id, { apiKey: "sk-2" });
		expect(replaced?.apiKey).toBe("sk-2");
		const cleared = await store.update(p.id, { apiKey: "" });
		expect(cleared?.apiKey).toBeNull();
	});

	test("backend flip clears the stored key; flip + new key keeps the new one", async () => {
		const { store } = await setup();
		const p = await store.create(baseInput({ backend: TTS_BACKEND.OpenAiCompatible, apiKey: "sk-old" }));
		const flipped = await store.update(p.id, { backend: TTS_BACKEND.Gemini, config: {} });
		expect(flipped?.apiKey).toBeNull();
		const flippedWithKey = await store.update(p.id, { backend: TTS_BACKEND.OpenAiCompatible, apiKey: "sk-new" });
		expect(flippedWithKey?.apiKey).toBe("sk-new");
	});

	test("legacy rows with a key inside config_json are stripped on read (pre-0056 bypass defense)", async () => {
		const { store, db } = await setup();
		const profile = await store.create(baseInput({ backend: TTS_BACKEND.Gemini }));
		// Simulate a row the backfill never touched (fresh DB seeded by
		// import, restored backup): the key sits in the blob.
		await db
			.update(ttsProfiles)
			.set({ configJson: '{"apiKey":"sk-legacy","model":"tts-1"}' })
			.where(eq(ttsProfiles.id, profile.id))
			.run();
		const loaded = await store.getById(profile.id);
		expect(loaded?.config).toEqual({ model: "tts-1" });
		expect(loaded?.apiKey).toBeNull();
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
