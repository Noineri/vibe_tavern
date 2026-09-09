/**
 * The LS-3 manual generation format end-to-end through the serialization seam
 * (LOCAL_SUPPORT_PLAN LS-3b): a preset's GenerationFormat (ST instruct DSL)
 * maps onto CompletionFormatTemplate (generationFormatToTemplate) and renders
 * through serializeCompletionPrompt — the SAME seam LS-2 shipped.
 *
 * Golden: a fixed ChatML-shaped manual template (captured from the owner's
 * real ST install, `instruct/ChatML.json`) over a fixed prompt produces the
 * expected flat string byte-for-byte. The executor-boundary variants (the
 * same string inside a recorded `/completions` request body, the auto /
 * /apply-template path) are pinned in `completion-mode-executor.test.ts`.
 */
import { describe, it, expect } from "bun:test";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { GenerationFormat } from "@vibe-tavern/domain";
import { generationFormatToTemplate, serializeCompletionPrompt } from "../src/domain/providers/completion-prompt.js";

// ChatML-shaped manual template (the owner's ST instruct/ChatML.json mapped
// through parseStInstruct): wrap + <|im_start|> markers + <|im_end|> suffixes.
const CHATML_FORMAT: GenerationFormat = {
	mode: "manual",
	inputSequence: "<|im_start|>user",
	outputSequence: "<|im_start|>assistant",
	firstOutputSequence: "",
	lastOutputSequence: "",
	systemSequence: "<|im_start|>system",
	systemSequencePrefix: "",
	systemSequenceSuffix: "",
	inputSuffix: "<|im_end|>\n",
	outputSuffix: "<|im_end|>\n",
	systemSuffix: "<|im_end|>\n",
	wrap: true,
	namesBehavior: "always",
};

const PROMPT: LanguageModelV4Prompt = [
	{ role: "system", content: "You are a storyteller." },
	{ role: "user", content: [{ type: "text", text: "Begin the tale." }] },
	{ role: "assistant", content: [{ type: "text", text: "Once upon a time" }] },
];

function user(text: string): LanguageModelV4Prompt[number] {
	return { role: "user", content: [{ type: "text", text }] };
}

describe("generationFormatToTemplate (LS-3b field mapping)", () => {
	it("maps the ST field names onto the seam's template shape", () => {
		const tpl = generationFormatToTemplate(CHATML_FORMAT);
		expect(tpl.systemPrefix).toBe("<|im_start|>system");
		expect(tpl.userPrefix).toBe("<|im_start|>user");
		expect(tpl.assistantPrefix).toBe("<|im_start|>assistant");
		expect(tpl.userSuffix).toBe("<|im_end|>\n");
		expect(tpl.assistantSuffix).toBe("<|im_end|>\n");
		expect(tpl.systemSuffix).toBe("<|im_end|>\n");
		expect(tpl.wrap).toBe(true);
	});

	it("absent ST fields fall back to empty prefixes / omitted extensions", () => {
		const tpl = generationFormatToTemplate({ mode: "manual" });
		expect(tpl.systemPrefix).toBe("");
		expect(tpl.userPrefix).toBe("");
		expect(tpl.assistantPrefix).toBe("");
		expect(tpl.userSuffix).toBeUndefined();
		expect(tpl.assistantSuffix).toBeUndefined();
		expect(tpl.wrap).toBeUndefined();
	});
});

describe("serializeCompletionPrompt — manual ChatML golden (LS-3b)", () => {
	it("renders the golden flat string for the fixed template", () => {
		const out = serializeCompletionPrompt(PROMPT, { template: generationFormatToTemplate(CHATML_FORMAT) });
		// Per-message: `<|im_start|>role\ncontent<|im_end|>\n`, concatenated; the
		// prompt ends on an assistant message → it IS the continuation point.
		expect(out).toBe(
			"<|im_start|>system\nYou are a storyteller.<|im_end|>\n" +
			"<|im_start|>user\nBegin the tale.<|im_end|>\n" +
			"<|im_start|>assistant\nOnce upon a time",
		);
	});

	it("a trailing user turn gets the trimmed assistant-prefix trailer (no suffix)", () => {
		const out = serializeCompletionPrompt(
			[...PROMPT.slice(0, 2)] as LanguageModelV4Prompt,
			{ template: generationFormatToTemplate(CHATML_FORMAT) },
		);
		expect(out).toBe(
			"<|im_start|>system\nYou are a storyteller.<|im_end|>\n" +
			"<|im_start|>user\nBegin the tale.<|im_end|>\n" +
			"<|im_start|>assistant",
		);
	});

	it("first/last output variants switch only the first/last assistant messages", () => {
		const tpl = generationFormatToTemplate({
			mode: "manual",
			inputSequence: "U: ",
			outputSequence: "A: ",
			firstOutputSequence: "A1: ",
			lastOutputSequence: "A2: ",
			inputSuffix: "\n",
			outputSuffix: "\n",
			wrap: false,
		});
		const out = serializeCompletionPrompt(
			[user("one"), { role: "assistant", content: [{ type: "text", text: "mid" }] }, user("two"), { role: "assistant", content: [{ type: "text", text: "last" }] }] as LanguageModelV4Prompt,
			{ template: tpl },
		);
		// No wrap: prefix + content + suffix concatenate directly. The LAST
		// assistant message is the continuation point — suffix dropped.
		expect(out).toBe("U: one\nA1: mid\nU: two\nA2: last");
	});

	it("system_sequence_prefix/suffix wrap the whole system line", () => {
		const tpl = generationFormatToTemplate({
			mode: "manual",
			inputSequence: "U:",
			outputSequence: "A:",
			systemSequence: "S:",
			systemSequencePrefix: "[",
			systemSequenceSuffix: "]",
			inputSuffix: "\n",
			outputSuffix: "\n",
		});
		const out = serializeCompletionPrompt(
			[{ role: "system", content: "rules" }, user("hi")] as LanguageModelV4Prompt,
			{ template: tpl },
		);
		// Ends on a user turn → the bare assistant prefix (trimmed) trailer.
		expect(out).toBe("[S:rules]U:hi\nA:");
	});

	it("a template with NO extensions renders byte-identically to the LS-2 minimal shape", () => {
		const minimal = serializeCompletionPrompt(PROMPT);
		const viaFormat = serializeCompletionPrompt(PROMPT, {
			template: generationFormatToTemplate({ mode: "manual", inputSequence: "User: ", outputSequence: "Assistant: ", systemSequence: "System: " }),
		});
		expect(viaFormat).toBe(minimal);
	});
});
