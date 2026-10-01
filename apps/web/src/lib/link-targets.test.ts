import { describe, expect, test } from "bun:test";
import { brandId, type RegexPresetId } from "@vibe-tavern/domain";

import {
	characterToLinkTarget,
	personaToLinkTarget,
	lorebookToLinkTarget,
	scriptToLinkTarget,
	regexToLinkTarget,
	promptPresetToLinkTarget,
	type CharacterLinkSource,
	type PersonaLinkSource,
	type LorebookLinkSource,
	type ScriptLinkSource,
	type RegexLinkSource,
	type PromptPresetLinkSource,
} from "./link-targets.js";

describe("lib/link-targets — the single record→LinkTarget source (LB-2A)", () => {
	test("characterToLinkTarget carries the full canonical avatar-field set", () => {
		const c: CharacterLinkSource = {
			id: "char_1",
			name: "Kiran",
			avatarAssetId: "asset_9",
			avatarFullAssetId: "asset_10",
			avatarExt: "webp",
			avatarFullExt: "png",
			updatedAt: "2026-10-01T12:00:00.000Z",
		};
		// toEqual on the FULL object: an extra or a missing field fails.
		expect(characterToLinkTarget(c)).toEqual({
			id: "char_1",
			name: "Kiran",
			avatarAssetId: "asset_9",
			kind: "characters",
			avatarExt: "webp",
			avatarFullExt: "png",
			avatarFullAssetId: "asset_10",
			updatedAt: "2026-10-01T12:00:00.000Z",
		});
	});

	test("personaToLinkTarget carries the full set — including avatarFullAssetId", () => {
		const p: PersonaLinkSource = {
			id: "pers_1",
			name: "User",
			avatarAssetId: null,
			avatarFullAssetId: "asset_77",
			avatarExt: null,
			avatarFullExt: null,
			updatedAt: "2026-10-01T13:30:00.000Z",
		};
		// The pre-LB-2A LorebookEditor mapping dropped avatarFullAssetId —
		// the canonical mapper never does (legacy flat-avatar full-slot
		// resolution depends on it).
		expect(personaToLinkTarget(p)).toEqual({
			id: "pers_1",
			name: "User",
			avatarAssetId: null,
			kind: "personas",
			avatarExt: null,
			avatarFullExt: null,
			avatarFullAssetId: "asset_77",
			updatedAt: "2026-10-01T13:30:00.000Z",
		});
	});

	test("personaToLinkTarget with every avatar field set", () => {
		const p: PersonaLinkSource = {
			id: "pers_2",
			name: "Another",
			avatarAssetId: "asset_1",
			avatarFullAssetId: "asset_2",
			avatarExt: "png",
			avatarFullExt: "png",
			updatedAt: "2026-09-30T08:00:00.000Z",
		};
		expect(personaToLinkTarget(p)).toEqual({
			id: "pers_2",
			name: "Another",
			avatarAssetId: "asset_1",
			kind: "personas",
			avatarExt: "png",
			avatarFullExt: "png",
			avatarFullAssetId: "asset_2",
			updatedAt: "2026-09-30T08:00:00.000Z",
		});
	});

	test("lorebookToLinkTarget: no avatar, updatedAt passed through", () => {
		const lb: LorebookLinkSource = { id: "lb_1", name: "World lore", updatedAt: "2026-10-01T09:15:00.000Z" };
		expect(lorebookToLinkTarget(lb)).toEqual({
			id: "lb_1",
			name: "World lore",
			avatarAssetId: null,
			updatedAt: "2026-10-01T09:15:00.000Z",
		});
	});

	test("scriptToLinkTarget: no avatar, updatedAt passed through", () => {
		const sc: ScriptLinkSource = { id: "sc_1", name: "Echo script", updatedAt: "2026-10-01T10:45:00.000Z" };
		expect(scriptToLinkTarget(sc)).toEqual({
			id: "sc_1",
			name: "Echo script",
			avatarAssetId: null,
			updatedAt: "2026-10-01T10:45:00.000Z",
		});
	});

	test("regexToLinkTarget: no avatar, updatedAt passed through", () => {
		const rx: RegexLinkSource = { id: brandId<RegexPresetId>("rx_1"), name: "Quote cleanup", updatedAt: "2026-10-01T11:20:00.000Z" };
		expect(regexToLinkTarget(rx)).toEqual({
			id: "rx_1",
			name: "Quote cleanup",
			avatarAssetId: null,
			updatedAt: "2026-10-01T11:20:00.000Z",
		});
	});

	test("promptPresetToLinkTarget: no avatar, updatedAt passed through (LB-2D)", () => {
		const p: PromptPresetLinkSource = { id: "ps_1", name: "Verbose", updatedAt: "2026-10-01T11:55:00.000Z" };
		expect(promptPresetToLinkTarget(p)).toEqual({
			id: "ps_1",
			name: "Verbose",
			avatarAssetId: null,
			updatedAt: "2026-10-01T11:55:00.000Z",
		});
	});

	test("promptPresetToLinkTarget: missing updatedAt normalizes to null (LB-2D)", () => {
		// A state row that never carried the timestamp — the DTO always does,
		// but the input type allows its absence; null sorts last, never NaN.
		const p: PromptPresetLinkSource = { id: "ps_2", name: "Lean" };
		expect(promptPresetToLinkTarget(p)).toEqual({
			id: "ps_2",
			name: "Lean",
			avatarAssetId: null,
			updatedAt: null,
		});
	});
});
