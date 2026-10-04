import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { UiSettingsStore } from "../src/stores/ui-settings-store.js";
import { ProviderStore, type CreateProviderData } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const testClock: StoreClock = { now: () => "2026-06-06T00:00:00.000Z" };
let nextId = 0;
const testIdGen: StoreIdGenerator = { next: (prefix: string) => `${prefix}_test_${++nextId}` };

const baseProfile: CreateProviderData = {
	name: "Shared",
	providerPreset: "custom",
	endpoint: "https://localhost/v1",
};

async function mkSettingsStore() {
	const dir = await mkdtemp(join(tmpdir(), "vt-ui-set-test-"));
	const db = await createDb(join(dir, "test.db"));
	return {
		settings: new UiSettingsStore(db, { clock: testClock, idGenerator: testIdGen }),
		providers: new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null }),
	};
}

describe("UiSettingsStore — chat impersonation draft enhancement", () => {
	test("defaults off and persists the enhancement toggle", async () => {
		const { settings } = await mkSettingsStore();
		expect((await settings.get()).chatImpersonateEnhanceDraft).toBe(false);

		await settings.update({ chatImpersonateEnhanceDraft: true });
		expect((await settings.get()).chatImpersonateEnhanceDraft).toBe(true);
	});
});

describe("UiSettingsStore — per-context secondary-model pairs (SUM-5)", () => {
	test("defaults are null for the summary and message-editor pairs", async () => {
		const { settings } = await mkSettingsStore();
		const got = await settings.get();
		expect(got.summaryProviderId).toBeNull();
		expect(got.summaryModelName).toBeNull();
		expect(got.messageEditorProviderId).toBeNull();
		expect(got.messageEditorModelName).toBeNull();
	});

	test("persists and clears each context pair independently", async () => {
		const { settings } = await mkSettingsStore();
		await settings.update({
			summaryProviderId: "prov_a",
			summaryModelName: "glm-5.2",
			messageEditorProviderId: "prov_b",
			messageEditorModelName: "gpt-x",
		});
		let got = await settings.get();
		expect(got.summaryProviderId).toBe("prov_a");
		expect(got.summaryModelName).toBe("glm-5.2");
		expect(got.messageEditorProviderId).toBe("prov_b");
		expect(got.messageEditorModelName).toBe("gpt-x");

		// Clearing the summary pin leaves the editor pair untouched — the two
		// contexts no longer share one slot (the SUM-5 leak).
		await settings.update({ summaryProviderId: null, summaryModelName: null });
		got = await settings.get();
		expect(got.summaryProviderId).toBeNull();
		expect(got.summaryModelName).toBeNull();
		expect(got.messageEditorProviderId).toBe("prov_b");
		expect(got.messageEditorModelName).toBe("gpt-x");
	});
});

