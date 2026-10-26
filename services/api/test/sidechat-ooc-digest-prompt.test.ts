/**
 * The sidechat digest prompt asset (SIDECHAT_PLAN, Wave 2 / SC-8b).
 *
 * SC-8c's digest service will consume the `sidechat_ooc_digest` service
 * prompt; this unit lands the EDITABLE KEY + ASSET only (owner 2026-10-20).
 * Pins:
 * 1. The registry maps the key to `agent-sidechat/ooc-digest.md` and the
 *    asset loads non-empty through that map (S2-0a style: real assets must
 *    load).
 * 2. The asset carries the plan row's content rules, by key phrases: only
 *    the OOC exchanges older than the verbatim tail are summarized; the RP
 *    material given alongside them is reference, never digest material;
 *    proposals and guesses are discussed, the user's decisions are decided,
 *    unselected or rejected variants did not happen.
 * 3. The key is a bases-family service prompt listed directly after
 *    `sidechat_ooc_base`, so the pane shows «Сводка сайдчата» (EN "Sidechat
 *    digest") next to «База сайдчата» — the label lives in en/ru.json under
 *    `promptManager.servicePrompts.field.sidechat_ooc_digest`.
 */

import { describe, expect, test } from "bun:test";
import { SERVICE_PROMPT_FIELD_FAMILIES, SERVICE_PROMPT_FIELD_KEYS, SERVICE_PROMPT_FIELDS } from "@vibe-tavern/domain";
import { getServicePromptAssetFile } from "../src/domain/service-prompts/service-prompt-registry.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";

describe("the sidechat_ooc_digest asset — SC-8b pin", () => {
	test("agent-sidechat/ooc-digest.md loads non-empty through the registry map", async () => {
		expect(getServicePromptAssetFile("sidechat_ooc_digest")).toBe("agent-sidechat/ooc-digest.md");
		const text = await loadPromptAsset(getServicePromptAssetFile("sidechat_ooc_digest"));
		expect(text.trim().length).toBeGreaterThan(0);
	});

	test("the asset carries the digest rules by key phrases", async () => {
		const text = await loadPromptAsset("agent-sidechat/ooc-digest.md");
		// Only the OOC exchanges older than the verbatim tail.
		expect(text).toContain("Summarize only the OOC exchanges older than the verbatim tail");
		// The RP material is reference, never digest material.
		expect(text).toContain("reference for what the discussion was about, not material to summarize");
		expect(text).toContain("never restate RP facts");
		// Proposals and guesses are discussed.
		expect(text).toContain("Proposals and guesses");
		expect(text).toContain("are discussed");
		// The user's decisions are decided.
		expect(text).toContain("The user's decisions are decided");
		// Unselected or rejected variants did not happen.
		expect(text).toContain("Unselected or rejected variants did not happen");
	});

	test("the key is a bases-family field listed right after sidechat_ooc_base", () => {
		expect(SERVICE_PROMPT_FIELDS.sidechat_ooc_digest.family).toBe(SERVICE_PROMPT_FIELD_FAMILIES.bases);
		expect(SERVICE_PROMPT_FIELD_KEYS.indexOf("sidechat_ooc_digest")).toBe(
			SERVICE_PROMPT_FIELD_KEYS.indexOf("sidechat_ooc_base") + 1,
		);
	});
});
