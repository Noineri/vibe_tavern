/**
 * Characterization test for importJsonBatch (Wave 2, MASS_IMPORT).
 *
 * Pins the three halves of the batch contract (reports/mass-import-bottleneck.md):
 *   1. All-success → one result per item, each with characterId + activeChatId.
 *   2. One bad card → collected into results[].error; the OTHER cards in the
 *      batch still import (partial-failure tolerance — the mass-import invariant).
 *   3. lean defaults to true (the only mass-import caller reads nothing else).
 *
 * Stubs ImportExportModuleDeps the same way import-lean.test.ts does — getSnapshot
 * is a throw-fail mock so any accidental non-lean path surfaces immediately.
 */
import { test, expect, mock, describe } from "bun:test";
import type { ImportExportModuleDeps } from "../src/runtime/session/session-runtime-import-export.js";
import { importJsonBatch } from "../src/runtime/session/session-runtime-import-export.js";

function makeCard(name: string, withEmbeddedBook = false) {
	return {
		fileName: `${name}.json`,
		jsonText: JSON.stringify({
			spec: "chara_card_v2",
			spec_version: "2.0",
			data: {
				name,
				description: "stub",
				...(withEmbeddedBook ? {
					character_book: {
						name: `${name} Lore`,
						entries: [{ keys: ["batch-key"], content: "Batch card lore", enabled: true }],
					},
				} : {}),
			},
		}),
	};
}

/** Stub deps: every successful create returns a deterministic id from the name. */
function makeDeps() {
	const getSnapshot = mock((_chatId: unknown) =>
		Promise.resolve({ chats: [], messages: [] }) as never,
	);
	const createLorebook = mock(async (_data: unknown) => ({ id: "lore_1" }));
	const bulkCreateEntries = mock(async (_id: unknown, _entries: unknown) => 1);
	const addLink = mock(async (_id: unknown, _type: unknown, _target: unknown) => undefined);
	const deps = {
		stores: {
			characters: {
				getById: mock((_id: string) => Promise.resolve(null)),
				create: mock((data: { name: string }) =>
					Promise.resolve({ id: `char_${data.name}` }) as never,
				),
				update: mock(() => Promise.resolve() as never),
				resolveFolderName: mock((id: string) => Promise.resolve(id)),
				listAll: mock(() => Promise.resolve([])),
			},
			lorebooks: { createLorebook, bulkCreateEntries, addLink },
			content: {
				writeEntity: mock(() => Promise.resolve("stub/path") as never),
			},
		},
		chatApp: {
			createChat: mock((input: { characterId: string }) =>
				Promise.resolve({ id: `chat_${input.characterId}`, activeBranchId: "br" }) as never,
			),
		},
		chatOrder: { add: mock(() => {}) },
		resolveDefaultPersonaId: mock(() => Promise.resolve("persona_default" as never)),
		resolveDefaultPromptPresetId: mock(() => Promise.resolve("preset_default" as never)),
		seedImportedOpening: mock(() => Promise.resolve() as never),
		getSnapshot,
		resolver: {
			getCharacter: () => { throw new Error("should not be called"); },
			getPersona: () => { throw new Error("should not be called"); },
		},
		fileStore: { resolvePath: () => { throw new Error("should not be called"); } },
	} as unknown as ImportExportModuleDeps;
	return { deps, getSnapshot, createLorebook, bulkCreateEntries, addLink };
}

describe("importJsonBatch — mass-import batch path (MASS_IMPORT Wave 2)", () => {
	test("all-success: one result per item, each with characterId + activeChatId, no getSnapshot", async () => {
		const { deps, getSnapshot } = makeDeps();

		const out = await importJsonBatch(deps, {
			items: [makeCard("Alpha"), makeCard("Beta"), makeCard("Gamma")],
		});

		expect(out.results).toHaveLength(3);
		// lean defaults to true → getSnapshot must NEVER be called.
		expect(getSnapshot).toHaveBeenCalledTimes(0);
		// Every result has ids and no error.
		for (const r of out.results) {
			expect(r.error).toBeUndefined();
			expect(r.characterId).toMatch(/^char_/);
			expect(r.activeChatId).toMatch(/^chat_char_/);
		}
		expect(out.results.map((r) => r.fileName).sort()).toEqual(["Alpha.json", "Beta.json", "Gamma.json"]);
	});

	test("bulk import automatically creates a character-bound embedded book", async () => {
		// Bulk has no confirmation surface, unlike ST's single-card prompt
		// (world-info.js:5559-5574), so it forces importEmbeddedBook on.
		const { deps, createLorebook, bulkCreateEntries, addLink } = makeDeps();
		await importJsonBatch(deps, { items: [makeCard("Embedded", true)] });
		expect(createLorebook).toHaveBeenCalledTimes(1);
		expect(bulkCreateEntries).toHaveBeenCalledTimes(1);
		// Owners are links (migration 0107): the create carries no home owner —
		// the import seam binds the imported character by lorebook_links.
		expect(createLorebook.mock.calls[0][0]).toMatchObject({
			name: "Embedded Lore",
			scopeType: "entity",
		});
		expect("characterId" in (createLorebook.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
		expect(addLink.mock.calls[0]).toEqual(["lore_1", "character", "char_Embedded"]);
	});

	test("partial failure: one bad card lands in results[].error; siblings still import", async () => {
		const { deps } = makeDeps();

		const out = await importJsonBatch(deps, {
			items: [
				makeCard("Good1"),
				{ fileName: "Broken.json", jsonText: "{ this is not valid json" },
				makeCard("Good2"),
			],
		});

		expect(out.results).toHaveLength(3);
		// The broken card has an error and no ids.
		const broken = out.results.find((r) => r.fileName === "Broken.json");
		expect(broken?.error).toBeTruthy();
		expect(broken?.characterId).toBeUndefined();
		// The good cards on either side still imported — this is the
		// mass-import invariant: one bad card must not roll back the batch.
		const good = out.results.filter((r) => !r.error);
		expect(good).toHaveLength(2);
		expect(good.map((r) => r.characterId).sort()).toEqual(["char_Good1", "char_Good2"]);
	});

	test("lean: false opts back into getSnapshot per item (escape hatch / future use)", async () => {
		const { deps, getSnapshot } = makeDeps();

		await importJsonBatch(deps, {
			items: [makeCard("X")],
			lean: false,
		});

		// Opting out of lean pays the snapshot cost once per item.
		expect(getSnapshot).toHaveBeenCalledTimes(1);
	});
});
