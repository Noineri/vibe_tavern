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

describe("UiSettingsStore — coauthor binding fields", () => {
	test("defaults are null for both coauthorProviderId and coauthorModelName", async () => {
		const { settings } = await mkSettingsStore();
		const got = await settings.get();
		expect(got.coauthorProviderId).toBeNull();
		expect(got.coauthorModelName).toBeNull();
	});

	test("persists a coauthor provider+model pair", async () => {
		const { settings, providers } = await mkSettingsStore();
		const profile = await providers.create(baseProfile);
		const updated = await settings.update({
			coauthorProviderId: profile.id,
			coauthorModelName: "claude-sonnet-4",
		});
		expect(updated.coauthorProviderId).toBe(profile.id);
		expect(updated.coauthorModelName).toBe("claude-sonnet-4");

		// Survives a fresh read.
		const reread = await settings.get();
		expect(reread.coauthorProviderId).toBe(profile.id);
		expect(reread.coauthorModelName).toBe("claude-sonnet-4");
	});

	test("partial update preserves the other coauthor field and all legacy fields", async () => {
		const { settings, providers } = await mkSettingsStore();
		const profile = await providers.create(baseProfile);
		await settings.update({
			coauthorProviderId: profile.id,
			coauthorModelName: "model-a",
			theme: "light",
			language: "ru",
		});

		// Only swap the model, leave the provider.
		const after = await settings.update({ coauthorModelName: "model-b" });
		expect(after.coauthorProviderId).toBe(profile.id);
		expect(after.coauthorModelName).toBe("model-b");
		// Legacy fields untouched by the partial.
		expect(after.theme).toBe("light");
		expect(after.language).toBe("ru");
	});

	test("explicit null clears a previously saved coauthor binding", async () => {
		const { settings, providers } = await mkSettingsStore();
		const profile = await providers.create(baseProfile);
		await settings.update({ coauthorProviderId: profile.id, coauthorModelName: "x" });

		const cleared = await settings.update({ coauthorProviderId: null, coauthorModelName: null });
		expect(cleared.coauthorProviderId).toBeNull();
		expect(cleared.coauthorModelName).toBeNull();
	});

	test("deleting the bound provider leaves a dangling id (resolved by adapter, not DB FK)", async () => {
		// Unlike activePromptPresetId (CREATE TABLE FK with ON DELETE SET NULL),
		// coauthorProviderId has no DB-level FK — matching aiAssistantProviderId.
		// A deleted provider leaves a dangling id that the ChatAdapter resolves
		// to the RP fallback (Wave 2). The store simply retains the stale id.
		const { settings, providers } = await mkSettingsStore();
		const profile = await providers.create(baseProfile);
		await settings.update({ coauthorProviderId: profile.id, coauthorModelName: "x" });

		await providers.delete(profile.id);

		const after = await settings.get();
		// No FK null-out; the stale id persists and is resolved at the adapter boundary.
		expect(after.coauthorProviderId).toBe(profile.id);
		expect(after.coauthorModelName).toBe("x");
	});

	test("ensureDefaults seeds both coauthor fields as null", async () => {
		const { settings } = await mkSettingsStore();
		const seeded = await settings.ensureDefaults();
		expect(seeded.coauthorProviderId).toBeNull();
		expect(seeded.coauthorModelName).toBeNull();
	});
});
