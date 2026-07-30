/**
 * Lore AI-delegation (CTX-L2b, Wave 4).
 *
 * The co-author delegates lore-entry content and activation-key generation to
 * the AI-assistant via an ISOLATED one-shot LLM call — IDE-style character
 * authoring. This reuses the SAME system-prompt assets the standalone AI-
 * assistant lore modes use (`lore-entry-ai-prompt.md` / `lore-keys-ai-prompt.md`)
 * and mirrors their user-message format, so delegated generation matches the
 * quality of the assistant's own lorebook writer — only the grounding differs:
 * the co-author grounds on the in-flux character card being authored (its live
 * working profile), not an assistant-mode character binding.
 *
 * Why isolated: the main co-author model is conversational and tool-steered;
 * asking it to also author long-form lore prose or careful activation keys
 * inline bloats its context and dilutes quality. A separate call on a clean
 * prompt (optionally a smaller model — the seam accepts any profile+model pair)
 * produces better, cheaper output, exactly like an IDE firing a focused
 * generator.
 *
 * This module is the ONLY place lore delegation touches the LLM. The tool layer
 * (`coauthor-tools.ts`) receives a `LoreDelegate` callback and stays free of
 * provider/executor imports; the runtime (`session-runtime.ts`) constructs the
 * delegate from the resolved provider profile + model and injects it through
 * the strategy seam. A delegate is optional — when no provider is configured
 * the delegation tools are absent from the set (toolSet-gated) and never run.
 */
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import type { ProviderExecutionInput } from "../../../infrastructure/ai/provider-execution-types.js";
import { loadPromptAsset } from "../../../shared/prompt-asset-loader.js";

/** The executor signature (typeof nonstreamingProviderExecute). */
export type LoreExecutor = (input: ProviderExecutionInput) => Promise<{ text: string }>;

/** A resolved provider profile (the wire shape the executor consumes). */
export type LoreResolvedProfile = ProviderExecutionInput["profile"];

/** Context the tool layer gathers for a delegation call. */
export interface LoreDelegateInput {
	kind: "write_entry" | "generate_keys";
	/** Live working profile.md of the character being authored (may include
	 *  this turn's un-committed profile edits — grounds the delegate on the
	 *  up-to-date character). Empty when no profile context is available. */
	characterProfileMd: string;
	lorebookName: string;
	lorebookDescription: string;
	entryId: string;
	entryTitle: string;
	entryContent: string;
	entryKeys: readonly string[];
	entrySecondaryKeys: readonly string[];
	/** write_entry: the co-author's brief / direction for the prose; also an
	 *  optional additional instruction for generate_keys (mirrors the manual
	 *  lore_keys flow). */
	instruction: string;
	/** generate_keys: which key set to generate (mirrors the manual lore_keys
	 *  `keyTarget`). Unused for write_entry. */
	keyTarget: "primary" | "secondary" | "both";
	/** generate_keys: the entry's activation logic (AND_ANY etc.) — drives the
	 *  logic hint. Draft entries don't track logic (Apply fills the store
	 *  default AND_ANY), so the caller passes "and_any". Unused for write_entry. */
	logic: string;
}

/** The parsed structured result handed back to the tool layer. */
export interface LoreDelegateResult {
	/** Generated prose body (write_entry only). */
	content?: string;
	/** Primary activation keywords (generate_keys only). */
	keys?: string[];
	/** Secondary activation keywords (generate_keys only). */
	secondaryKeys?: string[];
}

/** The callback contract injected into `buildCoauthorTools`. */
export type LoreDelegate = (input: LoreDelegateInput, signal?: AbortSignal) => Promise<LoreDelegateResult>;

export interface CreateLoreDelegateDeps {
	execute: LoreExecutor;
	profile: LoreResolvedProfile;
	model: string;
}

/** The AI-assistant lore system-prompt assets (reused, not reinvented). */
const LORE_ENTRY_ASSET = "lore-entry-ai-prompt.md";
const LORE_KEYS_ASSET = "lore-keys-ai-prompt.md";

/** Token cap for delegation calls — keeps the one-shot cheap and focused. */
const WRITE_ENTRY_MAX_TOKENS = 1024;
const GENERATE_KEYS_MAX_TOKENS = 512;

/** Mirrors `getLogicHint` in ai-assistant-stream.ts — kept inline (not
 *  imported) so co-author/lore stays self-contained (it reuses the assistant's
 *  PROMPT ASSETS, not its code). Update both if the logic guidance changes. */
const AND_ANY_HINT = "(secondary keys provide additional activation signal — generate related terms)";
const LOGIC_HINTS: Record<string, string> = {
	and_any: AND_ANY_HINT,
	and_all: "(ALL secondary keys must match — keep the set small and tightly related)",
	not_any: "(secondary keys PREVENT activation when matched — generate terms indicating the conversation moved away from this topic)",
	not_all: "(secondary keys prevent activation when ALL match — generate unrelated-topic indicators)",
};

/** Build the minimal one-shot AssemblePromptResponse the executor consumes. */
function buildOneShotPrompt(system: string, user: string): AssemblePromptResponse {
	return {
		layers: [],
		tokenAccounting: { total: 0 },
		activatedLoreEntries: [],
		scriptInjections: [],
		retrievedMemories: [],
		finalPayload: {
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		},
	};
}

/**
 * Append a grounding block (character card + lorebook meta) to a reused
 * assistant system prompt. The standalone assistant grounds via its pipeline's
 * character layer; this delegation grounds on the co-author's live working
 * profile, so the grounding is folded into the system message explicitly.
 */
