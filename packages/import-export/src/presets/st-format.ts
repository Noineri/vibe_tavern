/**
 * @module presets/st-format
 *
 * SillyTavern storage-map parsers for the three format/library file kinds
 * (LOCAL_SUPPORT_PLAN LS-3e, storage map 2026-09-09):
 * - `instruct/*.json`  → manual generation-format sequences (near 1:1);
 *   `stop_sequence` is returned SEPARATELY so it can land in the provider's
 *   EXISTING stop-sequences setting (owner correction — no duplicate control).
 * - `context/*.json`   → PARTIAL canvas mapping (built-in layer order from the
 *   Handlebars `story_string`); unrepresentable fragments are skipped WITH an
 *   import note.
 * - `sysprompt/*.json` → `{ name, content }` library entry → main system field.
 *
 * Plus shape-based kind detection for point import (one file picker, four
 * kinds — folder knowledge is only available to the mass scanner).
 */

import type { GenerationFormat, PromptOrderEntry } from "@vibe-tavern/domain";

// ─── Kind detection ─────────────────────────────────────────────────────────

/** The ST file kinds this module can map, discriminated by shape. */
export type StFileKind = "openai_preset" | "instruct" | "context" | "sysprompt" | "vt_export" | "unknown";

/**
 * Detect the ST/VT kind of a parsed JSON object by its SHAPE (no folder
 * knowledge). Order matters: a VT export also carries `prompts[]`, so the
 * `_vibe_tavern` sentinel is checked first; instruct/context/sysprompt shapes
 * are disjoint from the OpenAI preset shape.
 */
export function detectStFileKind(parsed: unknown): StFileKind {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
	const obj = parsed as Record<string, unknown>;
	if (obj._vibe_tavern !== undefined) return "vt_export";
	if (Array.isArray(obj.prompts)) return "openai_preset";
	if (typeof obj.input_sequence === "string" || typeof obj.output_sequence === "string") return "instruct";
	if (typeof obj.story_string === "string") return "context";
	if (typeof obj.name === "string" && typeof obj.content === "string") return "sysprompt";
	return "unknown";
}

// ─── Instruct → GenerationFormat ────────────────────────────────────────────

/** Raw ST instruct JSON — the fields the VT mapping consumes. The storage map
 *  pins the near-1:1 set; unknown extra fields (activation_regex,
 *  user_alignment_message, skip_examples, …) are VT-irrelevant and ignored. */
interface StInstructJson {
	name?: unknown;
	input_sequence?: unknown;
	output_sequence?: unknown;
	first_output_sequence?: unknown;
	last_output_sequence?: unknown;
	system_sequence?: unknown;
	system_sequence_prefix?: unknown;
	system_sequence_suffix?: unknown;
	input_suffix?: unknown;
	output_suffix?: unknown;
	system_suffix?: unknown;
	wrap?: unknown;
	names_behavior?: unknown;
	stop_sequence?: unknown;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Map ST's `names_behavior` value onto the VT enum; unknown values → the ST
 *  default (`force`), matching instruct-mode.js's default. */
function mapNamesBehavior(value: unknown): GenerationFormat["namesBehavior"] {
	if (value === "always" || value === "never" || value === "force") return value;
	if (typeof value === "number") {
		// Older ST stored numeric ids: 0 = force, 1 = always, 2 = none.
		if (value === 0) return "force";
		if (value === 1) return "always";
		if (value === 2) return "never";
	}
	return "force";
}

export interface ParsedStInstruct {
	name: string;
	/** Manual generation format (`mode: "manual"`) ready to store on a preset. */
	format: GenerationFormat;
	/** ST `stop_sequence` split into individual stops (ST splits on newlines —
	 *  instruct-mode.js getInstructStoppingSequences). Land these in the
	 *  provider's EXISTING stop-sequences setting, never in the format. */
	stopSequences: string[];
}

/**
 * Parse an ST instruct template into VT's manual generation format.
 * Throws when the shape is not an instruct template (no sequences at all).
 */
export function parseStInstruct(jsonText: string): ParsedStInstruct {
	const parsed: unknown = JSON.parse(jsonText);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Instruct template must be a JSON object.");
	}
	const raw = parsed as StInstructJson;
	const hasSequence =
		typeof raw.input_sequence === "string" ||
		typeof raw.output_sequence === "string" ||
		typeof raw.system_sequence === "string";
	if (!hasSequence) {
		throw new Error("Not an instruct template: no input/output/system sequence found.");
	}

	const stopSequence = str(raw.stop_sequence) ?? "";
	const stopSequences = stopSequence
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	return {
		name: str(raw.name) || "Instruct template",
		format: {
			mode: "manual",
			...(str(raw.input_sequence) !== undefined ? { inputSequence: str(raw.input_sequence) } : {}),
			...(str(raw.output_sequence) !== undefined ? { outputSequence: str(raw.output_sequence) } : {}),
			...(str(raw.first_output_sequence) !== undefined ? { firstOutputSequence: str(raw.first_output_sequence) } : {}),
			...(str(raw.last_output_sequence) !== undefined ? { lastOutputSequence: str(raw.last_output_sequence) } : {}),
			...(str(raw.system_sequence) !== undefined ? { systemSequence: str(raw.system_sequence) } : {}),
			...(str(raw.system_sequence_prefix) !== undefined ? { systemSequencePrefix: str(raw.system_sequence_prefix) } : {}),
			...(str(raw.system_sequence_suffix) !== undefined ? { systemSequenceSuffix: str(raw.system_sequence_suffix) } : {}),
			...(str(raw.input_suffix) !== undefined ? { inputSuffix: str(raw.input_suffix) } : {}),
			...(str(raw.output_suffix) !== undefined ? { outputSuffix: str(raw.output_suffix) } : {}),
			...(str(raw.system_suffix) !== undefined ? { systemSuffix: str(raw.system_suffix) } : {}),
			...(typeof raw.wrap === "boolean" ? { wrap: raw.wrap } : {}),
			...(typeof raw.names_behavior !== "undefined" ? { namesBehavior: mapNamesBehavior(raw.names_behavior) } : {}),
		},
		stopSequences,
	};
}

