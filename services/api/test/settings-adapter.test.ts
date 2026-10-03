import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { SettingsAdapter } from "../src/api/adapters/settings-adapter.js";

async function setup(): Promise<{ adapter: SettingsAdapter; stores: StoreContainer }> {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-settings-adapter-"));
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const adapter = new SettingsAdapter(stores);
	return { adapter, stores };
}

describe("SettingsAdapter — chat impersonation draft enhancement", () => {
	test("persists a boolean enhancement toggle and ignores non-boolean input", async () => {
		const { adapter } = await setup();
		expect((await adapter.updateUiSettings({ chatImpersonateEnhanceDraft: true })).chatImpersonateEnhanceDraft).toBe(true);
		expect((await adapter.updateUiSettings({ chatImpersonateEnhanceDraft: "true" as never })).chatImpersonateEnhanceDraft).toBe(true);
	});
});

describe("SettingsAdapter — per-context secondary-model pairs (SUM-5)", () => {
	test("persists the summary and message-editor pairs, gated string|null", async () => {
		const { adapter } = await setup();
		const result = await adapter.updateUiSettings({
			summaryProviderId: "prov_s",
			summaryModelName: "glm-5.2",
			messageEditorProviderId: "prov_e",
			messageEditorModelName: "gpt-x",
		});
		expect(result.summaryProviderId).toBe("prov_s");
		expect(result.summaryModelName).toBe("glm-5.2");
		expect(result.messageEditorProviderId).toBe("prov_e");
		expect(result.messageEditorModelName).toBe("gpt-x");
	});

	test("explicit null clears the pair; garbage types are filtered, not crash", async () => {
		const { adapter } = await setup();
		await adapter.updateUiSettings({ summaryProviderId: "prov_s", summaryModelName: "m" });
		const cleared = await adapter.updateUiSettings({ summaryProviderId: null, summaryModelName: null });
		expect(cleared.summaryProviderId).toBeNull();
		expect(cleared.summaryModelName).toBeNull();

		const filtered = await adapter.updateUiSettings({
			messageEditorProviderId: 42 as never,
			messageEditorModelName: [] as never,
		});
		expect(filtered.messageEditorProviderId).toBeNull();
		expect(filtered.messageEditorModelName).toBeNull();
	});
});

describe("SettingsAdapter — coauthor binding whitelist", () => {
	test("persists the coauthor binding and the lore model pair", async () => {
		const { adapter } = await setup();
		const result = await adapter.updateUiSettings({
			coauthorProviderId: "prov_1",
			coauthorLoreProviderId: "prov_lore",
			coauthorLoreModelName: "gpt-4o-mini",
		});
		expect(result.coauthorProviderId).toBe("prov_1");
		expect(result.coauthorLoreProviderId).toBe("prov_lore");
		expect(result.coauthorLoreModelName).toBe("gpt-4o-mini");
	});

	test("explicit null clears the lore pair without clearing the coauthor binding", async () => {
		const { adapter } = await setup();
		await adapter.updateUiSettings({
			coauthorProviderId: "prov_1",
			coauthorLoreProviderId: "prov_lore",
			coauthorLoreModelName: "lore-model",
		});
		const cleared = await adapter.updateUiSettings({ coauthorLoreProviderId: null, coauthorLoreModelName: null });
		expect(cleared.coauthorLoreProviderId).toBeNull();
		expect(cleared.coauthorLoreModelName).toBeNull();
		expect(cleared.coauthorProviderId).toBe("prov_1");
	});

	test("ignores non-string, non-null values (type filtering)", async () => {
		const { adapter } = await setup();
		// Garbage types should be filtered out, not crash.
		const result = await adapter.updateUiSettings({
			coauthorProviderId: 123 as never,
			coauthorLoreProviderId: [] as never,
			coauthorLoreModelName: {} as never,
		});
		// Nothing was written for coauthor fields.
		expect(result.coauthorProviderId).toBeNull();
		expect(result.coauthorLoreProviderId).toBeNull();
		expect(result.coauthorLoreModelName).toBeNull();
	});

	test("coauthor patch does not disturb existing legacy fields", async () => {
		const { adapter } = await setup();
		await adapter.updateUiSettings({ theme: "dark", language: "ru" });
		const after = await adapter.updateUiSettings({ coauthorProviderId: "prov_2" });
		expect(after.theme).toBe("dark");
		expect(after.language).toBe("ru");
		expect(after.coauthorProviderId).toBe("prov_2");
	});

	test("get returns the coauthor fields", async () => {
		const { adapter } = await setup();
		await adapter.updateUiSettings({ coauthorProviderId: "prov_3" });
		const got = await adapter.getUiSettings();
		expect(got.coauthorProviderId).toBe("prov_3");
	});
});
