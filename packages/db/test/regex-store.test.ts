import { describe, expect, test } from "bun:test";

import { REGEX_PLACEMENT, REGEX_SUBSTITUTE } from "@vibe-tavern/domain";

import { createDb } from "../src/db-connection.js";
import { regexPresets } from "../src/db-schema.js";
import { RegexStore } from "../src/stores/regex-store.js";
import type { CreateRegexPresetData } from "../src/stores/regex-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-08-25T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const db = await createDb(":memory:");
	const store = new RegexStore(db, { clock: fixedClock, idGenerator: idGen });
	return { store, db };
}

let inputCounter = 0;
function baseInput(overrides: Partial<CreateRegexPresetData> = {}): CreateRegexPresetData {
	inputCounter += 1;
	return {
		name: `preset_${inputCounter}`,
		findRegex: "/foo/g",
		replaceString: "bar",
		trimStrings: [],
		substituteRegex: REGEX_SUBSTITUTE.None,
		disabled: false,
		markdownOnly: false,
		promptOnly: false,
		runOnEdit: true,
		minDepth: null,
		maxDepth: null,
		placement: [REGEX_PLACEMENT.AiOutput],
		isGlobal: false,
		sortOrder: 0,
		...overrides,
	};
}

describe("RegexStore CRUD", () => {
	test("create → getById round-trips JSON array fields and booleans", async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({
				name: "think-strip",
				findRegex: "/<think>[\\s\\S]*?<\\/think>/g",
				replaceString: "",
				trimStrings: ["\n", "  "],
				substituteRegex: REGEX_SUBSTITUTE.Escaped,
				disabled: true,
				markdownOnly: true,
				promptOnly: false,
				runOnEdit: false,
				minDepth: 0,
				maxDepth: 2,
				placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.WorldInfo],
				isGlobal: true,
				sortOrder: 7,
			}),
		);

		expect(created.id).toStartWith("regex_preset_");
		expect(created.createdAt).toBe(fixedClock.now());
		expect(created.updatedAt).toBe(fixedClock.now());

		const loaded = await store.getById(created.id);
		expect(loaded).toEqual(created);
	});

	test("update patches fields, serializes arrays, bumps updatedAt; unknown id → null", async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ sortOrder: 1 }));

		const updated = await store.update(created.id, {
			name: "renamed",
			trimStrings: ["«", "»"],
			placement: [REGEX_PLACEMENT.Reasoning],
			disabled: true,
			minDepth: 1,
		});
		expect(updated).not.toBeNull();
		expect(updated!.name).toBe("renamed");
		expect(updated!.trimStrings).toEqual(["«", "»"]);
		expect(updated!.placement).toEqual([REGEX_PLACEMENT.Reasoning]);
		expect(updated!.disabled).toBe(true);
		expect(updated!.minDepth).toBe(1);
		expect(updated!.updatedAt).toBe(fixedClock.now()); // fixed clock — bump is a no-op but the write happened

		// Untouched fields survive the patch.
		expect(updated!.findRegex).toBe(created.findRegex);
		expect(updated!.substituteRegex).toBe(REGEX_SUBSTITUTE.None);

		expect(await store.update("regex_preset_missing", { name: "x" })).toBeNull();
	});

	test("listAll sorts by sortOrder then name; delete removes the row", async () => {
		const { store } = await setup();
		await store.create(baseInput({ name: "b", sortOrder: 2 }));
		await store.create(baseInput({ name: "a2", sortOrder: 1 }));
		await store.create(baseInput({ name: "a1", sortOrder: 1 }));

		const all = await store.listAll();
		expect(all.map((p) => p.name)).toEqual(["a1", "a2", "b"]);

		const first = all[0]!;
		await store.delete(first.id);
		expect(await store.getById(first.id)).toBeNull();
		expect((await store.listAll()).map((p) => p.name)).toEqual(["a2", "b"]);
	});
});

describe("RegexStore malformed-JSON hygiene", () => {
	test("malformed trimStringsJson / placementJson degrade to defaults without throwing", async () => {
		const { store, db } = await setup();
		await db.insert(regexPresets).values({
			id: "regex_preset_broken",
			name: "broken",
			findRegex: "/x/g",
			replaceString: "y",
			trimStringsJson: "{{{not json",
			placementJson: "nope",
			substituteRegex: 0,
			disabled: 0,
			markdownOnly: 0,
			promptOnly: 0,
			runOnEdit: 1,
			isGlobal: 0,
			sortOrder: 0,
			createdAt: fixedClock.now(),
			updatedAt: fixedClock.now(),
		});

		const loaded = await store.getById("regex_preset_broken");
		expect(loaded).not.toBeNull();
		expect(loaded!.trimStrings).toEqual([]);
		expect(loaded!.placement).toEqual([REGEX_PLACEMENT.AiOutput]);

		const listed = await store.listAll();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.trimStrings).toEqual([]);
	});
});

