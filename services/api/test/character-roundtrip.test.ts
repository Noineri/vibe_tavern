/**
 * VTF-11 — full runtime round-trip characterization (VTF_NATIVE_ROUNDTRIP_PLAN).
 *
 * Pins lossless preservation of unknown fields across the COMPLETE runtime
 * cycle at the REAL store boundary — the gap the codec-level tests
 * (`monolith.test.ts`, `import-vtf-monolith.test.ts` with mocked deps) do not
 * cover. They exercise pack/unpack and the import tail in isolation; nothing
 * previously pinned `import → edit → export → fresh re-import → export` end to
 * end against a real SQLite store + content-store + `original.json` merge.
 *
 * This is the boundary where a silent regression would drop unknown fields a
 * user's card carried (custom keys, nested extension metadata, embedded
 * lorebooks) — exactly what `DUAL_STORAGE_FINALIZATION_PLAN` blocks its
 * destructive SQLite content-column cleanup on (see its `DSF-1_roundtrip_gate`
 * + `depends_on: VTF_NATIVE_ROUNDTRIP_PLAN`).
 *
 * Two channels are exercised because they preserve "unknowns" through DIFFERENT
 * mechanisms, and a regression in either must fail loudly:
 *
 *   1. JSON card (ST V2/V3): lossless via `original.json` — the whole parsed
 *      card is persisted; `exportCharacter` merges `{...origData, ...current}`
 *      so unknown top-level + `data` keys survive while known edits win.
 *   2. VTF monolith: no `original.json` (the field set is already lossless);
 *      unknowns ride in `extensions` (a free-form record) and `character_book`
 *      (promoted out of the extensions fence on import). The export→re-import
 *      cycle converts a monolith into a V3 JSON card, so this also pins that
 *      the JSON channel then carries those `extensions`/`character_book`
 *      fields stably forward.
 *
 * Per AGENTS.md §1: a boundary-level characterization test — the real
 * `SessionRuntime` against a temp SQLite DB, not a narrower serializer
 * substitute.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { packMonolith, type VtfCharacterContent } from "@vibe-tavern/db";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";

/** A real SessionRuntime backed by a fresh temp SQLite DB + content store. */
async function createTestRuntime(label: string) {
	const tmpDir = resolve(tmpdir(), `vt-roundtrip-${label}-${crypto.randomUUID().slice(0, 8)}`);
	await mkdir(resolve(tmpDir, "data"), { recursive: true });
	const stores = await createRuntimeStore(resolve(tmpDir, "data"));
	await Promise.all([
		stores.personas.ensureDefault(),
		stores.presets.ensureDefault(),
		stores.uiSettings.ensureDefaults(),
	]);
	const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
	const cleanup = async () => {
		try {
			await rm(tmpDir, { recursive: true, force: true });
		}
		catch { /* best-effort temp teardown */ }
	};
	return { runtime, stores, cleanup };
}

// ───────────────────────────────────────────────────────────────────────────
// Channel 1 — ST V3 JSON card (lossless via original.json)
// ───────────────────────────────────────────────────────────────────────────

/** A V3 card carrying fields the importer does NOT model: an unknown top-level
 *  key, an unknown `data` key, a nested unknown extension key, plus the known
 *  creator/version and an embedded character_book. Every unmodeled field must
 *  survive the full import → edit → export → re-import → export cycle. */
const V3_CARD = {
	spec: "chara_card_v3",
	spec_version: "3.0",
	// Unknown TOP-LEVEL key (outside `data`) — must survive.
	source_url: "https://example.com/origins/silvius",
	data: {
		name: "Silvius",
		description: "A watchful guardian.",
		personality: "calm",
		scenario: "A tavern at the forest's edge.",
		first_mes: "The door creaks open.",
		mes_example: "<START>\n{{char}}: Welcome.",
		creator_notes: "Internal notes.",
		creator: "anonymous",
		character_version: "1.0",
		tags: ["modern", "werewolf"],
		// Unknown DATA key — must survive.
		custom_mood: "brooding",
		alternate_greetings: ["A second opener."],
		extensions: {
			// Nested unknown extension key — must survive.
			fav_colour: "teal",
			talkativeness: "0.5",
		},
		character_book: {
			entries: [{ keys: ["scar"], content: "a silver scar" }],
		},
	},
};