// ─── Context story_string → PARTIAL canvas ─────────────────────────────────

/** ST story_string variables that map onto VT built-in canvas slots
 *  (identifier → the ST variable name it consumes). `system` in a context
 *  template is the CHARACTER's system prompt → `charSystemPrompt`. */
const STORY_STRING_VARIABLE_SLOTS: Record<string, string> = {
	system: "charSystemPrompt",
	wiBefore: "worldInfoBefore",
	description: "charDescription",
	personality: "charPersonality",
	scenario: "scenario",
	wiAfter: "worldInfoAfter",
	persona: "personaDescription",
};

export interface ParsedStContext {
	name: string;
	/** Canvas order for the recognized built-in slots, in story_string order.
	 *  `chatHistory` is appended last (ST renders chat after the story string). */
	promptOrder: PromptOrderEntry[];
	/** What could NOT be represented (unmapped variables, literal glue text,
	 *  separators) — import notes for the user, never silent. */
	notes: string[];
}

/**
 * Extract the ORDER of recognized variables from a Handlebars `story_string`.
 *
 * The VT pipeline is layer-based, so only the ORDER of the built-in slots is
 * importable — everything else (literal glue text like `{{char}}'s
 * personality: `, `{{#if}}` blocks over unmapped variables, separators) is
 * skipped WITH a note. This is the documented PARTIAL mapping
 * (LOCAL_SUPPORT_PLAN LS-3e storage map).
 */
export function parseStContext(jsonText: string): ParsedStContext {
	const parsed: unknown = JSON.parse(jsonText);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Context template must be a JSON object.");
	}
	const raw = parsed as Record<string, unknown>;
	const storyString = typeof raw.story_string === "string" ? raw.story_string : "";
	if (!storyString) {
		throw new Error("Not a context template: no story_string found.");
	}

	const notes: string[] = [];
	// Walk the {{#if VAR}}...{{/if}} blocks in order; a block over a mapped
	// variable pins that slot's position. Anything recognized but nested under
	// an unmapped condition is still order-relevant in practice — keep the
	// simple flat scan (ST templates are flat if-blocks by convention).
	const variablePattern = /\{\{#if\s+([A-Za-z0-9_]+)\}\}/g;
	const mappedIds: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = variablePattern.exec(storyString)) !== null) {
		const variable = match[1]!;
		const slotId = STORY_STRING_VARIABLE_SLOTS[variable];
		if (slotId) {
			if (!mappedIds.includes(slotId)) mappedIds.push(slotId);
		} else if (!notes.includes(`variable:${variable}`)) {
			notes.push(`variable:${variable}`);
		}
	}

	// Literal glue text (text outside variables/conditionals) — unrepresentable
	// in VT's layer pipeline; report, never silently drop.
	const glue = storyString
		.replace(/\{\{[#/^][^}]*\}\}/g, "")
		.replace(/\{\{[^}]*\}\}/g, "")
		.trim();
	if (glue.length > 0) notes.push("literal_text");

	const promptOrder: PromptOrderEntry[] = mappedIds.map((identifier, index) => ({
		identifier,
		enabled: true,
		order: index,
		kind: "built_in" as const,
		zone: "before_chat" as const,
		depth: null,
	}));
	// Chat history renders after the story string in ST — pin chatHistory last
	// (dense order continuing the mapped slots — orders are dense within a zone).
	const chatHistoryOrder = mappedIds.length;
	promptOrder.push({
		identifier: "chatHistory",
		enabled: true,
		order: chatHistoryOrder,
		kind: "built_in",
		zone: "before_chat",
		depth: null,
	});

	const name = typeof raw.name === "string" && raw.name ? raw.name : "Context template";
	const unmappedNote =
		notes.length > 0
			? `${name}: skipped unrepresentable parts (${notes.join(", ")}) — VT renders these layers itself.`
			: `${name}: all recognized variables mapped to canvas slots.`;

	return { name, promptOrder, notes: [unmappedNote] };
}

// ─── Sysprompt → main system field ──────────────────────────────────────────

export interface ParsedStSysprompt {
	name: string;
	/** The system prompt content — lands in the preset's main system field. */
	content: string;
}

/** Parse an ST sysprompt library entry (`{ name, content }`). */
export function parseStSysprompt(jsonText: string): ParsedStSysprompt {
	const parsed: unknown = JSON.parse(jsonText);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Sysprompt entry must be a JSON object.");
	}
	const raw = parsed as Record<string, unknown>;
	if (typeof raw.content !== "string") {
		throw new Error("Not a sysprompt entry: no content string found.");
	}
	return {
		name: typeof raw.name === "string" && raw.name ? raw.name : "System prompt",
		content: raw.content,
	};
}
