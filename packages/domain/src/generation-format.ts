/**
 * @module generation-format
 *
 * The prompt preset's generation format (LOCAL_SUPPORT_PLAN LS-3a): how the
 * assembled prompt layers are GLUED into one flat string when a provider
 * profile runs in text-completion (TC) mode.
 *
 * Owner decision 2026-09-09: the preset keeps owning WHAT goes into the prompt
 * (its layers); the generation format owns only the final STRING SHAPE
 * (role prefixes/suffixes etc.). In chat mode the shape comes from the
 * backend's chat endpoint; in TC mode it comes from the backend's chat
 * template (auto) or from the manual sequences below. Absent field = auto
 * (backward-compatible with every preset that predates LS-3).
 *
 * The manual shape mirrors SillyTavern's instruct templates near 1:1
 * (storage map, LOCAL_SUPPORT_PLAN 2026-09-09) so `instruct/*.json` imports
 * land without field-by-field translation. SillyTavern names keep their
 * meaning; camelCase per VT conventions. Note `stop_sequence` is deliberately
 * NOT part of this shape — imported stops land in the EXISTING provider
 * stop-sequences setting (owner correction 2026-09-09, no duplicate control).
 */

/** Format mode. `auto` = backend decides the glue (see LS-3c); `manual` = the
 *  sequences below are rendered by the serialization seam. */
export const GENERATION_FORMAT_MODE = {
	auto: "auto",
	manual: "manual",
} as const;

export type GenerationFormatMode = (typeof GENERATION_FORMAT_MODE)[keyof typeof GENERATION_FORMAT_MODE];

/** Speaker-name behavior (ST `names_behavior` near 1:1). VT's serialization
 *  seam has no per-message name channel, so `force`/`always` currently render
 *  like `never` (no names) — the field is stored/imported for round-trip
 *  fidelity and future use. */
export const NAMES_BEHAVIOR = {
	force: "force",
	always: "always",
	never: "never",
} as const;

export type NamesBehavior = (typeof NAMES_BEHAVIOR)[keyof typeof NAMES_BEHAVIOR];

/**
 * The generation-format object stored inside a prompt preset.
 *
 * When `mode` is `"manual"`, the sequence fields mirror the ST instruct DSL;
 * every string field is OPTIONAL and an absent/empty field renders as "".
 * When `mode` is `"auto"` (or the whole object is absent) the manual fields
 * are ignored.
 */
export interface GenerationFormat {
	mode: GenerationFormatMode;
	/** Prefix for user messages (ST `input_sequence`, e.g. `<|im_start|>user`). */
	inputSequence?: string;
	/** Prefix for assistant messages (ST `output_sequence`). */
	outputSequence?: string;
	/** Prefix override for the FIRST assistant message (ST `first_output_sequence`). */
	firstOutputSequence?: string;
	/** Prefix override for the LAST assistant message (ST `last_output_sequence`). */
	lastOutputSequence?: string;
	/** Prefix for system messages (ST `system_sequence`). */
	systemSequence?: string;
	/** Extra prefix wrapped around the system message line (ST `system_sequence_prefix`). */
	systemSequencePrefix?: string;
	/** Extra suffix wrapped around the system message line (ST `system_sequence_suffix`). */
	systemSequenceSuffix?: string;
	/** Suffix appended after user message content (ST `input_suffix`). */
	inputSuffix?: string;
	/** Suffix appended after assistant message content (ST `output_suffix`). */
	outputSuffix?: string;
	/** Suffix appended after system message content (ST `system_suffix`). */
	systemSuffix?: string;
	/** ST `wrap`: separate sequence and content with "\n" and default a missing
	 *  message suffix to "\n". */
	wrap?: boolean;
	/** ST `names_behavior` near 1:1 (see {@link NAMES_BEHAVIOR} for the current
	 *  rendering semantics). */
	namesBehavior?: NamesBehavior;
}
