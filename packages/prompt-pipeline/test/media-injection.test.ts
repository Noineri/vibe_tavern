import { describe, it, expect } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";

/**
 * A7 — media (avatar/gallery) prompt injection.
 *
 * These layers are TEXT-only appearance blocks sourced from vision-generated
 * descriptions. They route through resolver.position() with a
 * DEFAULT_PROMPT_ORDER rank (< 100 → before_chat zone), so they behave like
 * every other built-in slot: canvas-toggleable in advanced mode, always-on in
 * simple mode, ordered adjacent to the character block.
 *
 * Gating is two-level: (1) the per-character `includeXInPrompt` toggle +
 * non-empty content, AND (2) `resolver.enabled(identifier)` (canvas slot).
 */
function baseContext(overrides: Record<string, unknown> = {}) {
	return {
		identity: { chatId: "chat_1" },
		chat: {
			recentMessages: [
				{ id: "msg_1", role: "user", content: "Hello." },
				{ id: "msg_2", role: "assistant", content: "Hi there." },
			],
		},
		character: {
			id: "char_1",
			name: "Aria",
			description: "A fire mage.",
			scenario: "The tower burns.",
			systemPrompt: null,
		},
		...overrides,
	};
}

/** Character context with personality + avatar/gallery media fields filled in. */
function mediaCharacter(overrides: Record<string, unknown> = {}) {
	return {
		id: "char_1",
		name: "Aria",
		description: "A fire mage.",
		personality: "Bold and fierce.",
		// Media (A7)
		avatarDescription: "A tall woman with crimson hair and glowing amber eyes.",
		includeAvatarInPrompt: true,
		gallery: [
			{ caption: "outfit", description: "She wears a black battle dress." },
			{ caption: "weapon", description: "A flaming staff wreathed in embers." },
		],
		includeGalleryInPrompt: true,
		...overrides,
	};
}

