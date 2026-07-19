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

describe("SettingsAdapter — coauthor binding whitelist", () => {
	test("persists coauthor provider + model pair", async () => {
		const { adapter } = await setup();
		const result = await adapter.updateUiSettings({
			coauthorProviderId: "prov_1",
			coauthorModelName: "claude-sonnet-4",
		});
		expect(result.coauthorProviderId).toBe("prov_1");
		expect(result.coauthorModelName).toBe("claude-sonnet-4");
	});

	test("explicit null clears a coauthor field", async () => {
		const { adapter } = await setup();
		await adapter.updateUiSettings({ coauthorProviderId: "prov_1", coauthorModelName: "x" });
		const cleared = await adapter.updateUiSettings({ coauthorProviderId: null, coauthorModelName: null });
		expect(cleared.coauthorProviderId).toBeNull();
		expect(cleared.coauthorModelName).toBeNull();
	});

	test("ignores non-string, non-null values (type filtering)", async () => {
		const { adapter } = await setup();
		// Garbage types should be filtered out, not crash.
		const result = await adapter.updateUiSettings({
			coauthorProviderId: 123 as never,
			coauthorModelName: undefined as never,
		});
		// Nothing was written for coauthor fields.
		expect(result.coauthorProviderId).toBeNull();
		expect(result.coauthorModelName).toBeNull();
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
		await adapter.updateUiSettings({ coauthorProviderId: "prov_3", coauthorModelName: "m" });
		const got = await adapter.getUiSettings();
		expect(got.coauthorProviderId).toBe("prov_3");
		expect(got.coauthorModelName).toBe("m");
	});
});
