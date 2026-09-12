/**
 * The TC serialization seam (LOCAL_SUPPORT_PLAN LS-2c) — unit level.
 *
 * serializeCompletionPrompt turns the standardized (V4) model prompt into ONE
 * flat string for raw text completion. Executor-boundary parity (the same
 * string inside a recorded `/completion` request body) is pinned in
 * `completion-mode-executor.test.ts`; this file pins the serializer contract
 * itself: the stopgap template shape, the trailing-continuation rule, tool
 * skipping, and the custom-template seam LS-3 plugs into.
 */
import { describe, it, expect } from "bun:test";
import {
	serializeCompletionPrompt,
	DEFAULT_COMPLETION_TEMPLATE,
	templateStopMarkers,
	unionStopSequences,
} from "../src/domain/providers/completion-prompt.js";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";

function user(text: string): LanguageModelV4Prompt[number] {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): LanguageModelV4Prompt[number] {
	return { role: "assistant", content: [{ type: "text", text }] };
}

describe("serializeCompletionPrompt (LS-2c seam)", () => {
	it("renders role-prefixed lines and appends the bare Assistant: continuation when the prompt ends on a user turn", () => {
		const prompt: LanguageModelV4Prompt = [
			{ role: "system", content: "You are helpful." },
			user("Hello"),
			assistant("Hi there"),
			user("How are you?"),
		];
		expect(serializeCompletionPrompt(prompt)).toBe(
			"System: You are helpful.\nUser: Hello\nAssistant: Hi there\nUser: How are you?\nAssistant:",
		);
	});

	it("does NOT append the trailer when the last message is an assistant message — it IS the continuation point (e.g. a prefill)", () => {
		const prompt: LanguageModelV4Prompt = [
			{ role: "system", content: "S" },
			user("Hi"),
			assistant("*nods* "),
		];
		expect(serializeCompletionPrompt(prompt)).toBe("System: S\nUser: Hi\nAssistant: *nods* ");
	});

	it("joins multi-part text content verbatim and skips tool messages and non-text parts", () => {
		const prompt: LanguageModelV4Prompt = [
			user("part one"),
			{ role: "tool", content: [] },
			{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } as LanguageModelV4Prompt[number],
		];
		expect(serializeCompletionPrompt(prompt)).toBe("User: part one\nAssistant: ab");
	});

	it("an empty prompt still emits the continuation prefix", () => {
		expect(serializeCompletionPrompt([])).toBe("Assistant:");
	});

	it("accepts a custom template — LS-3's format tab plugs in here (template input, not hardcoded strings)", () => {
		const prompt: LanguageModelV4Prompt = [
			{ role: "system", content: "S" },
			user("U"),
		];
		const out = serializeCompletionPrompt(prompt, {
			template: {
				systemPrefix: "### System:\n",
				userPrefix: "### Instruction:\n",
				assistantPrefix: "### Response:\n",
				lineSeparator: "\n\n",
			},
		});
		expect(out).toBe("### System:\nS\n\n### Instruction:\nU\n\n### Response:");
	});

	it("default template keeps the Kobold-native shape (role labels + newline separator)", () => {
		expect(DEFAULT_COMPLETION_TEMPLATE.systemPrefix).toBe("System: ");
		expect(DEFAULT_COMPLETION_TEMPLATE.userPrefix).toBe("User: ");
		expect(DEFAULT_COMPLETION_TEMPLATE.assistantPrefix).toBe("Assistant: ");
		expect(DEFAULT_COMPLETION_TEMPLATE.lineSeparator).toBe("\n");
	});
});

describe("LS-9 implied stop markers", () => {
	it("the default template implies the three trimmed role markers", () => {
		expect(templateStopMarkers(DEFAULT_COMPLETION_TEMPLATE)).toEqual(["System:", "User:", "Assistant:"]);
	});

	it("extended templates dedupe repeated first/last assistant prefixes and drop empties", () => {
		const markers = templateStopMarkers({
			systemPrefix: "",
			userPrefix: "<u> ",
			assistantPrefix: "<a> ",
			firstAssistantPrefix: "<a> ",
			lastAssistantPrefix: "<a>",
			lineSeparator: "\n",
		});
		expect(markers).toEqual(["<u>", "<a>"]);
	});

	it("union keeps user stops first, appends implied deduped, and stays undefined when both sides are empty", () => {
		expect(unionStopSequences(["MINE", "User:"], ["User:", "System:", "Assistant:"])).toEqual([
			"MINE",
			"User:",
			"System:",
			"Assistant:",
		]);
		expect(unionStopSequences(undefined, [])).toBeUndefined();
		expect(unionStopSequences([], [])).toBeUndefined();
		expect(unionStopSequences(undefined, ["User:"])).toEqual(["User:"]);
	});
});