describe("A7 media injection", () => {
	describe("characterAvatar layer", () => {
		it("emits when include toggle on + description present", () => {
			const result = assemblePrompt(baseContext({ character: mediaCharacter() }));
			const layer = result.layers.find((l) => l.id === "character_avatar");
			expect(layer).toBeTruthy();
			expect(layer!.text).toContain("[Character appearance:");
			expect(layer!.text).toContain("crimson hair");
			expect(layer!.sourceName).toBe("Aria — Appearance");
			expect(layer!.sourceType).toBe("character_avatar");
		});

		it("is suppressed when includeAvatarInPrompt is false", () => {
			const result = assemblePrompt(baseContext({
				character: mediaCharacter({ includeAvatarInPrompt: false }),
			}));
			expect(result.layers.find((l) => l.id === "character_avatar")).toBeUndefined();
		});

		it("is suppressed when avatarDescription is empty/whitespace", () => {
			for (const desc of ["", "   ", null]) {
				const result = assemblePrompt(baseContext({
					character: mediaCharacter({ avatarDescription: desc }),
				}));
				expect(result.layers.find((l) => l.id === "character_avatar"), `desc=${JSON.stringify(desc)}`).toBeUndefined();
			}
		});
	});

	describe("characterGallery layer", () => {
		it("emits a combined block joining all described rows", () => {
			const result = assemblePrompt(baseContext({ character: mediaCharacter() }));
			const layer = result.layers.find((l) => l.id === "character_gallery");
			expect(layer).toBeTruthy();
			expect(layer!.text).toContain("[Character references:");
			expect(layer!.text).toContain('Image "outfit": She wears a black battle dress.');
			expect(layer!.text).toContain('Image "weapon": A flaming staff wreathed in embers.');
			// both rows in one layer (not two separate layers)
			expect(result.layers.filter((l) => l.id === "character_gallery")).toHaveLength(1);
		});

		it("is suppressed when includeGalleryInPrompt is false", () => {
			const result = assemblePrompt(baseContext({
				character: mediaCharacter({ includeGalleryInPrompt: false }),
			}));
			expect(result.layers.find((l) => l.id === "character_gallery")).toBeUndefined();
		});

		it("is suppressed when gallery is empty or null", () => {
			for (const gallery of [[], null] as const) {
				const result = assemblePrompt(baseContext({
					character: mediaCharacter({ gallery }),
				}));
				expect(result.layers.find((l) => l.id === "character_gallery"), `gallery=${JSON.stringify(gallery)}`).toBeUndefined();
			}
		});

		it("is suppressed when includeGalleryInPrompt is true but gallery is null", () => {
			// caller pre-filters to described rows; an empty result yields null
			const result = assemblePrompt(baseContext({
				character: mediaCharacter({ gallery: null }),
			}));
			expect(result.layers.find((l) => l.id === "character_gallery")).toBeUndefined();
		});
	});

	describe("personaAvatar layer", () => {
		it("emits when include toggle on + description present", () => {
			const result = assemblePrompt(baseContext({
				character: mediaCharacter(),
				persona: {
					id: "pers_1",
					name: "Kai",
					description: "A wandering scholar.",
					avatarDescription: "A young person with glasses and a worn cloak.",
					includeAvatarInPrompt: true,
				},
			}));
			const layer = result.layers.find((l) => l.id === "persona_avatar");
			expect(layer).toBeTruthy();
			expect(layer!.text).toContain("[Persona appearance:");
			expect(layer!.text).toContain("glasses");
			expect(layer!.sourceName).toBe("Kai — Appearance");
		});

		it("is suppressed when toggle off", () => {
			const result = assemblePrompt(baseContext({
				character: mediaCharacter(),
				persona: {
					id: "pers_1",
					name: "Kai",
					description: "A scholar.",
					avatarDescription: "desc",
					includeAvatarInPrompt: false,
				},
			}));
			expect(result.layers.find((l) => l.id === "persona_avatar")).toBeUndefined();
		});

		it("is absent when persona has no avatar fields (backward compatible)", () => {
			const result = assemblePrompt(baseContext({
				character: mediaCharacter(),
				persona: { id: "pers_1", name: "Kai", description: "A scholar." },
			}));
			expect(result.layers.find((l) => l.id === "persona_avatar")).toBeUndefined();
		});
	});

	describe("ordering & zone", () => {
		it("media layers land in before_chat (DEFAULT_PROMPT_ORDER < chatHistory)", () => {
			const result = assemblePrompt(baseContext({
				character: mediaCharacter(),
				persona: {
					id: "pers_1", name: "Kai", description: "A scholar.",
					avatarDescription: "x", includeAvatarInPrompt: true,
				},
			}));
			// before_chat layers are rendered in the system prompt (in_prompt position
			// after resolver.position maps before_chat→in_prompt). The key invariant:
			// their subPosition ranks place them between the character block and
			// chatHistory. Verify they exist and sort after personality, before history.
			const avatar = result.layers.find((l) => l.id === "character_avatar")!;
			const personality = result.layers.find((l) => l.id === "character_personality")!;
			expect(avatar.subPosition!).toBeGreaterThan(personality.subPosition!);
			// chatHistory is the message layers; media must rank before it.
			const historyLayer = result.layers.find((l) => l.sourceType === "chat_history" || l.id === "recent_history");
			if (historyLayer?.subPosition != null) {
				expect(avatar.subPosition!).toBeLessThan(historyLayer.subPosition);
			}
		});

		it("characterGallery ranks after characterAvatar, personaAvatar after persona", () => {
			const result = assemblePrompt(baseContext({
				character: mediaCharacter(),
				persona: {
					id: "pers_1", name: "Kai", description: "A scholar.",
					avatarDescription: "x", includeAvatarInPrompt: true,
				},
			}));
			const cAvatar = result.layers.find((l) => l.id === "character_avatar")!.subPosition!;
			const cGallery = result.layers.find((l) => l.id === "character_gallery")!.subPosition!;
			const persona = result.layers.find((l) => l.id === "persona")!.subPosition!;
			const pAvatar = result.layers.find((l) => l.id === "persona_avatar")!.subPosition!;
			expect(cGallery).toBeGreaterThan(cAvatar);
			expect(pAvatar).toBeGreaterThan(persona);
		});
	});

	describe("advanced-mode canvas toggle", () => {
		it("characterAvatar honors resolver.enabled(false) via canvas", () => {
			// advancedMode + a canvas that disables characterAvatar. The layer
			// must be suppressed even though the character opted in.
			const result = assemblePrompt(baseContext({
				character: mediaCharacter(),
				preset: {
					id: "preset_1",
					text: "system",
					advancedMode: true,
					promptOrder: [
						{ identifier: "characterAvatar", enabled: false },
					],
				},
			}));
			expect(result.layers.find((l) => l.id === "character_avatar")).toBeUndefined();
		});

		it("characterGallery honored when canvas entry is enabled (or absent)", () => {
			// No canvas entry for characterGallery → resolver.enabled defaults true.
			const result = assemblePrompt(baseContext({
				character: mediaCharacter(),
				preset: {
					id: "preset_1",
					text: "system",
					advancedMode: true,
					promptOrder: [
						{ identifier: "characterAvatar", enabled: true },
					],
				},
			}));
			expect(result.layers.find((l) => l.id === "character_gallery")).toBeTruthy();
			expect(result.layers.find((l) => l.id === "character_avatar")).toBeTruthy();
		});
	});

	describe("no regression", () => {
		it("media layers absent when context has no media fields (default)", () => {
			const result = assemblePrompt(baseContext());
			expect(result.layers.find((l) => l.id === "character_avatar")).toBeUndefined();
			expect(result.layers.find((l) => l.id === "character_gallery")).toBeUndefined();
			expect(result.layers.find((l) => l.id === "persona_avatar")).toBeUndefined();
			// existing character layers still present
			expect(result.layers.find((l) => l.id === "character_base")).toBeTruthy();
			expect(result.layers.find((l) => l.id === "character_scenario")).toBeTruthy();
		});
	});
});
