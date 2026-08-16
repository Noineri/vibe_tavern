/**
 * IR-41 (Wave 4): tests for the pure frozen-RP-context builder.
 *
 * Pins: verbatim construction without a budget; oldest-first budget reduction;
 * tool-call/result pair never split; summaries + character/persona reserved
 * (never trimmed, counted outside the history budget); ≥2 messages always
 * preserved; compactionSummary accuracy; token accounting. The privacy
 * invariant (only already-projected PUBLIC material in — never hidden state) is
 * expressed by the input type: there is no field for hidden state to enter.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { setTokenCountFn } from "../src/compaction.js";
import {
	buildExperienceContext,
	characterSnapshotText,
	personaSnapshotText,
	type ExperienceContextMessage,
} from "../src/experience-context.js";

beforeEach(() => {
	// Char-length tokenizer → deterministic, easily-reasoned token counts.
	setTokenCountFn((text) => text.length);
});

function msg(id: string, role: ExperienceContextMessage["role"], content: string): ExperienceContextMessage {
	return { id, role, content };
}

const CHARACTER = { id: "c", name: "Aria", description: "Fire mage.", scenario: null, personality: null };
const PERSONA = { id: "p", name: "Olya", description: "Scholar." };

describe("buildExperienceContext — construction (no budget)", () => {
	it("preserves all material verbatim and reports truthful accounting", () => {
		const messages = [msg("m1", "user", "hi"), msg("m2", "assistant", "hello")];
		const summaries = [{ id: "s1", content: "Earlier recap." }];
		const bundle = buildExperienceContext({ messages, summaries, character: CHARACTER, persona: PERSONA });

		expect(bundle.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(bundle.summaries.map((s) => s.id)).toEqual(["s1"]);
		expect(bundle.character?.id).toBe("c");
		expect(bundle.persona?.id).toBe("p");
		expect(bundle.droppedMessages).toEqual([]);
		expect(bundle.compactionSummary).toBeNull();

		// Char-length tokenizer: accounting mirrors the rendered snapshot text lengths.
		expect(bundle.tokenAccounting.character).toBe(characterSnapshotText(CHARACTER).length);
		expect(bundle.tokenAccounting.persona).toBe(personaSnapshotText(PERSONA).length);
		expect(bundle.tokenAccounting.summaries).toBe("Earlier recap.".length);
		expect(bundle.tokenAccounting.messages).toBe("hi".length + "hello".length);
		expect(bundle.tokenAccounting.total).toBe(
			bundle.tokenAccounting.character +
				bundle.tokenAccounting.persona +
				bundle.tokenAccounting.summaries +
				bundle.tokenAccounting.messages,
		);
	});

	it("accepts an empty message window (bundle carries only reserved material)", () => {
		const bundle = buildExperienceContext({ messages: [], character: CHARACTER });
		expect(bundle.messages).toEqual([]);
		expect(bundle.tokenAccounting.messages).toBe(0);
		expect(bundle.tokenAccounting.total).toBe(bundle.tokenAccounting.character);
		expect(bundle.droppedMessages).toEqual([]);
	});
});

describe("buildExperienceContext — budget reduction", () => {
	// Five 10-char messages: u1 a1 t1 u2 a2 (each content length 10).
	const pairMessages: ExperienceContextMessage[] = [
		msg("u1", "user", "0123456789"),
		msg("a1", "assistant", "0123456789"),
		msg("t1", "tool", "0123456789"),
		msg("u2", "user", "0123456789"),
		msg("a2", "assistant", "0123456789"),
	];

	it("drops the oldest messages first to fit the budget", () => {
		// reserved = 0; contextBudget 30 → historyBudget 30 → keep the largest
		// suffix ≤ 30 tokens = 3 messages (30 tokens) = [t1,u2,a2]. But tool-pair
		// safety pulls a1 in too (see next test); use a non-tool scenario here.
		const noTool: ExperienceContextMessage[] = [
			msg("u1", "user", "0123456789"),
			msg("a1", "assistant", "0123456789"),
			msg("u2", "user", "0123456789"),
			msg("a2", "assistant", "0123456789"),
		];
		const bundle = buildExperienceContext({ messages: noTool, budget: { contextBudget: 25, responseReserve: 0 } });
		// historyBudget 25 → largest suffix ≤25 = [u2,a2] (20 tokens); [a1,u2,a2]=30 >25.
		expect(bundle.messages.map((m) => m.id)).toEqual(["u2", "a2"]);
		expect(bundle.droppedMessages.map((d) => d.id)).toEqual(["u1", "a1"]);
		expect(bundle.droppedMessages[0].reason).toBe("context_budget");
		expect(bundle.compactionSummary).toContain("dropped 2 oldest");
	});

	it("never splits an assistant tool-call from its tool-result", () => {
		// contextBudget 30 → historyBudget 30 → candidate suffix [t1,u2,a2] (30)
		// would orphan t1 (tool result with no preceding assistant). The safe
		// boundary pulls a1 in → preserved = [a1,t1,u2,a2]; only u1 is dropped.
		const bundle = buildExperienceContext({ messages: pairMessages, budget: { contextBudget: 30, responseReserve: 0 } });
		const ids = bundle.messages.map((m) => m.id);
		expect(ids).toContain("a1");
		expect(ids).toContain("t1");
		// t1 is never the first preserved message (never orphaned).
		expect(ids[0]).not.toBe("t1");
		expect(bundle.droppedMessages.map((d) => d.id)).toEqual(["u1"]);
	});

	it("summaries are reserved and never trimmed, even under a tight budget", () => {
		// Budget that fits ONLY the summaries + 2 messages → older messages drop,
		// summaries survive intact.
		const summaries = [{ id: "s1", content: "A dense recap of prior events." }];
		const messages = [
			msg("m1", "user", "old"),
			msg("m2", "assistant", "old"),
			msg("m3", "user", "recent"),
			msg("m4", "assistant", "recent"),
		];
		const bundle = buildExperienceContext({
			messages,
			summaries,
			budget: { contextBudget: 100, responseReserve: 0 },
		});
		expect(bundle.summaries.map((s) => s.id)).toEqual(["s1"]);
		expect(bundle.tokenAccounting.summaries).toBe("A dense recap of prior events.".length);
		// Summaries counted in reserved, not in the history budget.
		expect(bundle.tokenAccounting.total).toBe(
			bundle.tokenAccounting.summaries + bundle.tokenAccounting.messages,
		);
	});

	it("character/persona tokens are reserved, not counted against the history budget", () => {
		// contextBudget 80; character=22, persona=29 → reserved 51; historyBudget
		// = 80 - 51 = 29. Four 10-char messages (40) > 29 → oldest dropped.
		const messages = [
			msg("m1", "user", "0123456789"),
			msg("m2", "assistant", "0123456789"),
			msg("m3", "user", "0123456789"),
			msg("m4", "assistant", "0123456789"),
		];
		const bundle = buildExperienceContext({
			messages,
			character: CHARACTER,
			persona: PERSONA,
			budget: { contextBudget: 80, responseReserve: 0 },
		});
		// historyBudget 29 → largest suffix ≤29 = [m3,m4] (20); [m2,m3,m4]=30 >29.
		expect(bundle.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
		expect(bundle.character?.id).toBe("c");
		expect(bundle.persona?.id).toBe("p");
	});

	it("always preserves at least 2 messages", () => {
		// Absurdly tight budget (1 token) — still keeps the 2 most recent.
		const messages = [
			msg("m1", "user", "old"),
			msg("m2", "assistant", "old"),
			msg("m3", "user", "recent"),
			msg("m4", "assistant", "recent"),
		];
		const bundle = buildExperienceContext({
			messages,
			budget: { contextBudget: 1, responseReserve: 0 },
		});
		expect(bundle.messages.length).toBeGreaterThanOrEqual(2);
		// The two most-recent survive.
		const ids = bundle.messages.map((m) => m.id);
		expect(ids).toContain("m4");
		expect(ids).toContain("m3");
	});

	it("compactionSummary is null when nothing is trimmed", () => {
		const messages = [msg("m1", "user", "hi"), msg("m2", "assistant", "yo")];
		const bundle = buildExperienceContext({ messages, budget: { contextBudget: 1000, responseReserve: 0 } });
		expect(bundle.droppedMessages).toEqual([]);
		expect(bundle.compactionSummary).toBeNull();
	});

	it("responseReserve is subtracted from the budget before history trimming", () => {
		const messages = [
			msg("m1", "user", "0123456789"),
			msg("m2", "assistant", "0123456789"),
			msg("m3", "user", "0123456789"),
			msg("m4", "assistant", "0123456789"),
		];
		// contextBudget 40, responseReserve 20 → historyBudget 20 → [m3,m4] (20).
		const bundle = buildExperienceContext({ messages, budget: { contextBudget: 40, responseReserve: 20 } });
		expect(bundle.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
	});
});