describe("UiSettingsStore — coauthor binding fields", () => {
	test("defaults are null for the coauthor binding and the lore model pair", async () => {
		const { settings } = await mkSettingsStore();
		const got = await settings.get();
		expect(got.coauthorProviderId).toBeNull();
		expect(got.coauthorLoreProviderId).toBeNull();
		expect(got.coauthorLoreModelName).toBeNull();
	});

	test("round-trips the coauthor binding independently from the lore pair", async () => {
		const { settings, providers } = await mkSettingsStore();
		const coauthorProfile = await providers.create(baseProfile);
		const loreProfile = await providers.create({ ...baseProfile, name: "Lore" });
		const updated = await settings.update({
			coauthorProviderId: coauthorProfile.id,
			coauthorLoreProviderId: loreProfile.id,
			coauthorLoreModelName: "gpt-4o-mini",
		});
		expect(updated.coauthorProviderId).toBe(coauthorProfile.id);
		expect(updated.coauthorLoreProviderId).toBe(loreProfile.id);
		expect(updated.coauthorLoreModelName).toBe("gpt-4o-mini");

		const reread = await settings.get();
		expect(reread.coauthorProviderId).toBe(coauthorProfile.id);
		expect(reread.coauthorLoreProviderId).toBe(loreProfile.id);
		expect(reread.coauthorLoreModelName).toBe("gpt-4o-mini");
	});

	test("partial update preserves the coauthor binding and all legacy fields", async () => {
		const { settings, providers } = await mkSettingsStore();
		const profile = await providers.create(baseProfile);
		await settings.update({
			coauthorProviderId: profile.id,
			theme: "light",
			language: "ru",
		});

		// Only swap the theme, leave the binding.
		const after = await settings.update({ theme: "dark" });
		expect(after.coauthorProviderId).toBe(profile.id);
		// Legacy fields untouched by the partial.
		expect(after.theme).toBe("dark");
		expect(after.language).toBe("ru");
	});

	test("explicit null clears a lore pair without disturbing the coauthor binding", async () => {
		const { settings, providers } = await mkSettingsStore();
		const coauthorProfile = await providers.create(baseProfile);
		const loreProfile = await providers.create({ ...baseProfile, name: "Lore" });
		await settings.update({
			coauthorProviderId: coauthorProfile.id,
			coauthorLoreProviderId: loreProfile.id,
			coauthorLoreModelName: "lore-model",
		});

		const cleared = await settings.update({ coauthorLoreProviderId: null, coauthorLoreModelName: null });
		expect(cleared.coauthorLoreProviderId).toBeNull();
		expect(cleared.coauthorLoreModelName).toBeNull();
		expect(cleared.coauthorProviderId).toBe(coauthorProfile.id);
	});

	test("deleting the bound provider leaves a dangling id (resolved by adapter, not DB FK)", async () => {
		// Unlike activePromptPresetId (CREATE TABLE FK with ON DELETE SET NULL),
		// coauthorProviderId has no DB-level FK — matching aiAssistantProviderId.
		// A deleted provider leaves a dangling id that the ChatAdapter resolves
		// by failing closed (`coauthor_model_required`, CG-2) — never the RP
		// active profile. The store simply retains the stale id.
		const { settings, providers } = await mkSettingsStore();
		const profile = await providers.create(baseProfile);
		await settings.update({ coauthorProviderId: profile.id });

		await providers.delete(profile.id);

		const after = await settings.get();
		// No FK null-out; the stale id persists and is resolved at the adapter boundary.
		expect(after.coauthorProviderId).toBe(profile.id);
	});

	test("ensureDefaults seeds the coauthor binding and lore pair as null", async () => {
		const { settings } = await mkSettingsStore();
		const seeded = await settings.ensureDefaults();
		expect(seeded.coauthorProviderId).toBeNull();
		expect(seeded.coauthorLoreProviderId).toBeNull();
		expect(seeded.coauthorLoreModelName).toBeNull();
	});
});

describe("UiSettingsStore — STT scenario pointers (ST-1)", () => {
	test("defaults are null for both activeDictationProfileId and activeVoiceMessageProfileId", async () => {
		const { settings } = await mkSettingsStore();
		const got = await settings.get();
		expect(got.activeDictationProfileId).toBeNull();
		expect(got.activeVoiceMessageProfileId).toBeNull();
	});

	test("persists both pointers independently and round-trips a fresh read", async () => {
		const { settings } = await mkSettingsStore();
		const updated = await settings.update({
			activeDictationProfileId: "stt_profile_fast",
			activeVoiceMessageProfileId: "stt_profile_emotive",
		});
		expect(updated.activeDictationProfileId).toBe("stt_profile_fast");
		expect(updated.activeVoiceMessageProfileId).toBe("stt_profile_emotive");

		const reread = await settings.get();
		expect(reread.activeDictationProfileId).toBe("stt_profile_fast");
		expect(reread.activeVoiceMessageProfileId).toBe("stt_profile_emotive");

		// Same profile may back both scenarios.
		const same = await settings.update({
			activeDictationProfileId: "stt_profile_shared",
			activeVoiceMessageProfileId: "stt_profile_shared",
		});
		expect(same.activeDictationProfileId).toBe(same.activeVoiceMessageProfileId);
	});

	test("partial pointer update preserves the other pointer and legacy fields", async () => {
		const { settings } = await mkSettingsStore();
		await settings.update({ activeDictationProfileId: "stt_profile_a" });
		const updated = await settings.update({ activeVoiceMessageProfileId: "stt_profile_b" });
		expect(updated.activeDictationProfileId).toBe("stt_profile_a");
		expect(updated.activeVoiceMessageProfileId).toBe("stt_profile_b");
		expect(updated.theme).toBe("dark"); // untouched legacy field survived
	});

	test("clearing a pointer back to null round-trips", async () => {
		const { settings } = await mkSettingsStore();
		await settings.update({ activeDictationProfileId: "stt_profile_a" });
		const cleared = await settings.update({ activeDictationProfileId: null });
		expect(cleared.activeDictationProfileId).toBeNull();
		expect(await settings.get()).toMatchObject({ activeDictationProfileId: null });
	});

	test("ensureDefaults seeds both STT pointers as null", async () => {
		const { settings } = await mkSettingsStore();
		const seeded = await settings.ensureDefaults();
		expect(seeded.activeDictationProfileId).toBeNull();
		expect(seeded.activeVoiceMessageProfileId).toBeNull();
	});
});
