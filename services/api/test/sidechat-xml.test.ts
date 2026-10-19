import { describe, it, expect } from "bun:test";
import {
	renderCharacterSection,
	renderCurrentSceneSection,
	renderLoreSection,
	renderObjectivesSection,
	renderPersonaSection,
	renderTimelineSection,
	type SidechatTimelineEntry,
} from "../src/domain/sidechat/sidechat-xml.js";

/**
 * SC-3a — the sidechat XML renderers: PURE plain-fixture tests (T0 — no DB,
 * no container). Pins the unit's contract: every section renders exactly the
 * inventory's tag grammar (attributes in the pinned order, one child per
 * line); text escapes `& < >` and attribute values `& < > "` (an apostrophe
 * stays literal — the escape sets are pinned, not borrowed); empty sections
 * return null (no empty tag is ever emitted); an attached alternative
 * carries `selected="false"` while the chosen variant carries `selected="true"`;
 * and the timeline renders events and OOC messages interleaved in the order
 * given (listTimeline's seq order — the renderer never re-sorts).
 */

/** A message entry — the sidechat's own (OOC) turn. */
function ooc(role: string, content: string): SidechatTimelineEntry {
	return { rowType: "message", role, content };
}

describe("sidechat XML renderers (SC-3a)", () => {
	describe("sections", () => {
		it("character — full card inside <character name=…>, exact tag", () => {
			expect(
				renderCharacterSection({ name: "Theron", card: "A retired ship's cook with a hidden past." }),
			).toBe(`<character name="Theron">A retired ship's cook with a hidden past.</character>`);
		});

		it("persona — name, pronouns, text; the pronouns attribute drops when absent", () => {
			expect(renderPersonaSection({ name: "Sable", pronouns: "they/them", text: "A wandering bard." })).toBe(
				`<persona name="Sable" pronouns="they/them">A wandering bard.</persona>`,
			);
			expect(renderPersonaSection({ name: "Sable", pronouns: null, text: "A wandering bard." })).toBe(
				`<persona name="Sable">A wandering bard.</persona>`,
			);
			expect(renderPersonaSection({ name: "Sable", pronouns: "", text: "A wandering bard." })).toBe(
				`<persona name="Sable">A wandering bard.</persona>`,
			);
		});

		it("active_lore — one <lore_entry title=…> per entry", () => {
			expect(
				renderLoreSection([
					{ title: "The Harbor Road", text: "Flooded each spring; tolls double after dark." },
					{ title: "Theron's Debt", text: "Owed to the harbor guild since the fire." },
				]),
			).toBe(
				[
					"<active_lore>",
					`<lore_entry title="The Harbor Road">Flooded each spring; tolls double after dark.</lore_entry>`,
					`<lore_entry title="Theron's Debt">Owed to the harbor guild since the fire.</lore_entry>`,
					"</active_lore>",
				].join("\n"),
			);
		});

		it("objectives — the mode attribute carries route then goals verbatim", () => {
			expect(renderObjectivesSection({ mode: "route", text: "Reach the harbor before the tide turns." })).toBe(
				`<objectives mode="route">Reach the harbor before the tide turns.</objectives>`,
			);
			expect(renderObjectivesSection({ mode: "goals", text: "Learn what Theron hides." })).toBe(
				`<objectives mode="goals">Learn what Theron hides.</objectives>`,
			);
		});

		it("current_scene — text inside the tag, apostrophe literal", () => {
			expect(renderCurrentSceneSection("Night; the tavern's back room, rain on the windows.")).toBe(
				`<current_scene>Night; the tavern's back room, rain on the windows.</current_scene>`,
			);
		});
	});

	describe("escaping (text escapes & < >; attributes escape & < > \")", () => {
		it("character — name attribute and card text", () => {
			expect(
				renderCharacterSection({ name: `Alice "The Blade" & Co`, card: "Loves <rum> & fears >nothing" }),
			).toBe(
				`<character name="Alice &quot;The Blade&quot; &amp; Co">Loves &lt;rum&gt; &amp; fears &gt;nothing</character>`,
			);
		});

		it("active_lore — entry title attribute and text", () => {
			expect(renderLoreSection([{ title: `"Q" & <Aim>`, text: "Say & mean <all>" }])).toBe(
				[
					"<active_lore>",
					`<lore_entry title="&quot;Q&quot; &amp; &lt;Aim&gt;">Say &amp; mean &lt;all&gt;</lore_entry>`,
					"</active_lore>",
				].join("\n"),
			);
		});

		it("timeline — text content escapes & < > only (quote stays literal); author attribute escapes & < > \"", () => {
			const rendered = renderTimelineSection([
				ooc("user", `Pick the "quiet" option & skip the <fight>`),
				{
					rowType: "event",
					kind: "rp_sync",
					payload: {
						fromPosition: 0,
						toPosition: 0,
						messages: [
							{
								id: "m1",
								position: 0,
								role: "assistant",
								authorName: `Theron "Cook"`,
								variantId: "m1-v1",
								text: `It's <done> & "settled"`,
							},
						],
					},
				},
			]);
			expect(rendered).toBe(
				[
					`User: Pick the "quiet" option &amp; skip the &lt;fight&gt;`,
					`<rp_sync from="0" to="0">`,
					`<rp_message position="0" role="assistant" author="Theron &quot;Cook&quot;">It's &lt;done&gt; &amp; "settled"</rp_message>`,
					`</rp_sync>`,
				].join("\n"),
			);
		});
	});

	describe("empty sections are omitted (null, never an empty tag)", () => {
		it("character with an empty card → null", () => {
			expect(renderCharacterSection({ name: "Theron", card: "" })).toBeNull();
		});

		it("persona with empty text → null", () => {
			expect(renderPersonaSection({ name: "Sable", pronouns: "they/them", text: "" })).toBeNull();
		});

		it("active_lore with no entries → null", () => {
			expect(renderLoreSection([])).toBeNull();
		});

		it("objectives with empty text → null", () => {
			expect(renderObjectivesSection({ mode: "route", text: "" })).toBeNull();
		});

		it("current_scene with empty text → null", () => {
			expect(renderCurrentSceneSection("")).toBeNull();
		});

		it("empty timeline → null", () => {
			expect(renderTimelineSection([])).toBeNull();
		});

		it("whitespace-only content is content, not emptiness", () => {
			expect(renderCurrentSceneSection("  ")).toBe("<current_scene>  </current_scene>");
		});
	});

	describe("timeline", () => {
		it("events and OOC messages interleave in the order given (listTimeline seq order)", () => {
			const timeline: SidechatTimelineEntry[] = [
				ooc("user", "Plan the next beat for me."),
				{
					rowType: "event",
					kind: "rp_sync",
					payload: {
						fromPosition: 0,
						toPosition: 1,
						messages: [
							{ id: "m1", position: 0, role: "assistant", authorName: "Theron", variantId: "m1-v1", text: "The tavern door swings open." },
							{ id: "m2", position: 1, role: "user", authorName: "Sable", variantId: "m2-v1", text: "I step inside." },
						],
					},
				},
				ooc("assistant", "Here is a plan: raise the stakes."),
				{
					rowType: "event",
					kind: "selection_changed",
					payload: {
						messageId: "m2",
						position: 1,
						previous: { variantId: "m2-v1", text: "I step inside." },
						current: { variantId: "m2-v2", text: "I hesitate at the threshold." },
					},
				},
				{
					rowType: "event",
					kind: "variants_attached",
					payload: {
						position: 1,
						variants: [
							{ text: "I step inside.", selected: false },
							{ text: "I hesitate at the threshold.", selected: true },
						],
					},
				},
				{ rowType: "event", kind: "branch_forked", payload: { at: 1 } },
				{
					rowType: "event",
					kind: "rp_summary",
					payload: { fromPosition: 0, toPosition: 5, text: "The traveler arrived; a fork was taken." },
				},
				ooc("user", "Good. Continue."),
			];

			expect(renderTimelineSection(timeline)).toBe(
				[
					"User: Plan the next beat for me.",
					'<rp_sync from="0" to="1">',
					'<rp_message position="0" role="assistant" author="Theron">The tavern door swings open.</rp_message>',
					'<rp_message position="1" role="user" author="Sable">I step inside.</rp_message>',
					"</rp_sync>",
					"Assistant: Here is a plan: raise the stakes.",
					'<rp_selection_changed position="1">',
					"<previous>I step inside.</previous>",
					"<current>I hesitate at the threshold.</current>",
					"</rp_selection_changed>",
					'<rp_variants position="1">',
					'<variant selected="false">I step inside.</variant>',
					'<variant selected="true">I hesitate at the threshold.</variant>',
					"</rp_variants>",
					'<rp_branch_forked at="1"/>',
					'<rp_summary from="0" to="5">The traveler arrived; a fork was taken.</rp_summary>',
					"User: Good. Continue.",
				].join("\n"),
			);
		});

		it("an attached alternative carries selected=\"false\"; the chosen variant carries selected=\"true\"", () => {
			const rendered = renderTimelineSection([
				{
					rowType: "event",
					kind: "variants_attached",
					payload: {
						position: 4,
						variants: [
							{ text: "Alternative take.", selected: false },
							{ text: "Another alternative.", selected: false },
							{ text: "The chosen regeneration.", selected: true },
						],
					},
				},
			]);
			expect(rendered).toBe(
				[
					'<rp_variants position="4">',
					'<variant selected="false">Alternative take.</variant>',
					'<variant selected="false">Another alternative.</variant>',
					'<variant selected="true">The chosen regeneration.</variant>',
					"</rp_variants>",
				].join("\n"),
			);
		});

		it("rp_message keeps the fixed three-attribute shape — a null author renders as an empty attribute", () => {
			const rendered = renderTimelineSection([
				{
					rowType: "event",
					kind: "rp_sync",
					payload: {
						fromPosition: 2,
						toPosition: 2,
						messages: [
							{ id: "m3", position: 2, role: "user", authorName: null, variantId: "m3-v1", text: "A turn with no author." },
						],
					},
				},
			]);
			expect(rendered).toBe(
				[
					'<rp_sync from="2" to="2">',
					'<rp_message position="2" role="user" author="">A turn with no author.</rp_message>',
					"</rp_sync>",
				].join("\n"),
			);
		});

		it("an event kind outside the renderer's union throws instead of silently dropping the event", () => {
			const bogus = { rowType: "event", kind: "not_a_kind", payload: {} } as unknown as SidechatTimelineEntry;
			expect(() => renderTimelineSection([bogus])).toThrow(/unknown timeline event kind/);
		});
	});
});
