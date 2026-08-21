/**
 * Conversation builtin — bounded message history (INTERACTIVE_ENGINE_EXPANSION,
 * fix step 3).
 *
 * Drives the REAL shipped Conversation rules source
 * (`CONVERSATION_RULES_SOURCE` from `@vibe-tavern/domain`) through the public
 * kernel surface (`runCreate` / `runReduce`) and pins that its `reduce` now
 * bounds `state.messages` to the newest MAX_MESSAGES entries — the oldest are
 * dropped, the turn counter keeps counting. No DB, no provider, no durable
 * lifecycle: this is the pure-kernel boundary only.
 */
import { describe, expect, test } from "bun:test";
import { CONVERSATION_RULES_SOURCE } from "@vibe-tavern/domain/builtins";
import {
	runCreate,
	runReduce,
	type ExperienceCapabilityContext,
} from "../src/domain/interactive/experience-kernel.js";

const NO_CAPS: ExperienceCapabilityContext = {};

/** Reply once and return the new state, asserting the transition is valid. */
function replyOnce(state: unknown, i: number): unknown {
	const reduced = runReduce(
		CONVERSATION_RULES_SOURCE,
		"conversation.js",
		state,
		{ type: "reply", requestId: `r${i}`, expectedRevision: i, payload: { text: `m${i}` } },
		NO_CAPS,
	);
	expect(reduced.ok).toBe(true);
	if (!reduced.ok) throw new Error("reduce failed");
	return reduced.value.state;
}

describe("Conversation builtin bounds message history", () => {
	test("under the bound nothing is trimmed and turn counts every reply", () => {
		const created = runCreate(CONVERSATION_RULES_SOURCE, "conversation.js", {}, NO_CAPS);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		let state = created.value;

		for (let i = 0; i < 5; i += 1) state = replyOnce(state, i);

		const s = state as { messages: unknown[]; turn: number };
		expect(s.messages).toHaveLength(5);
		expect(s.turn).toBe(5);
	});

	test("after 201 replies exactly the newest 200 are kept (oldest dropped)", () => {
		const created = runCreate(CONVERSATION_RULES_SOURCE, "conversation.js", {}, NO_CAPS);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		let state = created.value;

		for (let i = 0; i < 201; i += 1) state = replyOnce(state, i);

		const s = state as { messages: Array<{ from: string; text: string }>; turn: number };
		expect(s.messages).toHaveLength(200);
		expect(s.messages[0].text).toBe("m1"); // oldest (m0) was dropped
		expect(s.messages[s.messages.length - 1].text).toBe("m200");
		expect(s.turn).toBe(201); // turn counter unaffected by trimming
	});
});
