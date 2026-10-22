import { describe, expect, it } from "bun:test";
import {
	renderRpPromptView,
	type RpPromptViewLayer,
	type RpPromptViewMessage,
} from "../src/domain/sidechat/rp-prompt-view.js";
import { PROMPT_LAYER_SOURCE_TYPE } from "@vibe-tavern/prompt-pipeline";

/**
 * SC-23c — the RP prompt view renderer in isolation (PURE: plain inputs in,
 * one `<rp_prompt>` string out; the loader arm's behavior is pinned in
 * sidechat-context.test.ts, SC-23e will reuse this module over stored
 * traces). Pins the plan's own scenarios:
 *
 * 1. payload order with roles and depths — blocks render in payload order,
 *    each entry keeps its role, in-chat injects carry `depth`;
 * 2. known layers as self-closing placeholders keeping their role (card,
 *    persona, summary, objective, scene);
 * 3. lore: held entries collapse to `<known layer="lore" entries="…">`, a
 *    NOT-held entry shows in full — the difference is the point;
 * 4. preset blocks and custom injects in full, with role and depth;
 * 5. history: ONE placeholder per contiguous run, positions compressed;
 * 6. payload-faithful merges: a held+unheld merged entry renders as ONE full
 *    block (never re-split), a fully-held merge renders as one placeholder
 *    with joined labels;
 * 7. escaping of text and attribute values; an empty payload → null (omit).
 */

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** A layer row with the view's fields (sourceType defaults to preset — the
 *  everything-else default the held decision leaves in full). */
function layer(input: Partial<RpPromptViewLayer> & { id: string }): RpPromptViewLayer {
	return {
		sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
		sourceId: `src_${input.id}`,
		sourceName: input.id,
		...input,
	};
}

/** A layer-entry payload message (the pipeline's final-payload shape). */
function layerMessage(input: Partial<RpPromptViewMessage> & { layerId: string; role: RpPromptViewMessage["role"]; content: string }): RpPromptViewMessage {
	return { ...input };
}

