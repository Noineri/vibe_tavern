import { describe, test, expect } from "bun:test";
import { createDb, PresetStore, UiSettingsStore, ServicePromptProfileStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { migratePresetServicePrompts } from "../src/domain/service-prompts/preset-to-profile-migration.js";

const fixedClock: StoreClock = { now: () => "2026-08-26T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	counter = 0;
	const db = await createDb(":memory:");
	const presets = new PresetStore(db, { clock: fixedClock, idGenerator: idGen });
	const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
	const profileStore = new ServicePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
	await uiSettings.ensureDefaults();
	return { db, presets, uiSettings, profileStore, stores: { db, presets, uiSettings } };
}

describe("SP-7 preset → service-prompt profile migration", () => {
	test("preset with JSON + summary overrides → profile named after the preset; preset row untouched", async () => {
		const { presets, uiSettings, profileStore, stores } = await setup();
		await presets.create({
			name: "My tuned preset",
			aiAssistantPrompts: JSON.stringify({ script: "SCRIPT-OVR", lore_entry: "LORE-OVR", bogus_key: "IGNORED" }),
			summaryPrompt: "SUMMARY-OVR",
		});
		await presets.create({ name: "Clean preset" });

		const result = await migratePresetServicePrompts(stores);
		expect(result.ran).toBe(true);
		expect(result.created).toHaveLength(1);

		const profiles = await profileStore.listServicePromptProfiles();
		const migrated = profiles.find((p) => p.name === "My tuned preset");
		expect(migrated).toBeDefined();
		expect(migrated!.isDefault).toBe(false);
		expect(migrated!.overrides.script).toBe("SCRIPT-OVR");
		expect(migrated!.overrides.lore_entry).toBe("LORE-OVR");
		expect(migrated!.overrides.summary).toBe("SUMMARY-OVR");
		expect(Object.keys(migrated!.overrides).sort()).toEqual(["lore_entry", "script", "summary"]);

		// Non-destructive: preset rows stay byte-identical.
		const after = await presets.listAll();
		const tuned = after.find((p) => p.name === "My tuned preset")!;
		expect(tuned.aiAssistantPrompts).toBe(JSON.stringify({ script: "SCRIPT-OVR", lore_entry: "LORE-OVR", bogus_key: "IGNORED" }));
		expect(tuned.summaryPrompt).toBe("SUMMARY-OVR");
	});

	test("legacy scriptAiSystemPrompt backs script when the JSON slot is empty; JSON wins when both set", async () => {
		const { presets, profileStore, stores } = await setup();
		await presets.create({
			name: "LegacyOnly",
			aiAssistantPrompts: "{}",
			scriptAiSystemPrompt: "LEGACY-SCRIPT",
		});
		await presets.create({
			name: "BothSet",
			aiAssistantPrompts: JSON.stringify({ script: "JSON-SCRIPT" }),
			scriptAiSystemPrompt: "LEGACY-IGNORED",
		});

		await migratePresetServicePrompts(stores);
		const profiles = await profileStore.listServicePromptProfiles();
		expect(profiles.find((p) => p.name === "LegacyOnly")!.overrides.script).toBe("LEGACY-SCRIPT");
		expect(profiles.find((p) => p.name === "BothSet")!.overrides.script).toBe("JSON-SCRIPT");
	});

	test("whitespace-only values create no override", async () => {
		const { presets, profileStore, stores } = await setup();
		await presets.create({
			name: "Whitespace",
			aiAssistantPrompts: JSON.stringify({ script: "   " }),
			scriptAiSystemPrompt: "\t\n",
			summaryPrompt: "  ",
		});

		await migratePresetServicePrompts(stores);
		const profiles = await profileStore.listServicePromptProfiles();
		expect(profiles.find((p) => p.name === "Whitespace")).toBeUndefined();
	});

	test("invalid aiAssistantPrompts JSON → preset skipped, others still migrate, flag still set", async () => {
		const { presets, profileStore, uiSettings, stores } = await setup();
		await presets.create({ name: "Broken", aiAssistantPrompts: "{not json" });
		await presets.create({ name: "Fine", aiAssistantPrompts: JSON.stringify({ dice_script: "DICE-OVR" }) });

		const result = await migratePresetServicePrompts(stores);
		expect(result.skippedInvalidJson).toEqual(["Broken"]);
		expect(result.created).toHaveLength(1);
		const profiles = await profileStore.listServicePromptProfiles();
		expect(profiles.find((p) => p.name === "Broken")).toBeUndefined();
		expect(profiles.find((p) => p.name === "Fine")!.overrides.dice_script).toBe("DICE-OVR");
		expect((await uiSettings.get()).servicePromptPresetMigrated).toBe(true);
	});

	test("re-run → marker short-circuits, no duplicates", async () => {
		const { presets, profileStore, uiSettings, stores } = await setup();
		await presets.create({ name: "Once", aiAssistantPrompts: JSON.stringify({ script: "S" }) });

		const first = await migratePresetServicePrompts(stores);
		expect(first.ran).toBe(true);
		// A NEW preset with overrides appears after the first pass.
		await presets.create({ name: "Late", aiAssistantPrompts: JSON.stringify({ script: "LATE" }) });

		const second = await migratePresetServicePrompts(stores);
		expect(second.ran).toBe(false);
		expect(second.created).toHaveLength(0);
		const profiles = await profileStore.listServicePromptProfiles();
		expect(profiles.filter((p) => p.name === "Once")).toHaveLength(1);
		expect(profiles.find((p) => p.name === "Late")).toBeUndefined();
		expect((await uiSettings.get()).servicePromptPresetMigrated).toBe(true);
	});

	test("active pointer follows the active preset when it produced a profile", async () => {
		const { presets, uiSettings, profileStore, stores } = await setup();
		const tuned = await presets.create({ name: "Active tuned", aiAssistantPrompts: JSON.stringify({ script: "S" }) });
		await presets.create({ name: "Other tuned", aiAssistantPrompts: JSON.stringify({ lore_keys: "K" }) });
		await uiSettings.update({ activePromptPresetId: tuned.id });

		const result = await migratePresetServicePrompts(stores);
		const profiles = await profileStore.listServicePromptProfiles();
		const expected = profiles.find((p) => p.name === "Active tuned")!.id;
		expect(result.activeProfileId).toBe(expected);
		expect((await uiSettings.get()).activeServicePromptProfileId).toBe(expected);
	});

	test("active preset without overrides → active pointer resolves to null (Default)", async () => {
		const { presets, uiSettings, stores } = await setup();
		const clean = await presets.create({ name: "Active clean" });
		await presets.create({ name: "Tuned", aiAssistantPrompts: JSON.stringify({ script: "S" }) });
		await uiSettings.update({ activePromptPresetId: clean.id });

		const result = await migratePresetServicePrompts(stores);
		expect(result.activeProfileId).toBe(null);
		expect((await uiSettings.get()).activeServicePromptProfileId).toBe(null);
	});

	test("name collision with the built-in Default → profile named \"Default (копия)\"", async () => {
		const { presets, profileStore, stores } = await setup();
		// The real-world case from the owner's DB: a user preset literally named
		// "Default" with overrides, plus the builtin profile of the same name.
		await presets.create({ name: "Default", summaryPrompt: "SUMMARY-OVR" });

		const result = await migratePresetServicePrompts(stores);
		expect(result.created).toHaveLength(1);
		expect(result.created[0].presetName).toBe("Default");
		expect(result.created[0].profileName).toBe("Default (копия)");

		const profiles = await profileStore.listServicePromptProfiles();
		const names = profiles.map((p) => p.name).sort();
		expect(names).toEqual(["Default", "Default (копия)"]);
		// The builtin keeps its identity; the copy carries the overrides.
		const builtin = profiles.find((p) => p.name === "Default")!;
		const copy = profiles.find((p) => p.name === "Default (копия)")!;
		expect(builtin.isDefault).toBe(true);
		expect(copy.isDefault).toBe(false);
		expect(copy.overrides.summary).toBe("SUMMARY-OVR");
	});

	test("two presets sharing a name → second gets \"(копия)\", third gets \"(копия) 2\"", async () => {
		const { presets, profileStore, stores } = await setup();
		await presets.create({ name: "Twin", summaryPrompt: "FIRST" });
		await presets.create({ name: "Twin", summaryPrompt: "SECOND" });
		await presets.create({ name: "Twin", summaryPrompt: "THIRD" });

		const result = await migratePresetServicePrompts(stores);
		expect(result.created.map((e) => e.profileName)).toEqual(["Twin", "Twin (копия)", "Twin (копия) 2"]);
		const profiles = await profileStore.listServicePromptProfiles();
		expect(profiles.find((p) => p.name === "Twin")!.overrides.summary).toBe("FIRST");
		expect(profiles.find((p) => p.name === "Twin (копия)")!.overrides.summary).toBe("SECOND");
		expect(profiles.find((p) => p.name === "Twin (копия) 2")!.overrides.summary).toBe("THIRD");
	});

	test("empty database → flag flips, nothing created", async () => {
		const { profileStore, uiSettings, stores } = await setup();
		const result = await migratePresetServicePrompts(stores);
		expect(result.ran).toBe(true);
		expect(result.created).toHaveLength(0);
		const profiles = await profileStore.listServicePromptProfiles();
		expect(profiles.filter((p) => !p.isDefault)).toHaveLength(0);
		expect((await uiSettings.get()).servicePromptPresetMigrated).toBe(true);
	});
});
