/**
 * ST format/library parsers (LOCAL_SUPPORT_PLAN LS-3e, storage map 2026-09-09):
 * instruct → manual generation format (near 1:1), context → partial canvas
 * order, sysprompt → main system field, plus shape-based kind detection for
 * the point-import file picker.
 *
 * Fixtures are EMBEDDED from the owner's real SillyTavern install
 * (N:/SillyTavern/data/default-user/ — read-only): ChatML instruct, Default
 * context, Blank sysprompt. Tests must not read outside the repo.
 */
import { describe, it, expect } from "bun:test";
import {
	detectStFileKind,
	parseStInstruct,
	parseStContext,
	parseStSysprompt,
} from "../src/presets/st-format.js";

// Verbatim capture from N:/SillyTavern/data/default-user/instruct/ChatML.json.
const CHATML_INSTRUCT = `{
    "input_sequence": "<|im_start|>user",
    "output_sequence": "<|im_start|>assistant",
    "last_output_sequence": "",
    "system_sequence": "<|im_start|>system",
    "stop_sequence": "<|im_end|>",
    "wrap": true,
    "macro": true,
    "names_behavior": "always",
    "activation_regex": "",
    "system_sequence_prefix": "",
    "system_sequence_suffix": "",
    "first_output_sequence": "",
    "skip_examples": false,
    "output_suffix": "<|im_end|>\\n",
    "input_suffix": "<|im_end|>\\n",
    "system_suffix": "<|im_end|>\\n",
    "user_alignment_message": "",
    "system_same_as_user": false,
    "last_system_sequence": "",
    "name": "ChatML"
}`;

// Verbatim capture from N:/SillyTavern/data/default-user/context/Default.json
// (story_string only — the fields the parser consumes).
const DEFAULT_CONTEXT = `{
    "story_string": "{{#if system}}{{system}}\\n{{/if}}{{#if wiBefore}}{{wiBefore}}\\n{{/if}}{{#if description}}{{description}}\\n{{/if}}{{#if personality}}{{char}}'s personality: {{personality}}\\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\\n{{/if}}{{#if wiAfter}}{{wiAfter}}\\n{{/if}}{{#if persona}}{{persona}}\\n{{/if}}",
    "example_separator": "***",
    "chat_start": "***",
    "use_stop_strings": false,
    "allow_jailbreak": false,
    "always_force_name2": true,
    "trim_sentences": false,
    "single_line": false,
    "name": "Default"
}`;

// Verbatim capture from N:/SillyTavern/data/default-user/sysprompt/Blank.json.
const BLANK_SYSPROMPT = `{
    "name": "Blank",
    "content": ""
}`;

describe("detectStFileKind (LS-3e point import)", () => {
	it("detects the four kinds by shape, VT export sentinel first", () => {
		expect(detectStFileKind(JSON.parse(CHATML_INSTRUCT))).toBe("instruct");
		expect(detectStFileKind(JSON.parse(DEFAULT_CONTEXT))).toBe("context");
		expect(detectStFileKind(JSON.parse(BLANK_SYSPROMPT))).toBe("sysprompt");
		expect(detectStFileKind(JSON.parse('{"prompts":[],"prompt_order":[]}'))).toBe("openai_preset");
		expect(detectStFileKind(JSON.parse('{"_vibe_tavern":{"name":"x"},"prompts":[]}'))).toBe("vt_export");
		expect(detectStFileKind({ random: "object" })).toBe("unknown");
		expect(detectStFileKind(null)).toBe("unknown");
		expect(detectStFileKind([1, 2])).toBe("unknown");
	});
});

