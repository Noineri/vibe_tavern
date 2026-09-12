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
	/** LS-10: which template applies in auto mode (provider-side format
	 *  block): "backend" | "builtin:<id>" | "custom:<id>". Absent on plain
	 *  presets — only the provider format block's auto mode sets it. */
	selection?: FormatTemplateSelection;
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

/**
 * LS-10: WHICH template applies when the format mode is `auto`. Stored on the
 * provider profile (the format block lives in provider settings, owner option
 * A 2026-09-09):
 *
 *  - `"backend"` (or absent) — the backend's own glue: llama-server's Jinja
 *    via `/apply-template`, the documented default template elsewhere, and
 *    the native serializer on KoboldCPP (today's `auto` semantics).
 *  - `"builtin:<id>"` — a VT-curated built-in ({@link BUILTIN_FORMAT_TEMPLATES})
 *    applied without opening the manual editor (owner: the template dropdown
 *    is available already in auto).
 *  - `"custom:<id>"` — a user-saved template from the format-template library
 *    (the LS-5 sampler-set pattern). The ASSEMBLY resolves the id into the
 *    concrete sequences before the handoff (the executors stay store-free).
 */
export type FormatTemplateSelection = string;

/**
 * The provider-side generation format (LOCAL_SUPPORT_PLAN LS-10): the format
 * block's stored shape on a provider profile. Decision (c) fallback semantics
 * live in {@link resolveEffectiveGenerationFormat} — this shape is ONLY what
 * the pane persists.
 */
export interface ProviderGenerationFormat {
	mode: GenerationFormatMode;
	/** Auto-mode template selection (see {@link FormatTemplateSelection}). */
	selection?: FormatTemplateSelection;
	/** Manual-mode sequences (the same shape a preset stores; the inner mode
	 *  is redundant-but-harmless and kept for schema reuse). */
	format?: GenerationFormat;
}

/**
 * VT-curated built-in format templates (LS-10 dropdown, selectable in auto).
 * Sequences VERIFIED against authoritative sources — noted per entry; a wrong
 * builtin silently mangles prompts, so a template without a verified source
 * is deliberately NOT shipped. Mistral note: NO system role in any Mistral
 * instruct version — the system prompt rides unprefixed above the first user
 * turn (ST `system_same_as_user`); V1 differs only in leading spaces, so the
 * current V2/V3 shape ships (the current-generation standard).
 */
export const BUILTIN_FORMAT_TEMPLATES: ReadonlyArray<{
	id: string;
	label: string;
	format: GenerationFormat;
	/** Where the sequences come from — rendered into the UI note + tests. */
	source: string;
}> = [
	{
		id: "chatml",
		label: "ChatML",
		source: "ST instruct/ChatML.json (owner install, 2026-09-09); cross-checked against the live Qwen jinja via llama-server /props",
		format: {
			mode: GENERATION_FORMAT_MODE.manual,
			inputSequence: "<|im_start|>user",
			outputSequence: "<|im_start|>assistant",
			systemSequence: "<|im_start|>system",
			inputSuffix: "<|im_end|>\n",
			outputSuffix: "<|im_end|>\n",
			systemSuffix: "<|im_end|>\n",
			firstOutputSequence: "",
			lastOutputSequence: "",
			systemSequencePrefix: "",
			systemSequenceSuffix: "",
			wrap: true,
			namesBehavior: NAMES_BEHAVIOR.always,
		},
	},
	{
		id: "llama3",
		label: "Llama 3 Instruct",
		source: "ST instruct/Llama 3 Instruct.json (owner install, 2026-09-09)",
		format: {
			mode: GENERATION_FORMAT_MODE.manual,
			inputSequence: "<|start_header_id|>user<|end_header_id|>\n\n",
			outputSequence: "<|start_header_id|>assistant<|end_header_id|>\n\n",
			systemSequence: "<|start_header_id|>system<|end_header_id|>\n\n",
			inputSuffix: "<|eot_id|>",
			outputSuffix: "<|eot_id|>",
			systemSuffix: "<|eot_id|>",
			firstOutputSequence: "",
			lastOutputSequence: "",
			wrap: false,
			namesBehavior: NAMES_BEHAVIOR.always,
		},
	},
	{
		id: "mistral",
		label: "Mistral (V2/V3)",
		source: "ST instruct/Mistral V2 & V3.json (owner's SillyTavern install, 2026-09-09); cross-checked against Mistral's documented format — [INST] … [/INST] … </s>, no system role (the system prompt rides unprefixed above the first user turn)",
		format: {
			mode: GENERATION_FORMAT_MODE.manual,
			inputSequence: "[INST] ",
			outputSequence: "[/INST] ",
			lastOutputSequence: "[/INST]",
			systemSequence: "",
			outputSuffix: "</s>",
			wrap: false,
			namesBehavior: NAMES_BEHAVIOR.always,
		},
	},
];

/** Prefix of a custom-template selection pointing at the format-template library. */
export const CUSTOM_TEMPLATE_SELECTION_PREFIX = "custom:";

/** Parse a selection into its built-in, when it selects one. */
export function builtinFormatTemplateBySelection(selection: string | null | undefined): (typeof BUILTIN_FORMAT_TEMPLATES)[number] | null {
	if (!selection?.startsWith("builtin:")) return null;
	const id = selection.slice("builtin:".length);
	return BUILTIN_FORMAT_TEMPLATES.find((tpl) => tpl.id === id) ?? null;
}

/**
 * LS-10 decision (c) — the effective generation format (supervisor-approved
 * 2026-09-09): the PROFILE's format wins when set (option A ownership — the
 * moment anything is set here it takes over); otherwise the ACTIVE PRESET's
 * format keeps applying (the pre-LS-10 behavior — an imported preset-borne
 * template keeps shaping generations until the user touches the new UI; no
 * silent behavior change). Pure so both the assembly service and tests pin
 * the exact rule.
 */
export function resolveEffectiveGenerationFormat(
	profileFormat: ProviderGenerationFormat | null | undefined,
	presetFormat: GenerationFormat | null | undefined,
): GenerationFormat | null {
	if (profileFormat) {
		if (profileFormat.mode === GENERATION_FORMAT_MODE.manual) {
			return profileFormat.format ?? { mode: GENERATION_FORMAT_MODE.auto };
		}
		// Auto: materialize the selected built-in's sequences onto the format so
		// the handoff builder sees a self-contained object. Backend selection (or
		// absent) carries no sequences — the adapters keep their auto semantics.
		// Custom selections stay UNRESOLVED here (the store lookup lives in
		// PromptAssemblyService, which owns the stores); the service inlines the
		// payload and keeps the selection marker.
		const selection = profileFormat.selection ?? "backend";
		if (selection === "backend") return { mode: GENERATION_FORMAT_MODE.auto };
		const builtin = builtinFormatTemplateBySelection(selection);
		if (builtin) return { ...builtin.format, selection };
		return { mode: GENERATION_FORMAT_MODE.auto, selection };
	}
	return presetFormat ?? null;
}
