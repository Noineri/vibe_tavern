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

import type { GenerationFormat } from "@vibe-tavern/domain";

/**
 * Structural prompt-message shape satisfied by BOTH `LanguageModelV3Prompt`
 * and `LanguageModelV4Prompt` (LS-6b): the ONE serializer serves the
 * openai-compat completion seam AND the KoboldCPP native adapter. Tool
 * messages and non-text parts are skipped (no tool channel in raw completion
 * — same choice as before the structural widening).
 */
export interface CompletionPromptMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * The completion-mode template: the glue that turns the assembled prompt
 * layers into ONE flat string. LS-2 shipped the minimal role-prefixed stopgap;
 * LS-3 widens the shape toward the ST instruct DSL (suffixes, first/last
 * output variants, system wraps, the wrap flag) so a preset's manual
 * sequences render through this SAME seam. All LS-3 additions are OPTIONAL
 * and default to the LS-2 behavior byte-for-byte (its tests pin that).
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
	/** Suffix appended after user message content (ST `input_suffix`). */
	readonly userSuffix?: string;
	/** Suffix appended after assistant message content (ST `output_suffix`). */
	readonly assistantSuffix?: string;
	/** Suffix appended after system message content (ST `system_suffix`). */
	readonly systemSuffix?: string;
	/** Prefix override for the FIRST assistant message (ST `first_output_sequence`). */
	readonly firstAssistantPrefix?: string;
	/** Prefix override for the LAST assistant message (ST `last_output_sequence`). */
	readonly lastAssistantPrefix?: string;
	/** Extra prefix wrapped around the system message line (ST `system_sequence_prefix`). */
	readonly systemSequencePrefix?: string;
	/** Extra suffix wrapped around the system message line (ST `system_sequence_suffix`). */
	readonly systemSequenceSuffix?: string;
	/** ST `wrap`: separate the sequence and the content with "\n", and default
	 *  a missing message suffix to "\n" (ST formatInstructModeChat semantics). */
	readonly wrap?: boolean;
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
function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
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
 * Message rendering (LS-3 manual templates): when the template carries the
 * ST-instruct extensions (suffixes / wrap / first/last output variants), each
 * message renders through the ST `formatInstructModeChat` semantics —
 * `[prefix, content + suffix].filter(Boolean).join(wrap ? "\n" : "")` with a
 * missing suffix defaulting to "\n" under wrap. The minimal LS-2 template
 * (no extensions) renders exactly as before: `prefix + content`, lines joined
 * with `lineSeparator`.
 *
 * Trailing continuation: when the LAST message is an assistant message
 * (e.g. a prefill pushed by `prepareSdkMessages`, or a Continue-style
 * assistant continuation), its line IS the continuation point — no extra
 * trailer is appended, and on the extended (ST-instruct) path its assistant
 * SUFFIX is dropped too: a continuation terminated by `<|im_end|>` would end
 * the turn before the model writes anything (the live /apply-template capture
 * renders the trailing assistant without its stop marker — same semantics).
 * Otherwise a bare assistant prefix (the position-aware pick below, trimmed
 * of trailing whitespace: "Assistant: " → "Assistant:") ends the string so
 * the model continues the assistant turn.
 */
export function serializeCompletionPrompt(
	prompt: ReadonlyArray<CompletionPromptMessage>,
	options: SerializeCompletionOptions = {},
): string {
	const tpl = options.template ?? DEFAULT_COMPLETION_TEMPLATE;
	const hasExtensions =
		tpl.wrap !== undefined ||
		tpl.userSuffix !== undefined ||
		tpl.assistantSuffix !== undefined ||
		tpl.systemSuffix !== undefined ||
		tpl.firstAssistantPrefix !== undefined ||
		tpl.lastAssistantPrefix !== undefined ||
		tpl.systemSequencePrefix !== undefined ||
		tpl.systemSequenceSuffix !== undefined;
	const lines: string[] = [];

	// Position-aware assistant prefix pick: first/last output variants
	// (ST first_output_sequence / last_output_sequence). Only the FIRST and
	// LAST assistant messages switch; middle messages keep the base prefix.
	const firstAssistantIndex = prompt.findIndex((m) => m.role === "assistant");
	const lastAssistantIndex = findLastIndex(prompt, (m) => m.role === "assistant");

	const assistantPrefixAt = (index: number): string => {
		if (index === firstAssistantIndex && tpl.firstAssistantPrefix) return tpl.firstAssistantPrefix;
		if (index === lastAssistantIndex && tpl.lastAssistantPrefix) return tpl.lastAssistantPrefix;
		return tpl.assistantPrefix;
	};

	for (let index = 0; index < prompt.length; index++) {
		const message = prompt[index]!;
		// The final assistant message IS the continuation point: its suffix is
		// dropped so the model continues the turn instead of the stop marker
		// ending it (see the module doc — live /apply-template parity).
		const isContinuation = index === prompt.length - 1 && message.role === "assistant";
		switch (message.role) {
			case "system": {
				const line = renderMessage(
					tpl.systemPrefix,
					textOf(message.content),
					suffixFor(tpl, "system"),
					tpl.wrap === true,
				);
				// ST system_sequence_prefix/suffix wrap the whole system line.
				lines.push(`${tpl.systemSequencePrefix ?? ""}${line}${tpl.systemSequenceSuffix ?? ""}`);
				break;
			}
			case "user":
				lines.push(renderMessage(tpl.userPrefix, textOf(message.content), suffixFor(tpl, "user"), tpl.wrap === true));
				break;
			case "assistant":
				lines.push(renderMessage(assistantPrefixAt(index), textOf(message.content), suffixFor(tpl, "assistant"), tpl.wrap === true, isContinuation));
				break;
			case "tool":
				// No tool channel in raw completion — skipped (see module doc).
				break;
		}
	}

	if (!hasExtensions) {
		// Minimal (LS-2) shape: separator-joined role-prefixed lines.
		const lastIsAssistant = prompt.length > 0 && prompt[prompt.length - 1]?.role === "assistant";
		if (!lastIsAssistant) {
			lines.push(tpl.assistantPrefix.trimEnd());
		}
		return lines.join(tpl.lineSeparator);
	}

	// Extended (ST-instruct) shape: messages CONCATENATE (the per-message
	// suffixes carry the newlines). The trailer is the assistant prefix for the
	// UPCOMING assistant turn — ST's formatInstructModePrompt picks
	// last_output_sequence || output_sequence — trimmed, no suffix (the model
	// continues the assistant turn from there).
	const lastIsAssistant = prompt.length > 0 && prompt[prompt.length - 1]?.role === "assistant";
	if (!lastIsAssistant) {
		lines.push((tpl.lastAssistantPrefix || tpl.assistantPrefix).trimEnd());
	}
	return lines.join("");
}