describe("RegexStore link API", () => {
	test("setLinks replaces atomically; addLink/removeLink/getLinks behave", async () => {
		const { store } = await setup();
		const preset = await store.create(baseInput());

		await store.addLink(preset.id, "character", "char_1");
		expect((await store.getLinks(preset.id)).map((l) => l.targetId)).toEqual(["char_1"]);

		// Atomic replace: old binding gone, only the new set remains.
		const replaced = await store.setLinks(preset.id, [{ targetType: "preset", targetId: "preset_9" }]);
		expect(replaced).toHaveLength(1);
		expect(replaced[0]).toMatchObject({ regexPresetId: preset.id, targetType: "preset", targetId: "preset_9" });
		expect(await store.getLinks(preset.id)).toEqual(replaced);

		// Duplicate tuples in one replace are normalized (composite PK safety).
		const deduped = await store.setLinks(preset.id, [
			{ targetType: "character", targetId: "char_1" },
			{ targetType: "character", targetId: "char_1" },
		]);
		expect(deduped).toHaveLength(1);

		// addLink is idempotent via onConflictDoNothing.
		await store.addLink(preset.id, "character", "char_1");
		expect(await store.getLinks(preset.id)).toHaveLength(1);

		await store.addLink(preset.id, "preset", "preset_9");
		await store.removeLink(preset.id, "preset", "preset_9");
		const remaining = await store.getLinks(preset.id);
		expect(remaining.map((l) => [l.targetType, l.targetId])).toEqual([["character", "char_1"]]);
	});
});

describe("resolveActiveRegexPresets", () => {
	test("each source is visible alone (global / character-bound / preset-bound)", async () => {
		const { store } = await setup();
		const globalP = await store.create(baseInput({ name: "g", isGlobal: true, sortOrder: 0 }));
		const charP = await store.create(baseInput({ name: "c", sortOrder: 1 }));
		const presetP = await store.create(baseInput({ name: "p", sortOrder: 2 }));
		await store.addLink(charP.id, "character", "char_1");
		await store.addLink(presetP.id, "preset", "preset_9");

		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).map((p) => p.name)).toEqual(["g"]);
		expect((await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null })).map((p) => p.name)).toEqual(["g", "c"]);
		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: "preset_9" })).map((p) => p.name)).toEqual(["g", "p"]);
	});

	test("union of all three sources sorts by sortOrder with id tiebreak, dedups multi-source presets", async () => {
		const { store } = await setup();
		const g = await store.create(baseInput({ name: "global-one", isGlobal: true, sortOrder: 0 }));
		const c = await store.create(baseInput({ name: "char-one", sortOrder: 1 }));
		const p = await store.create(baseInput({ name: "preset-one", sortOrder: 2 }));
		const tieA = await store.create(baseInput({ name: "tie-a", isGlobal: true, sortOrder: 5 }));
		const tieB = await store.create(baseInput({ name: "tie-b", isGlobal: true, sortOrder: 5 }));
		void g;
		await store.addLink(c.id, "character", "char_1");
		await store.addLink(p.id, "preset", "preset_9");

		// Same preset reachable through BOTH junction sources appears once.
		const bothSources = await store.create(baseInput({ name: "both", sortOrder: 3 }));
		await store.addLink(bothSources.id, "character", "char_1");
		await store.addLink(bothSources.id, "preset", "preset_9");

		const resolved = await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: "preset_9" });
		expect(resolved.map((r) => r.name)).toEqual(["global-one", "char-one", "preset-one", "both", tieA.name, tieB.name]);
		// Equal sortOrder resolves by the stable id tiebreak (counter ids ascend
		// with creation order, so the earlier-created tieA sorts first).
		expect(resolved[4]!.id).toBe(tieA.id);
		expect(resolved[5]!.id).toBe(tieB.id);
	});

	test("excludes disabled presets from every source and ignores null ids", async () => {
		const { store } = await setup();
		await store.create(baseInput({ name: "disabled-global", isGlobal: true, disabled: true }));
		const disabledChar = await store.create(baseInput({ name: "disabled-char", disabled: true }));
		await store.addLink(disabledChar.id, "character", "char_1");

		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).toEqual([]);
		expect(await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null })).toEqual([]);
		expect(await store.resolveActiveRegexPresets({ characterId: "other_char", presetId: "other_preset" })).toEqual([]);
	});
});

describe("RegexStore delete cascades links", () => {
	test("deleting a preset removes its junction rows via FK cascade", async () => {
		const { store } = await setup();
		const preset = await store.create(baseInput());
		await store.addLink(preset.id, "character", "char_1");
		await store.addLink(preset.id, "preset", "preset_9");
		expect(await store.getLinks(preset.id)).toHaveLength(2);

		await store.delete(preset.id);
		expect(await store.getLinks(preset.id)).toEqual([]);
	});
});
