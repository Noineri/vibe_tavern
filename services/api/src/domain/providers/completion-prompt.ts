/**
 * @module providers/completion-prompt
 *
 * The TC generation-mode serialization seam (LOCAL_SUPPORT_PLAN LS-2c): turns
 * the assembled prompt messages into ONE flat prompt string for a raw
 * text-completion request.
 *
 * WHY the string is built here and not by the SDK: verified against the
 * INSTALLED @ai-sdk/openai-compatible@3 / ai@7 — (a) `streamText`/`generateText`
 * with a plain `prompt` string wraps it as a single USER message, which the
 * completion model then re-renders through its built-in
 * `convertToOpenAICompatibleCompletionPrompt`; (b) that built-in conversion
 * hardcodes lowercase "user:"/"assistant:" labels, injects its own
 * `\nuser:` stop sequence, and THROWS on mid-conversation system messages and
 * tool parts — lossy for RP prompts, which routinely carry author's notes
 * (system) after the latest user message.
 *
 * So the completion model served for a `generationMode: "completion"` profile
 * is wrapped (see `completion-model.ts`) to serialize HERE, explicitly, and
 * splice the flat string into the outgoing request body via the provider
 * factory's documented `transformRequestBody` hook.
 *
 * Template input, not hardcoded strings (owner decision): LS-3's "Generation
 * format" tab becomes the real template source by passing a
 * {@link CompletionFormatTemplate} through this same seam.
 *
 * @module note: tool messages and non-text parts are SKIPPED — a raw
 * completion model has no tool-call channel (same choice as the KoboldCPP
 * native adapter's serializer, which this module mirrors in shape).
 */

import type {
	LanguageModelV4Prompt,
} from "@ai-sdk/provider";

/**
 * The completion-mode template: the glue that turns the assembled prompt
 * layers into ONE flat string. LS-2 ships the minimal role-prefixed stopgap;
 * LS-3 replaces the template SOURCE (ST-style sequences) without touching
 * this seam's shape.
 */
export interface CompletionFormatTemplate {
	/** Prefix for system messages (e.g. "System: "). */
	readonly systemPrefix: string;
	/** Prefix for user messages (e.g. "User: "). */
	readonly userPrefix: string;
	/** Prefix for assistant messages (e.g. "Assistant: "). */
	readonly assistantPrefix: string;
	/** Separator between message lines. */
	readonly lineSeparator: string;
}

/**
 * The stopgap default template — role-prefixed lines, mirroring the KoboldCPP
 * native adapter's serializer (`koboldcpp-adapter.ts` serializePrompt): same
 * labels, same newline separator, same trailing continuation prefix.
 */
export const DEFAULT_COMPLETION_TEMPLATE: CompletionFormatTemplate = {
	systemPrefix: "System: ",
	userPrefix: "User: ",
	assistantPrefix: "Assistant: ",
	lineSeparator: "\n",
} as const satisfies CompletionFormatTemplate;

/** Extract the concatenated text of a message's content parts. */
function textOf(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** Options for {@link serializeCompletionPrompt}. */
export interface SerializeCompletionOptions {
	/** Template source. Defaults to {@link DEFAULT_COMPLETION_TEMPLATE}; LS-3
	 *  replaces this with the preset's manual sequences. */
	template?: CompletionFormatTemplate;
}

/**
 * Serialize a standardized (V4) model prompt into ONE flat completion string.
 *
 * Trailing continuation: when the LAST message is an assistant message
 * (e.g. a prefill pushed by `prepareSdkMessages`, or a Continue-style
 * assistant continuation), its line IS the continuation point — no extra
 * trailer is appended. Otherwise a bare assistant prefix
 * (`assistantPrefix` trimmed of trailing whitespace: "Assistant: " →
 * "Assistant:") ends the string so the model continues the assistant turn.
 */
export function serializeCompletionPrompt(
	prompt: LanguageModelV4Prompt,
	options: SerializeCompletionOptions = {},
): string {
	const tpl = options.template ?? DEFAULT_COMPLETION_TEMPLATE;
	const lines: string[] = [];

	for (const message of prompt) {
		switch (message.role) {
			case "system":
				lines.push(`${tpl.systemPrefix}${message.content}`);
				break;
			case "user":
				lines.push(`${tpl.userPrefix}${textOf(message.content)}`);
				break;
			case "assistant":
				lines.push(`${tpl.assistantPrefix}${textOf(message.content)}`);
				break;
			case "tool":
				// No tool channel in raw completion — skipped (see module doc).
				break;
		}
	}

	const lastIsAssistant = prompt.length > 0 && prompt[prompt.length - 1]?.role === "assistant";
	if (!lastIsAssistant) {
		lines.push(tpl.assistantPrefix.trimEnd());
	}
	return lines.join(tpl.lineSeparator);
}