describe("parseStInstruct (LS-3e storage map kind 3)", () => {
	it("maps the ChatML template near 1:1 and splits stop_sequence on newlines", () => {
		const parsed = parseStInstruct(CHATML_INSTRUCT);
		expect(parsed.name).toBe("ChatML");
		expect(parsed.format.mode).toBe("manual");
		expect(parsed.format.inputSequence).toBe("<|im_start|>user");
		expect(parsed.format.outputSequence).toBe("<|im_start|>assistant");
		expect(parsed.format.systemSequence).toBe("<|im_start|>system");
		expect(parsed.format.inputSuffix).toBe("<|im_end|>\n");
		expect(parsed.format.outputSuffix).toBe("<|im_end|>\n");
		expect(parsed.format.systemSuffix).toBe("<|im_end|>\n");
		expect(parsed.format.wrap).toBe(true);
		expect(parsed.format.namesBehavior).toBe("always");
		// Empty ST strings are preserved verbatim (round-trip fidelity) — they
		// render as no-ops: empty prefixes fall back to the base prefix, empty
		// suffixes default to the wrap newline.
		expect(parsed.format.firstOutputSequence).toBe("");
		expect(parsed.format.lastOutputSequence).toBe("");
		expect(parsed.format.systemSequencePrefix).toBe("");
		// stop_sequence → the provider's EXISTING stop-sequences setting,
		// never the format object (owner correction 2026-09-09).
		expect(parsed.stopSequences).toEqual(["<|im_end|>"]);
		expect(parsed.format).not.toHaveProperty("stopSequence");
	});

	it("splits a multi-line stop_sequence into individual stops", () => {
		const parsed = parseStInstruct(JSON.stringify({
			name: "multi",
			input_sequence: "U:",
			output_sequence: "A:",
			stop_sequence: "STOP1\n\nSTOP2\n  \nSTOP3",
		}));
		expect(parsed.stopSequences).toEqual(["STOP1", "STOP2", "STOP3"]);
	});

	it("maps numeric names_behavior ids (0=force, 1=always, 2=none) and unknowns to force", () => {
		const num = parseStInstruct(JSON.stringify({ input_sequence: "U", output_sequence: "A", names_behavior: 2 }));
		expect(num.format.namesBehavior).toBe("never");
		const unknown = parseStInstruct(JSON.stringify({ input_sequence: "U", output_sequence: "A", names_behavior: 42 }));
		expect(unknown.format.namesBehavior).toBe("force");
	});

	it("rejects non-instruct shapes", () => {
		expect(() => parseStInstruct(JSON.stringify({ name: "no sequences" }))).toThrow(/instruct/i);
		expect(() => parseStInstruct("not json")).toThrow();
		expect(() => parseStInstruct(JSON.stringify([1]))).toThrow();
	});
});

describe("parseStContext (LS-3e storage map kind 4 — PARTIAL)", () => {
	it("maps the Default story_string order onto canvas slots in order, chatHistory last", () => {
		const parsed = parseStContext(DEFAULT_CONTEXT);
		expect(parsed.name).toBe("Default");
		const ids = parsed.promptOrder.map((e) => e.identifier);
		// ST story_string order: system, wiBefore, description, personality,
		// scenario, wiAfter, persona — then chatHistory appended last.
		expect(ids).toEqual([
			"charSystemPrompt", "worldInfoBefore", "charDescription", "charPersonality",
			"scenario", "worldInfoAfter", "personaDescription", "chatHistory",
		]);
		// Dense orders within before_chat, chatHistory pinned last.
		expect(parsed.promptOrder.map((e) => e.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		for (const entry of parsed.promptOrder) {
			expect(entry.enabled).toBe(true);
			expect(entry.kind).toBe("built_in");
			expect(entry.zone).toBe("before_chat");
		}
		// The literal glue text ({{char}}'s personality: / Scenario: ) is
		// unrepresentable in VT's layer pipeline — reported, never silent.
		expect(parsed.notes[0]).toContain("literal_text");
	});

	it("rejects non-context shapes", () => {
		expect(() => parseStContext(JSON.stringify({ name: "no story" }))).toThrow(/context/i);
	});
});

describe("parseStSysprompt (LS-3e storage map kind 5)", () => {
	it("maps { name, content } onto the main system field", () => {
		const parsed = parseStSysprompt(BLANK_SYSPROMPT);
		expect(parsed.name).toBe("Blank");
		expect(parsed.content).toBe("");
		const named = parseStSysprompt(JSON.stringify({ name: "Roleplay", content: "Stay in character." }));
		expect(named.content).toBe("Stay in character.");
	});

	it("rejects entries without content", () => {
		expect(() => parseStSysprompt(JSON.stringify({ name: "no content" }))).toThrow(/content/i);
	});
});