function withGrounding(systemPrompt: string, input: LoreDelegateInput): string {
	const profile = input.characterProfileMd.trim();
	const grounding = [
		"--- Grounding (co-author delegation) ---",
		profile ? `Character card being authored:\n${profile}` : "(no character profile available)",
		`Lorebook: ${input.lorebookName || "(unnamed)"}${input.lorebookDescription.trim() ? ` — ${input.lorebookDescription.trim()}` : ""}`,
	].join("\n");
	return `${systemPrompt}\n\n${grounding}`;
}

/** Mirror `buildUserMessage` (lore_entry) in ai-assistant-stream.ts. */
function buildWriteEntryUserMessage(input: LoreDelegateInput): string {
	const instruction = input.instruction.trim();
	if (input.entryContent.trim()) {
		return `Here is my current lorebook entry content:\n\n${input.entryContent}\n\nModification request:\n${instruction || "(refine it)"}\n\nReturn the complete updated lorebook entry content only. Do not include a title, keys, JSON, markdown, or explanation.`;
	}
	return `${instruction || `Write lorebook entry content for: ${input.entryTitle || "(untitled entry)"}.`}\n\nReturn the lorebook entry content only. Do not include a title, keys, JSON, markdown, or explanation.`;
}

/** Mirror `buildUserMessage` (lore_keys) in ai-assistant-stream.ts — same
 * keyTarget directive, existing-keys dedup, logic hint, and optional
 * additional instruction so delegated generation matches the manual flow's
 * prompt exactly. Keep in sync with that branch. */
function buildGenerateKeysUserMessage(input: LoreDelegateInput): string {
	const parts: string[] = [];
	parts.push(`Generate activation keys for this lorebook entry:\n\n${input.entryContent || "(no content yet)"}`);
	// Per-request target directive — constrains the model to one key set so the
	// output does not contradict the chosen target. The model still returns the
	// full {keys, secondaryKeys} shape (the unused array as []) so parsing stays
	// valid; the merge layer gates on the target too.
	if (input.keyTarget === "primary") {
		parts.push("\nTarget: generate ONLY primary keys. Return secondaryKeys as an empty array.");
	} else if (input.keyTarget === "secondary") {
		parts.push("\nTarget: generate ONLY secondary keys. Return keys as an empty array.");
	}
	if (input.entryKeys.length) {
		parts.push(`\nExisting primary keys (do NOT duplicate): ${JSON.stringify([...input.entryKeys])}`);
	}
	if (input.entrySecondaryKeys.length) {
		parts.push(`Existing secondary keys (do NOT duplicate): ${JSON.stringify([...input.entrySecondaryKeys])}`);
	}
	const logicKey = input.logic.toLowerCase();
	parts.push(`\nLogic mode: ${logicKey}`);
	parts.push(LOGIC_HINTS[logicKey] ?? AND_ANY_HINT);
	if (input.instruction.trim()) {
		parts.push(`\nAdditional instruction: ${input.instruction}`);
	}
	return parts.join("\n");
}

/**
 * Parse a generate_keys JSON response `{keys, secondaryKeys}`. Tolerates
 * surrounding markdown fences and trailing prose by extracting the outermost
 * `{...}` block. Throws on a non-JSON or empty result.
 */
export function parseLoreKeysJson(raw: string): { keys: string[]; secondaryKeys: string[] } {
	const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("ai_generate_lore_keys: the assistant did not return a JSON object");
	}
	let obj: unknown;
	try {
		obj = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		throw new Error("ai_generate_lore_keys: the assistant returned malformed JSON");
	}
	const asStrings = (v: unknown): string[] =>
		Array.isArray(v) ? v.map((x) => String(x).trim()).filter((s) => s.length > 0) : [];
	if (!obj || typeof obj !== "object") {
		throw new Error("ai_generate_lore_keys: the assistant returned a non-object JSON");
	}
	const o = obj as { keys?: unknown; secondaryKeys?: unknown };
	const keys = asStrings(o.keys);
	const secondaryKeys = asStrings(o.secondaryKeys);
	if (keys.length === 0 && secondaryKeys.length === 0) {
		throw new Error("ai_generate_lore_keys: the assistant returned no keys");
	}
	return { keys, secondaryKeys };
}

/**
 * Construct a `LoreDelegate` bound to a resolved provider profile + model. The
 * delegate loads the reused assistant system prompt on first use (cached by
 * `loadPromptAsset`), appends a grounding block, fires one non-streaming call,
 * and parses the result into a structured `LoreDelegateResult`.
 */
export function createLoreDelegate(deps: CreateLoreDelegateDeps): LoreDelegate {
	const { execute, profile, model } = deps;
	return async (input, signal): Promise<LoreDelegateResult> => {
		if (input.kind === "write_entry") {
			const systemPrompt = withGrounding(await loadPromptAsset(LORE_ENTRY_ASSET), input);
			const userMessage = buildWriteEntryUserMessage(input);
			const prompt = buildOneShotPrompt(systemPrompt, userMessage);
			const res = await execute({ profile, model, prompt, signal, overrideMaxTokens: WRITE_ENTRY_MAX_TOKENS });
			const content = res.text.trim();
			if (!content) throw new Error("ai_write_lore_entry: the assistant returned empty content");
			return { content };
		}
		// generate_keys
		const systemPrompt = withGrounding(await loadPromptAsset(LORE_KEYS_ASSET), input);
		const userMessage = buildGenerateKeysUserMessage(input);
		const prompt = buildOneShotPrompt(systemPrompt, userMessage);
		const res = await execute({ profile, model, prompt, signal, overrideMaxTokens: GENERATE_KEYS_MAX_TOKENS });
		const parsed = parseLoreKeysJson(res.text);
		return { keys: parsed.keys, secondaryKeys: parsed.secondaryKeys };
	};
}
