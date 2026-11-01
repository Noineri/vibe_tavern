/**
 * The ONE shared `ask_user` tool (DR-4b, owner ruling 2026-10-27 — unified at
 * the third consumer from the experience original + the AS-7 script fork).
 * Pins the tool's own contract at the factory level:
 *
 * - execute returns ONLY the awaiting marker (question/options/recommended
 *   echoed verbatim) — no persistence, no waiting (TAG-3);
 * - the `recommended` refine rejects a recommendation outside `options`
 *   (schema-level self-correction, the original inline tool's rule);
 * - the marker's shape is what the split-turn mechanism + the shared UI card
 *   dispatch on (status awaiting_answer).
 *
 * The three consuming kinds' suites pin their own gating/serving; this file
 * pins the shared implementation itself.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createAskUserTool, AGENT_ASK_USER_TOOL_NAME } from "../src/domain/agent/agent-ask-user-tool.js";

describe("createAskUserTool (DR-4b unification)", () => {
	test("the wire name is the mechanism's exact spelling", () => {
		expect(AGENT_ASK_USER_TOOL_NAME).toBe("ask_user");
	});

	test("execute returns only the awaiting marker, echoing question/options/recommended verbatim", async () => {
		const ask = createAskUserTool();
		const output = await ask.execute(
			{ question: "What tone should the story take?", options: ["Grim", "Cozy"], recommended: "Grim" },
			{ toolCallId: "tc_ask_1", messages: [] },
		);
		expect(output).toEqual({
			status: "awaiting_answer",
			question: "What tone should the story take?",
			options: ["Grim", "Cozy"],
			recommended: "Grim",
		});
	});

	test("an open question carries no options keys at all", async () => {
		const ask = createAskUserTool();
		const output = await ask.execute({ question: "Where should the story go?" }, { toolCallId: "tc_ask_2", messages: [] });
		expect(output).toEqual({ status: "awaiting_answer", question: "Where should the story go?" });
	});

	test("the schema's refine rejects a recommendation outside options", () => {
		const ask = createAskUserTool();
		// Read the input schema off the built tool and parse directly — the
		// refine is the SDK-side validation the loop surfaces to the model.
		const schema = ask.inputSchema as unknown as z.ZodTypeAny;
		expect(schema.safeParse({ question: "Tone?", options: ["Grim"], recommended: "Cozy" }).success).toBe(false);
		expect(schema.safeParse({ question: "Tone?", options: ["Grim"], recommended: "Grim" }).success).toBe(true);
		// The free-text escape: no options at all (and no recommendation).
		expect(schema.safeParse({ question: "Tone?" }).success).toBe(true);
	});
});