/** Find the last index matching a predicate (Array.prototype.findLastIndex is
 *  ES2023; kept explicit so the target stays conservative). */
function findLastIndex(prompt: ReadonlyArray<CompletionPromptMessage>, predicate: (m: CompletionPromptMessage) => boolean): number {
	for (let i = prompt.length - 1; i >= 0; i--) {
		if (predicate(prompt[i]!)) return i;
	}
	return -1;
}

/** Role suffix from the template (undefined when absent). */
function suffixFor(tpl: CompletionFormatTemplate, role: "system" | "user" | "assistant"): string | undefined {
	if (role === "system") return tpl.systemSuffix;
	if (role === "user") return tpl.userSuffix;
	return tpl.assistantSuffix;
}

/** Render ONE message per the ST `formatInstructModeChat` semantics:
 *  `[prefix, content + suffix].filter(Boolean).join(wrap ? "\n" : "")`, with a
 *  missing suffix defaulting to "\n" under wrap. Without wrap (the minimal
 *  LS-2 shape) this collapses to `prefix + content` — byte-identical.
 *  `skipSuffix` drops the suffix entirely (the continuation point — the
 *  default "\n" under wrap is dropped with it). */
function renderMessage(prefix: string, content: string, suffix: string | undefined, wrap: boolean, skipSuffix = false): string {
	let effectiveSuffix = skipSuffix ? "" : (suffix ?? "");
	if (wrap && !skipSuffix && !effectiveSuffix) effectiveSuffix = "\n";
	const separator = wrap ? "\n" : "";
	const body = content + effectiveSuffix;
	return prefix && body ? prefix + separator + body : prefix + body;
}

/**
 * Map a preset's GenerationFormat (LS-3a — the ST instruct DSL near 1:1) onto
 * the seam's {@link CompletionFormatTemplate}. Field-name translation only:
 * `inputSequence` → `userPrefix`, `outputSequence` → `assistantPrefix`,
 * `systemSequence` → `systemPrefix`, suffixes/first-last variants/wrap pass
 * through with their ST meaning. Absent ST fields become "" prefixes (ST
 * renders an empty sequence as no prefix); absent extension fields stay
 * `undefined` so the seam keeps its minimal-path behavior where the template
 * carries none.
 */
export function generationFormatToTemplate(format: GenerationFormat): CompletionFormatTemplate {
	return {
		// The LS-2 default separator — consulted only on the minimal path (a
		// format with no ST extensions); the extended path concatenates and the
		// per-message suffixes carry the newlines.
		lineSeparator: "\n",
		systemPrefix: format.systemSequence ?? "",
		userPrefix: format.inputSequence ?? "",
		assistantPrefix: format.outputSequence ?? "",
		...(format.inputSuffix !== undefined ? { userSuffix: format.inputSuffix } : {}),
		...(format.outputSuffix !== undefined ? { assistantSuffix: format.outputSuffix } : {}),
		...(format.systemSuffix !== undefined ? { systemSuffix: format.systemSuffix } : {}),
		...(format.firstOutputSequence !== undefined ? { firstAssistantPrefix: format.firstOutputSequence } : {}),
		...(format.lastOutputSequence !== undefined ? { lastAssistantPrefix: format.lastOutputSequence } : {}),
		...(format.systemSequencePrefix !== undefined ? { systemSequencePrefix: format.systemSequencePrefix } : {}),
		...(format.systemSequenceSuffix !== undefined ? { systemSequenceSuffix: format.systemSequenceSuffix } : {}),
		...(format.wrap !== undefined ? { wrap: format.wrap } : {}),
	};
}
