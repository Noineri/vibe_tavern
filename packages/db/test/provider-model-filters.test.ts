import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { makeCreateProviderData } from "./provider-test-builders.js";

// Round-trip pin for the model-list display prefs (MODEL_LIST_FILTERS step 3).
// These are pure-UI booleans with no backend logic, but they MUST survive the
// create/update/read cycle like every other profile field — a field the form
// saves but the store silently drops is the avatarFullExt disease elsewhere.

const FIXED_NOW = "2025-05-04T12:00:00.000Z";

let clockTick = 0;
const testClock: StoreClock = {
	now() {
		clockTick++;
		return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString();
	},
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
	next(prefix: string): string {
		const n = (idCounters.get(prefix) ?? 0) + 1;
		idCounters.set(prefix, n);
		return `${prefix}_test_${String(n).padStart(4, "0")}`;
	},
};

async function createTestDb() {
	return await createDb(":memory:");
}

function bootstrap(db: Awaited<ReturnType<typeof createTestDb>>) {
	db.insert(schema.providerProfiles).values({
		id: "prov_1", name: "TestProvider", providerPreset: "openai",
		endpoint: "http://localhost", maxTokens: 2000,
		temperature: 1.0, topP: 1.0, topK: 0, minP: 0,
		frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1.0,
		reasoningEffort: "auto", streamResponse: 1, customSamplers: 0,
		isActive: 1,
		createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
	}).run();
}

describe("ProviderStore model-list filter prefs persistence (MODEL_LIST_FILTERS)", () => {
	let db: Awaited<ReturnType<typeof createTestDb>>;
	let store: ProviderStore;

	beforeEach(async () => {
		clockTick = 0;
		idCounters = new Map();
		db = await createTestDb();
		bootstrap(db);
		store = new ProviderStore(db, { idGenerator: testIdGen, clock: testClock });
	});

	test("defaults to false when omitted on create", async () => {
		const created = await store.create(makeCreateProviderData({ name: "Test" }));
		expect(created.modelFreeOnly).toBe(false);
		expect(created.modelGroupByOwner).toBe(false);
	});

	test("create with both on → read back", async () => {
		const created = await store.create(
			makeCreateProviderData({
				name: "Test",
				modelFreeOnly: true,
				modelGroupByOwner: true,
			}),
		);
		expect(created.modelFreeOnly).toBe(true);
		expect(created.modelGroupByOwner).toBe(true);

		const reloaded = await store.getById(created.id);
		expect(reloaded!.modelFreeOnly).toBe(true);
		expect(reloaded!.modelGroupByOwner).toBe(true);
	});

	test("update toggles persist", async () => {
		const created = await store.create(makeCreateProviderData({ name: "Test" }));

		await store.update(created.id, { modelFreeOnly: true, modelGroupByOwner: true });

		const on = await store.getById(created.id);
		expect(on!.modelFreeOnly).toBe(true);
		expect(on!.modelGroupByOwner).toBe(true);

		await store.update(created.id, { modelFreeOnly: false });

		const off = await store.getById(created.id);
		expect(off!.modelFreeOnly).toBe(false);
		// modelGroupByOwner untouched by the partial update.
		expect(off!.modelGroupByOwner).toBe(true);
	});

	test("partial update (unrelated field) preserves both prefs", async () => {
		const created = await store.create(
			makeCreateProviderData({
				name: "Test",
				modelFreeOnly: true,
				modelGroupByOwner: true,
			}),
		);

		await store.update(created.id, { temperature: 0.7 });

		const reloaded = await store.getById(created.id);
		expect(reloaded!.modelFreeOnly).toBe(true);
		expect(reloaded!.modelGroupByOwner).toBe(true);
		expect(reloaded!.temperature).toBe(0.7);
	});
});
