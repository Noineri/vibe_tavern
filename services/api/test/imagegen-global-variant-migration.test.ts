import { describe, test, expect } from "bun:test";
import { createDb, ImagePromptVariantStore, ImagePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { migrateGlobalImagePromptVariants } from "../src/domain/imagegen/global-variant-to-profile-migration.js";

const fixedClock: StoreClock = { now: () => "2026-09-22T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	counter = 0;
	const db = await createDb(":memory:");
	const imagePromptVariants = new ImagePromptVariantStore(db, { clock: fixedClock, idGenerator: idGen });
	const imagePromptProfiles = new ImagePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
	const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
	await uiSettings.ensureDefaults();
	return { db, imagePromptVariants, imagePromptProfiles, uiSettings, stores: { db, imagePromptVariants, imagePromptProfiles, uiSettings } };
}

describe("IF-1a global variant → image prompt profile migration", () => {
	test("existing global rows → one \"Imported\" profile, made active; old table untouched", async () => {
		const { imagePromptVariants, imagePromptProfiles, uiSettings, stores } = await setup();
		await imagePromptVariants.upsert({ rowKey: "portrait", family: "prose", body: "P-BODY", qualityText: "P-QUAL" });
		await imagePromptVariants.upsert({ rowKey: "negative", family: "qwen", body: "N-BODY" });
		await imagePromptVariants.upsert({ rowKey: "scene-illustration", family: "pony", body: "S-BODY", qualityText: null });

		const result = await migrateGlobalImagePromptVariants(stores);
		expect(result.ran).toBe(true);
		expect(result.cellCount).toBe(3);

		const profiles = await imagePromptProfiles.listImagePromptProfiles();
		const imported = profiles.find((p) => p.name === "Imported");
		expect(imported).toBeDefined();
		expect(imported!.isDefault).toBe(false);
		expect(imported!.overrides["portrait|prose"]).toEqual({ body: "P-BODY", qualityText: "P-QUAL" });
		expect(imported!.overrides["negative|qwen"]).toEqual({ body: "N-BODY", qualityText: null });
		expect(imported!.overrides["scene-illustration|pony"]).toEqual({ body: "S-BODY", qualityText: null });
		expect(Object.keys(imported!.overrides).sort()).toEqual(["negative|qwen", "portrait|prose", "scene-illustration|pony"]);

		// Active pointer lands on the imported profile (behavior-preserving).
		const settings = await uiSettings.get();
		expect(settings.activeImagePromptProfileId).toBe(imported!.id);
		expect(settings.imagePromptVariantsMigrated).toBe(true);

		// Non-destructive: the global table still holds its rows.
		expect(await imagePromptVariants.listAll()).toHaveLength(3);
	});

	test("fresh install (no rows) → no profile created, marker still set, pointer stays null", async () => {
		const { imagePromptProfiles, uiSettings, stores } = await setup();
		const result = await migrateGlobalImagePromptVariants(stores);
		expect(result.ran).toBe(true);
		expect(result.createdProfileId).toBeNull();
		expect(result.cellCount).toBe(0);

		const profiles = await imagePromptProfiles.listImagePromptProfiles();
		expect(profiles.map((p) => p.name)).toEqual(["Default"]);
		const settings = await uiSettings.get();
		expect(settings.activeImagePromptProfileId).toBeNull();
		expect(settings.imagePromptVariantsMigrated).toBe(true);
	});

	test("marker short-circuits a second run (idempotent on every startup)", async () => {
		const { imagePromptVariants, imagePromptProfiles, stores } = await setup();
		await imagePromptVariants.upsert({ rowKey: "portrait", family: "prose", body: "P-BODY" });
		const first = await migrateGlobalImagePromptVariants(stores);
		expect(first.ran).toBe(true);

		// A row added AFTER the first pass is not carried (marker wins).
		await imagePromptVariants.upsert({ rowKey: "selfie", family: "pony", body: "LATE" });
		const second = await migrateGlobalImagePromptVariants(stores);
		expect(second.ran).toBe(false);

		const profiles = await imagePromptProfiles.listImagePromptProfiles();
		expect(profiles.filter((p) => p.name.startsWith("Imported"))).toHaveLength(1);
		const imported = profiles.find((p) => p.name === "Imported")!;
		expect(Object.keys(imported.overrides)).toEqual(["portrait|prose"]);
	});

	test("name collision with a user profile resolves with a (copy) suffix", async () => {
		const { imagePromptVariants, imagePromptProfiles, uiSettings, stores } = await setup();
		await imagePromptProfiles.createImagePromptProfile({ name: "Imported" });
		await imagePromptVariants.upsert({ rowKey: "portrait", family: "prose", body: "P-BODY" });

		const result = await migrateGlobalImagePromptVariants(stores);
		expect(result.ran).toBe(true);

		const profiles = await imagePromptProfiles.listImagePromptProfiles();
		expect(profiles.map((p) => p.name)).toEqual(["Default", "Imported", "Imported (copy)"]);
		// The snapshot (active) is the (copy), not the pre-existing user profile.
		const settingsAfter = await uiSettings.get();
		const active = profiles.find((p) => p.id === settingsAfter.activeImagePromptProfileId);
		expect(active!.name).toBe("Imported (copy)");
	});
});
