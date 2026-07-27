/**
 * CA-10.1 — character→draft mapping (characterization).
 *
 * Pins `characterDefaults`: a snapshot AppCharacter seeds a BuildCharacterDraft
 * exactly as BuildMode expects (and now CoauthorCharacterForm too). The mapping
 * is the single source of truth for form default-values, so any drift here
 * would surface as a "field resets to wrong value on editor open" bug in BOTH
 * editors. Covers: null-coercing fields (firstMessage/mesExample/etc. null → ""),
 * numeric defaults with ?? fallbacks, mode enum coercion, and pass-through
 * (non-null) fields preserved verbatim.
 */
import { describe, it, expect } from "bun:test";
import { buildCharacterDraftSchema } from "@vibe-tavern/api-contracts";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import type { AppCharacter } from "../app-client.js";
import { characterDefaults, EMPTY_BUILD_DRAFT } from "./character-draft.js";

function makeCharacter(over: Partial<AppCharacter> = {}): AppCharacter {
	return {
		id: "char_test",
		name: "Kira",
		description: "A reserved arachnid weaver.",
		scenario: "A forest cave.",
		systemPrompt: "You are Kira.",
		subtitle: "",
		firstMessage: "Welcome to my web.",
		mesExample: "{{char}}: *tilts head*",
		mesExampleMode: "depth",
		mesExampleDepth: 7,
		alternateGreetings: ["A second greeting."],
		postHistoryInstructions: "Stay in character.",
		creatorNotes: "An arachnid OC.",
		depthPrompt: "[OOC: be terse]",
		depthPromptDepth: 2,
		depthPromptRole: "system",
		tags: ["fantasy", "oc"],
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		personalitySummary: "Quiet, observant.",
		includeGalleryInPrompt: false,
		includeAvatarInPrompt: false,
		avatarDescription: null,
		updatedAt: "2026-06-30T00:00:00Z",
		...over,
	};
}

describe("characterDefaults", () => {
	it("maps a fully-populated character to a complete draft verbatim", () => {
		const draft = characterDefaults(makeCharacter());
		const expected: BuildCharacterDraft = {
			name: "Kira",
			description: "A reserved arachnid weaver.",
			firstMessage: "Welcome to my web.",
			mesExample: "{{char}}: *tilts head*",
			mesExampleMode: "depth",
			mesExampleDepth: 7,
			scenario: "A forest cave.",
			personalitySummary: "Quiet, observant.",
			systemPrompt: "You are Kira.",
			alternateGreetings: ["A second greeting."],
			postHistoryInstructions: "Stay in character.",
			creatorNotes: "An arachnid OC.",
			depthPrompt: "[OOC: be terse]",
			depthPromptDepth: 2,
			depthPromptRole: "system",
			tags: ["fantasy", "oc"],
		};
		expect(draft).toEqual(expected);
	});

	it("coerces nullable prose fields (null → \"\") so the editor body is well-formed", () => {
		const draft = characterDefaults(
			makeCharacter({
				firstMessage: null,
				mesExample: null,
				personalitySummary: null,
				postHistoryInstructions: null,
				creatorNotes: null,
				depthPrompt: null,
			}),
		);
		expect(draft.firstMessage).toBe("");
		expect(draft.mesExample).toBe("");
		expect(draft.personalitySummary).toBe("");
		expect(draft.postHistoryInstructions).toBe("");
		expect(draft.creatorNotes).toBe("");
		expect(draft.depthPrompt).toBe("");
	});

	it("applies numeric/enum defaults when the source fields are null/absent", () => {
		const draft = characterDefaults(
			makeCharacter({
				mesExampleMode: "",
				depthPromptDepth: null,
				depthPromptRole: null,
				alternateGreetings: [],
				tags: [],
			}),
		);
		expect(draft.mesExampleMode).toBe("always"); // "" → fallback "always"
		expect(draft.depthPromptDepth).toBe(4); // null → 4
		expect(draft.depthPromptRole).toBe("system"); // null → "system"
		expect(draft.alternateGreetings).toEqual([]);
		expect(draft.tags).toEqual([]);
	});

	it("preserves 0 as a valid numeric value (not coerced to the default)", () => {
		// mesExampleDepth is typed `number` (non-null); 0 is a real value, so the
		// `?? 4` defensive fallback must NOT fire on it.
		const draft = characterDefaults(makeCharacter({ mesExampleDepth: 0 }));
		expect(draft.mesExampleDepth).toBe(0);
	});
});

describe("EMPTY_BUILD_DRAFT", () => {
	it("covers every field in buildCharacterDraftSchema (no missing/extra keys)", () => {
		// The create-character modal seeds useForm from this baseline. A new required
		// field added to BuildCharacterDraft must be added here too — the
		// `: BuildCharacterDraft` annotation catches a missing key at compile time;
		// this asserts the runtime key set matches the schema shape so a shape/seed
		// drift can't slip through either side.
		const schemaKeys = Object.keys(buildCharacterDraftSchema.shape).sort();
		const draftKeys = Object.keys(EMPTY_BUILD_DRAFT).sort();
		expect(draftKeys).toEqual(schemaKeys);
	});

	it("seeds creation-faithful defaults (mode/depth/role + empty collections)", () => {
		// name "" intentionally fails the schema's min(1) — the user must enter a
		// name, and `canSave` gates submission until they do; the resolver only
		// validates on submit, so mounting on the empty baseline is fine.
		expect(EMPTY_BUILD_DRAFT.name).toBe("");
		expect(EMPTY_BUILD_DRAFT.mesExampleMode).toBe("always");
		expect(EMPTY_BUILD_DRAFT.mesExampleDepth).toBe(4);
		expect(EMPTY_BUILD_DRAFT.depthPromptDepth).toBe(4);
		expect(EMPTY_BUILD_DRAFT.depthPromptRole).toBe("system");
		expect(EMPTY_BUILD_DRAFT.alternateGreetings).toEqual([]);
		expect(EMPTY_BUILD_DRAFT.tags).toEqual([]);
	});
});