describe("VTF-11 — JSON card round-trip (lossless via original.json)", () => {
	beforeAll(() => setTokenCountFn((text: string) => text.length));

	it("preserves unknown fields across import → edit → export → fresh re-import → export, with known edits winning", async () => {
		const envA = await createTestRuntime("json-a");
		try {
			// 1. Import the card into runtime A.
			const importA = await envA.runtime.importJson({
				fileName: "silvius.json",
				jsonText: JSON.stringify(V3_CARD),
			});
			expect(importA.characterId).toBeTruthy();
			const idA = importA.characterId!;

			// 2. Edit KNOWN fields through the real store (simulates a user edit).
			await envA.stores.characters.update(idA, {
				name: "Silvius Renamed",
				description: "An edited, watchful guardian.",
			});

			// 3. Export from A — original.json merge must keep unknowns while the
			//    edit wins for known fields.
			const exportedA = await envA.runtime.exportCharacter(idA);
			const dataA = exportedA.data as Record<string, unknown>;
			expect(dataA.name).toBe("Silvius Renamed"); // edit won
			expect(dataA.description).toBe("An edited, watchful guardian."); // edit won
			expect(exportedA.source_url).toBe("https://example.com/origins/silvius"); // unknown top-level preserved
			expect(dataA.custom_mood).toBe("brooding"); // unknown data key preserved
			expect((dataA.extensions as Record<string, unknown>).fav_colour).toBe("teal"); // nested ext unknown preserved
			expect(dataA.creator).toBe("anonymous"); // creator/version preserved
			expect(dataA.character_version).toBe("1.0");
			expect((dataA.character_book as Record<string, unknown>).entries).toHaveLength(1); // embedded lorebook preserved
			// V2 flatten mirrors known fields to the top level from `data`.
			expect(exportedA.name).toBe("Silvius Renamed");

			// 4. Re-import the exported card into a FRESH runtime B — a different
			//    store, no shared state. This is the boundary the codec tests
			//    cannot reach.
			const envB = await createTestRuntime("json-b");
			try {
				const importB = await envB.runtime.importJson({
					fileName: "silvius-exported.json",
					jsonText: JSON.stringify(exportedA),
				});
				expect(importB.characterId).toBeTruthy();
				const idB = importB.characterId!;

				// 5. Export from B — the cycle must be STABLE: same unknowns, same
				//    edited known values. This proves the exported card is itself a
				//    faithful input (idempotent round-trip), not a one-shot copy.
				const exportedB = await envB.runtime.exportCharacter(idB);
				const dataB = exportedB.data as Record<string, unknown>;
				expect(exportedB.source_url).toBe("https://example.com/origins/silvius");
				expect(dataB.custom_mood).toBe("brooding");
				expect((dataB.extensions as Record<string, unknown>).fav_colour).toBe("teal");
				expect(dataB.name).toBe("Silvius Renamed"); // edit persisted across re-import
				expect(dataB.description).toBe("An edited, watchful guardian.");
				expect(dataB.creator).toBe("anonymous");
				expect(dataB.character_version).toBe("1.0");
				expect((dataB.character_book as Record<string, unknown>).entries).toHaveLength(1);
			}
			finally {
				await envB.cleanup();
			}
		}
		finally {
			await envA.cleanup();
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Channel 2 — VTF monolith (extensions + character_book survive export→re-import)
// ───────────────────────────────────────────────────────────────────────────

/** A VTF-native character carrying unknown extension metadata and a nested
 *  `character_book` that must be PROMOTED to its own field on import. There is
 *  no `original.json` on this path — the field set is lossless by construction,
 *  so unknowns only survive if they live in `extensions`. */
const VTF_CONTENT: VtfCharacterContent = {
	name: "Monolithia",
	description: "A character from the native VTF format.",
	personalitySummary: "serene",
	defaultScenario: "A quiet grove.",
	firstMessage: "Leaves rustle softly.",
	mesExample: "<START>\n{{char}}: Hail, traveler.",
	mesExampleMode: "depth",
	mesExampleDepth: 4,
	alternateGreetings: ["Another opener from the grove."],
	postHistoryInstructions: "Stay terse.",
	creatorNotes: "VTF native.",
	depthPrompt: "Remember the hidden grove.",
	depthPromptDepth: 4,
	depthPromptRole: "system",
	systemPrompt: "Respond in second person.",
	tags: ["forest", "spirit"],
	extensions: {
		creator: "vtf-author",
		character_version: "2.0",
		// Unknown extension key — must survive the cycle.
		fav_colour: "teal",
		// Nested lorebook — PROMOTED to characterBook on import, then carried by
		// the exported V3 JSON's character_book field through re-import.
		character_book: { entries: [{ keys: ["grove"], content: "a hidden grove" }] },
	},
};

describe("VTF-11 — VTF monolith round-trip (extensions + character_book survive)", () => {
	beforeAll(() => setTokenCountFn((text: string) => text.length));

	it("preserves extension unknowns + promoted character_book across import → edit → export → fresh re-import → export", async () => {
		const envA = await createTestRuntime("vtf-a");
		try {
			// 1. Import the monolith into runtime A.
			const importA = await envA.runtime.importJson({
				fileName: "monolithia.md",
				monolithText: packMonolith(VTF_CONTENT),
			});
			expect(importA.characterId).toBeTruthy();
			const idA = importA.characterId!;

			// The embedded character_book must have been PROMOTED to its own field
			// (the import-vtf-monolith characterization pins this at the import
			// tail; here we confirm it lands in the REAL store).
			const stored = await envA.stores.characters.getById(idA);
			expect(stored).toBeTruthy();
			expect((stored!.characterBook as Record<string, unknown>).entries).toHaveLength(1);
			expect((stored!.extensions as Record<string, unknown>).fav_colour).toBe("teal");
			expect("character_book" in (stored!.extensions as Record<string, unknown>)).toBe(false);

			// 2. Edit a known field through the real store.
			await envA.stores.characters.update(idA, {
				name: "Monolithia Renamed",
			});

			// 3. Export from A as a V3 JSON card (the monolith path has NO
			//    original.json, so this is the conversion step).
			const exportedA = await envA.runtime.exportCharacter(idA);
			const dataA = exportedA.data as Record<string, unknown>;
			expect(dataA.name).toBe("Monolithia Renamed"); // edit won
			expect((dataA.extensions as Record<string, unknown>).fav_colour).toBe("teal"); // unknown extension survived
			expect((dataA.extensions as Record<string, unknown>).creator).toBe("vtf-author"); // creator stays in extensions (Character has no separate creator field)
			expect((dataA.character_book as Record<string, unknown>).entries).toHaveLength(1); // promoted book survived export

			// 4. Re-import the exported V3 JSON into a FRESH runtime B. The
			//    monolith has now become a JSON card; the JSON channel's
			//    original.json preservation must carry the extension/book forward.
			const envB = await createTestRuntime("vtf-b");
			try {
				const importB = await envB.runtime.importJson({
					fileName: "monolithia-exported.json",
					jsonText: JSON.stringify(exportedA),
				});
				expect(importB.characterId).toBeTruthy();
				const idB = importB.characterId!;

				// 5. Export from B — stable cycle.
				const exportedB = await envB.runtime.exportCharacter(idB);
				const dataB = exportedB.data as Record<string, unknown>;
				expect((dataB.extensions as Record<string, unknown>).fav_colour).toBe("teal");
				expect((dataB.character_book as Record<string, unknown>).entries).toHaveLength(1);
				expect(dataB.name).toBe("Monolithia Renamed"); // edit persisted across re-import
			}
			finally {
				await envB.cleanup();
			}
		}
		finally {
			await envA.cleanup();
		}
	});
});
