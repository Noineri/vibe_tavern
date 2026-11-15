/**
 * IR-41 (Wave 4): tests for the pure fixed-order experience model-prompt builder.
 *
 * Pins: the fixed layer order (host protocol → package → global override →
 * character override → character/persona → context summary/history → private
 * history → private view); empty optional blocks omitted; the private view is
 * the FINAL user message (model-view isolation — it is the only hidden material
 * the seat sees, placed after the shared public context); valid
 * AssemblePromptResponse shape (empty scriptInjections/retrievedMemories/
 * activatedLoreEntries, null prefill); tokenAccounting mirrors layers;
 * finalPayload.messages executor-compatible (string role + string content); and
 * the authoritative final trim drops additional history once framing/private view
 * are added.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setTokenCountFn } from "../src/compaction.js";
import { buildExperienceContext, type ExperienceContextMessage } from "../src/experience-context.js";
import { buildExperienceModelPrompt } from "../src/experience-model-prompt.js";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";

beforeEach(() => {
	setTokenCountFn((text) => text.length);
});

afterAll(() => {
	setTokenCountFn(() => 0);
});

function msg(id: string, role: ExperienceContextMessage["role"], content: string): ExperienceContextMessage {
	return { id, role, content };
}

const CHARACTER = { id: "c", name: "Aria", description: "Fire mage.", scenario: null, personality: null };
const PERSONA = { id: "p", name: "Olya", description: "Scholar." };

function bundle(messages: ExperienceContextMessage[] = [], opts: { summaries?: string[]; character?: typeof CHARACTER | null; persona?: typeof PERSONA | null } = {}) {
	return buildExperienceContext({
		messages,
		summaries: opts.summaries?.map((c, i) => ({ id: `s${i}`, content: c })),
		character: opts.character === undefined ? CHARACTER : opts.character,
		persona: opts.persona === undefined ? PERSONA : opts.persona,
	});
}

function ids(layers: AssemblePromptResponse["layers"]): string[] {
	return layers.map((l) => l.id);
}

describe("buildExperienceModelPrompt — fixed layer order", () => {
	it("emits every block in the documented fixed order when all are present", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "You choose a legal action.",
			packagePrompt: "Package instructions.",
			globalOverride: "Global tweak.",
			characterOverride: "Character tweak.",
			context: bundle([msg("m1", "user", "hi")], { summaries: ["Recap."] }),
			privateHistory: [msg("ph1", "assistant", "my prior move")],
			privateView: "Legal actions: [rock, paper, scissors].",
		});
		expect(ids(result.layers)).toEqual([
			"xp_host_protocol",
			"xp_package_prompt",
			"xp_global_override",
			"xp_character_override",
			"xp_character",
			"xp_persona",
			"xp_context_summary",
			"xp_context_history",
			"xp_private_history",
			"xp_private_view",
		]);
	});

	it("omits empty optional blocks (no package/overrides/private)", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([msg("m1", "user", "hi")]),
		});
		expect(ids(result.layers)).toEqual(["xp_host_protocol", "xp_character", "xp_persona", "xp_context_history"]);
	});

	it("drops the context-summary layer when there are no summaries", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([msg("m1", "user", "hi")], { summaries: [] }),
		});
		expect(ids(result.layers)).not.toContain("xp_context_summary");
	});
});

describe("buildExperienceModelPrompt — privacy / model-view isolation", () => {
	it("the private view is the FINAL user message the model answers", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([msg("m1", "user", "public hi"), msg("m2", "assistant", "public hello")]),
			privateView: "Your legal actions: [rock, paper].",
		});
		const messages = result.finalPayload.messages as Array<{ role: string; content: string }>;
		const last = messages[messages.length - 1];
		expect(last.role).toBe("user");
		expect(last.content).toBe("Your legal actions: [rock, paper].");
	});

	it("places shared public context BEFORE the private view (isolation ordering)", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([msg("m1", "user", "PUBLIC RP LINE")], { summaries: ["PUBLIC RECAP"] }),
			privateView: "PRIVATE VIEW",
		});
		const text = JSON.stringify(result.finalPayload.messages);
		expect(text).toContain("PUBLIC RECAP");
		expect(text).toContain("PUBLIC RP LINE");
		expect(text).toContain("PRIVATE VIEW");
		const recapIdx = text.indexOf("PUBLIC RECAP");
		const rpIdx = text.indexOf("PUBLIC RP LINE");
		const privateIdx = text.indexOf("PRIVATE VIEW");
		expect(recapIdx).toBeGreaterThanOrEqual(0);
		expect(recapIdx).toBeLessThan(rpIdx);
		expect(rpIdx).toBeLessThan(privateIdx);
	});
});

describe("buildExperienceModelPrompt — output shape", () => {
	it("produces a valid AssemblePromptResponse with empty script/lore/memory buckets", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([msg("m1", "user", "hi")]),
		});
		expect(Object.keys(result).sort()).toEqual([
			"activatedLoreEntries",
			"compactionSummary",
			"finalPayload",
			"layers",
			"prefill",
			"retrievedMemories",
			"scriptInjections",
			"tokenAccounting",
		]);
		expect(result.layers.map((l) => l.id)).toEqual([
			"xp_host_protocol",
			"xp_character",
			"xp_persona",
			"xp_context_history",
		]);
		expect(
			result.layers.every(
				(l) => typeof l.text === "string" && typeof l.tokenCount === "number" && l.enabled === true,
			),
		).toBe(true);
		expect(result.scriptInjections).toEqual([]);
		expect(result.retrievedMemories).toEqual([]);
		expect(result.activatedLoreEntries).toEqual([]);
		expect(result.prefill).toBeNull();
		expect(result.compactionSummary).toBeNull();
		expect(Array.isArray(result.finalPayload.messages)).toBe(true);
		expect(result.finalPayload.messages).toHaveLength(4);
		expect(result.tokenAccounting).toEqual({
			xp_host_protocol: "Protocol.".length,
			xp_character: result.layers[1]!.tokenCount,
			xp_persona: result.layers[2]!.tokenCount,
			xp_context_history: result.layers[3]!.tokenCount,
		});
	});

	it("tokenAccounting mirrors every emitted layer with a matching count", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([msg("m1", "user", "hi")], { summaries: ["Recap."] }),
			privateView: "Choose.",
		});
		for (const layer of result.layers) {
			expect(result.tokenAccounting[layer.id]).toBe(layer.tokenCount);
		}
		expect(Object.keys(result.tokenAccounting).length).toBe(result.layers.length);
	});

	it("finalPayload.messages are executor-compatible (string role + string content)", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([msg("m1", "user", "hi"), msg("m2", "assistant", "hello")]),
			privateView: "Act.",
		});
		const messages = result.finalPayload.messages as Array<{ role: unknown; content: unknown }>;
		for (const m of messages) {
			expect(typeof m.role).toBe("string");
			expect(["system", "user", "assistant", "tool"]).toContain(m.role);
			// Non-tool roles carry string content (the executor's contract).
			if (m.role !== "tool") expect(typeof m.content).toBe("string");
		}
	});

	it("a minimal prompt (only host protocol + empty context) preserves the complete response shape", () => {
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle([], { character: null, persona: null }),
		});
		expect(result.layers.map((l) => l.id)).toEqual(["xp_host_protocol", "xp_context_history"]);
		expect(result.finalPayload.messages).toEqual([{ role: "system", content: "Protocol." }]);
		expect(result.tokenAccounting).toEqual({
			xp_host_protocol: "Protocol.".length,
			xp_context_history: 0,
		});
		expect(result.scriptInjections).toEqual([]);
		expect(result.retrievedMemories).toEqual([]);
		expect(result.activatedLoreEntries).toEqual([]);
		expect(result.prefill).toBeNull();
		expect(result.compactionSummary).toBeNull();
	});
});

describe("buildExperienceModelPrompt — authoritative final trim", () => {
	it("drops additional oldest history when framing + private view push over budget", () => {
		// Bundle has 4 distinct messages (each 10 chars). No bundle budget → all 4 carried.
		// Model-prompt budget: framing "Protocol." (9) + private view "Act." (4)
		// = reserved 13; contextBudget 40 → historyBudget 27 → largest suffix
		// ≤27 = 2 messages (20). The 2 oldest drop HERE (the bundle did not trim).
		const messages = [
			msg("m1", "user", "msg-1-old!"),
			msg("m2", "assistant", "msg-2-old!"),
			msg("m3", "user", "msg-3-new!"),
			msg("m4", "assistant", "msg-4-new!"),
		];
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: bundle(messages, { character: null, persona: null }),
			privateView: "Act.",
			budget: { contextBudget: 40, responseReserve: 0 },
		});
		const historyLayer = result.layers.find((l) => l.id === "xp_context_history");
		expect(historyLayer?.text).toContain("msg-3-new!");
		expect(historyLayer?.text).toContain("msg-4-new!");
		expect(historyLayer?.text).not.toContain("msg-1-old!");
		expect(historyLayer?.text).not.toContain("msg-2-old!");
		// finalPayload: framing system + m3(user) + m4(assistant) + private-view user.
		expect(result.finalPayload.messages).toEqual([
			{ role: "system", content: "Protocol." },
			{ role: "user", content: "msg-3-new!" },
			{ role: "assistant", content: "msg-4-new!" },
			{ role: "user", content: "Act." },
		]);
		expect(result.compactionSummary).toContain("dropped 2 additional oldest");
	});

	it("carries the bundle's compactionSummary when no further trim is needed", () => {
		// Bundle trims 2 messages; model-prompt budget is generous → no extra trim,
		// so the bundle's compactionSummary surfaces unchanged.
		const trimmed = buildExperienceContext({
			messages: [
				msg("m1", "user", "0123456789"),
				msg("m2", "assistant", "0123456789"),
				msg("m3", "user", "0123456789"),
				msg("m4", "assistant", "0123456789"),
			],
			budget: { contextBudget: 25, responseReserve: 0 },
		});
		expect(trimmed.compactionSummary).not.toBeNull();
		const result = buildExperienceModelPrompt({
			hostProtocol: "Protocol.",
			context: trimmed,
		});
		expect(result.compactionSummary).toBe(trimmed.compactionSummary);
	});

	it("never splits an assistant/tool role pair during the final trim", () => {
		// a1+t1 pair; tight model-prompt budget → t1 must not be orphaned.
		// framing "P." (2) reserved; contextBudget 32 → historyBudget 30 → suffix
		// [t1,u2,a2] (30) would orphan t1, so the safe boundary pulls a1 in →
		// preserved = [a1,t1,u2,a2]; u1 dropped.
		const messages = [
			msg("u1", "user", "u1-oldest!"),
			msg("a1", "assistant", "a1-tcall!!"),
			msg("t1", "tool", "t1-result!"),
			msg("u2", "user", "u2-recent!"),
			msg("a2", "assistant", "a2-recent!"),
		];
		const result = buildExperienceModelPrompt({
			hostProtocol: "P.",
			context: bundle(messages, { character: null, persona: null }),
			budget: { contextBudget: 32, responseReserve: 0 },
		});
		// framing system + a1 + t1 + u2 + a2 (u1 dropped). No private view here.
		expect(result.finalPayload.messages).toEqual([
			{ role: "system", content: "P." },
			{ role: "assistant", content: "a1-tcall!!" },
			{ role: "tool", content: "t1-result!" },
			{ role: "user", content: "u2-recent!" },
			{ role: "assistant", content: "a2-recent!" },
		]);
	});
});