/** A history payload message (messageId + branch position). */
function historyMessage(messageId: string, position: number, role: RpPromptViewMessage["role"] = "user"): RpPromptViewMessage {
	return { role, content: `text of ${messageId}`, messageId, position };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("renderRpPromptView (SC-23c)", () => {
	it("renders payload entries in order with roles; in-chat injects carry depth; known layers collapse keeping role", () => {
		const view = renderRpPromptView({
			presetName: "Agentic Narrator",
			messages: [
				{ role: "system", content: "You are a grim narrator.", layerId: "prompt_preset_system" },
				{ role: "system", content: "the card", layerId: "character_base" },
				{ role: "system", content: "the persona", layerId: "persona" },
				{ role: "user", content: "Stay in the style of gothic prose.", layerId: "preset_injection_style" },
				{ role: "assistant", content: "Write the next beat.", layerId: "prompt_preset_jailbreak" },
			],
			layers: [
				layer({ id: "prompt_preset_system", sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset }),
				layer({ id: "character_base", sourceType: PROMPT_LAYER_SOURCE_TYPE.character }),
				layer({ id: "persona", sourceType: PROMPT_LAYER_SOURCE_TYPE.persona }),
				layer({
					id: "preset_injection_style",
					sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset,
					injectionDepth: 4,
				}),
				layer({ id: "prompt_preset_jailbreak", sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset }),
			],
			heldLoreEntryIds: new Set(),
		});
		expect(view).toBe(
			[
				'<rp_prompt preset="Agentic Narrator">',
				'<block id="prompt_preset_system" role="system">You are a grim narrator.</block>',
				'<known layer="character" role="system"/>',
				'<known layer="persona" role="system"/>',
				'<block id="preset_injection_style" role="user" depth="4">Stay in the style of gothic prose.</block>',
				'<block id="prompt_preset_jailbreak" role="assistant">Write the next beat.</block>',
				"</rp_prompt>",
			].join("\n"),
		);
	});

	it("a held lore entry collapses with its title; a NOT-held lore entry shows in full", () => {
		const view = renderRpPromptView({
			presetName: "P",
			messages: [
				{ role: "system", content: "The tavern never sleeps.", layerId: "lore_held" },
				{ role: "system", content: "The cellar hides a cult.", layerId: "lore_secret" },
			],
			layers: [
				layer({ id: "lore_held", sourceType: PROMPT_LAYER_SOURCE_TYPE.loreEntry, sourceId: "entry_held", sourceName: "Tavern" }),
				layer({ id: "lore_secret", sourceType: PROMPT_LAYER_SOURCE_TYPE.loreEntry, sourceId: "entry_secret", sourceName: "Cellar" }),
			],
			heldLoreEntryIds: new Set(["entry_held"]),
		});
		expect(view).toBe(
			[
				'<rp_prompt preset="P">',
				'<known layer="lore" entries="Tavern" role="system"/>',
				'<block id="lore_secret" role="system">The cellar hides a cult.</block>',
				"</rp_prompt>",
			].join("\n"),
		);
	});

	it("summary, objective and scene layers are known; insights/tool/retrieval blocks show in full", () => {
		const view = renderRpPromptView({
			presetName: "P",
			messages: [
				{ role: "system", content: "the summary", layerId: "summary_s1" },
				{ role: "system", content: "the task", layerId: "objective_task" },
				{ role: "system", content: "the goal", layerId: "objective_long_term" },
				{ role: "system", content: "the scene", layerId: "scene_state" },
				{ role: "user", content: "the insights instruction", layerId: "insights_instruction" },
				{ role: "system", content: "the tool instructions", layerId: "tool_instructions" },
				{ role: "system", content: "the retrieved memory", layerId: "retrieval_r1" },
			],
			layers: [
				layer({ id: "summary_s1", sourceType: PROMPT_LAYER_SOURCE_TYPE.summaryMemory }),
				layer({ id: "objective_task", sourceType: PROMPT_LAYER_SOURCE_TYPE.objectiveTask }),
				layer({ id: "objective_long_term", sourceType: PROMPT_LAYER_SOURCE_TYPE.objectiveLongTerm }),
				layer({ id: "scene_state", sourceType: PROMPT_LAYER_SOURCE_TYPE.sceneState }),
				layer({ id: "insights_instruction", sourceType: PROMPT_LAYER_SOURCE_TYPE.insightsInstruction }),
				layer({ id: "tool_instructions", sourceType: PROMPT_LAYER_SOURCE_TYPE.toolProfile }),
				layer({ id: "retrieval_r1", sourceType: PROMPT_LAYER_SOURCE_TYPE.retrievalMemory }),
			],
			heldLoreEntryIds: new Set(),
		});
		expect(view).toBe(
			[
				'<rp_prompt preset="P">',
				'<known layer="summary" role="system"/>',
				'<known layer="objective" role="system"/>',
				'<known layer="objective" role="system"/>',
				'<known layer="scene" role="system"/>',
				'<block id="insights_instruction" role="user">the insights instruction</block>',
				'<block id="tool_instructions" role="system">the tool instructions</block>',
				'<block id="retrieval_r1" role="system">the retrieved memory</block>',
				"</rp_prompt>",
			].join("\n"),
		);
	});

	it("history: one placeholder per contiguous run, positions compressed to ranges (single, gaps)", () => {
		const view = renderRpPromptView({
			presetName: "P",
			messages: [
				historyMessage("m1", 0),
				historyMessage("m2", 1, "assistant"),
				historyMessage("m3", 2),
				{ role: "user", content: "an inject between runs", layerId: "preset_injection_mid" },
				historyMessage("m4", 5),
			],
			layers: [layer({ id: "preset_injection_mid", sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset, injectionDepth: 2 })],
			heldLoreEntryIds: new Set(),
		});
		expect(view).toBe(
			[
				'<rp_prompt preset="P">',
				'<known layer="history" positions="0–2"/>',
				'<block id="preset_injection_mid" role="user" depth="2">an inject between runs</block>',
				'<known layer="history" positions="5"/>',
				"</rp_prompt>",
			].join("\n"),
		);
	});

	it("positions of messages absorbed by a same-role merge join the run's placeholder (gaps render as lists)", () => {
		const view = renderRpPromptView({
			presetName: "P",
			messages: [
				{
					role: "user",
					content: "two absorbed messages ride one entry",
					messageId: "m1",
					position: 0,
					mergedFrom: [{ messageId: "m2", position: 1 }, { layerId: "character_base" }],
				},
			],
			layers: [layer({ id: "character_base", sourceType: PROMPT_LAYER_SOURCE_TYPE.character })],
			heldLoreEntryIds: new Set(),
		});
		// The absorbed character layer is held → the entry stays a history
		// placeholder whose positions cover both messages.
		expect(view).toBe(
			[
				'<rp_prompt preset="P">',
				'<known layer="history" positions="0–1"/>',
				"</rp_prompt>",
			].join("\n"),
		);

		const gapped = renderRpPromptView({
			presetName: "P",
			messages: [
				historyMessage("m1", 0),
				historyMessage("m2", 3),
			],
			layers: [],
			heldLoreEntryIds: new Set(),
		});
		expect(gapped).toContain('<known layer="history" positions="0, 3"/>');
	});

	it("a merged held+unheld entry renders as ONE full block — never re-split; a fully-held merge renders one placeholder with joined labels", () => {
		const mixed = renderRpPromptView({
			presetName: "P",
			messages: [
				{
					role: "system",
					content: "You are a grim narrator.\n\nthe card",
					layerId: "prompt_preset_system",
					mergedFrom: [{ layerId: "character_base" }],
				},
			],
			layers: [
				layer({ id: "prompt_preset_system", sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset }),
				layer({ id: "character_base", sourceType: PROMPT_LAYER_SOURCE_TYPE.character }),
			],
			heldLoreEntryIds: new Set(),
		});
		expect(mixed).toBe(
			[
				'<rp_prompt preset="P">',
				'<block id="prompt_preset_system" role="system">You are a grim narrator.\n\nthe card</block>',
				"</rp_prompt>",
			].join("\n"),
		);

		const allHeld = renderRpPromptView({
			presetName: "P",
			messages: [
				{
					role: "system",
					content: "the card\n\nthe persona",
					layerId: "character_base",
					mergedFrom: [{ layerId: "persona" }],
				},
			],
			layers: [
				layer({ id: "character_base", sourceType: PROMPT_LAYER_SOURCE_TYPE.character }),
				layer({ id: "persona", sourceType: PROMPT_LAYER_SOURCE_TYPE.persona }),
			],
			heldLoreEntryIds: new Set(),
		});
		expect(allHeld).toBe(
			[
				'<rp_prompt preset="P">',
				'<known layer="character+persona" role="system"/>',
				"</rp_prompt>",
			].join("\n"),
		);
	});

	it("a history entry that absorbed a non-held inject opens in full, attributed to the inject", () => {
		const view = renderRpPromptView({
			presetName: "P",
			messages: [
				{
					role: "user",
					content: "stay in the mood\n\nthe story turn",
					messageId: "m9",
					position: 7,
					mergedFrom: [{ layerId: "preset_injection_mood" }],
				},
			],
			layers: [
				layer({ id: "preset_injection_mood", sourceType: PROMPT_LAYER_SOURCE_TYPE.promptPreset, injectionDepth: 1 }),
			],
			heldLoreEntryIds: new Set(),
		});
		expect(view).toBe(
			[
				'<rp_prompt preset="P">',
				'<block id="preset_injection_mood" role="user" depth="1">stay in the mood\n\nthe story turn</block>',
				"</rp_prompt>",
			].join("\n"),
		);
	});

	it("escapes text content and attribute values; an unknown layer id still renders in full; empty payload → null", () => {
		const view = renderRpPromptView({
			presetName: `Q & "A" <preset>`,
			messages: [
				{ role: "system", content: "amp & lt < gt > quote \"", layerId: "mystery_layer" },
			],
			layers: [],
			heldLoreEntryIds: new Set(),
		});
		expect(view).toBe(
			[
				'<rp_prompt preset="Q &amp; &quot;A&quot; &lt;preset&gt;">',
				'<block id="mystery_layer" role="system">amp &amp; lt &lt; gt &gt; quote "</block>',
				"</rp_prompt>",
			].join("\n"),
		);
		expect(renderRpPromptView({ presetName: "P", messages: [], layers: [], heldLoreEntryIds: new Set() })).toBeNull();
	});
});
